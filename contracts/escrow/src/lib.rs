#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, Env, Vec, BytesN};

// ─── Types ────────────────────────────────────────────────────────────────────

/// Escrow hold status.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum EscrowStatus {
    Held,
    Transferred,
    Revoked,
}

/// A single escrow commitment.
/// The held tokens are custodied by this contract until the hold is revoked
/// (refund to the lender) or disbursed (payout to the borrower).
#[contracttype]
#[derive(Clone)]
pub struct EscrowHold {
    pub id: u32,
    pub loan_id: u32,
    pub lender: Address,
    pub borrower: Address,
    /// Token contract (e.g. native XLM or USDC) custodied for this hold
    pub token: Address,
    /// Amount in stroops
    pub amount: i128,
    /// Ledger timestamp when hold was created
    pub held_at: u64,
    /// held_at + 180 — the revocation window boundary
    pub expires_at: u64,
    pub status: EscrowStatus,
}

/// Ledger storage keys.
#[contracttype]
pub enum DataKey {
    Hold(u32),
    EscrowCount,
    Admin,
    MultisigAdmins,
    MultisigThreshold,
    IsPaused,
    PauseSigner(Address),
    PauseSignerCount,
    UnpauseSigner(Address),
    UnpauseSignerCount,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::EscrowCount, &0u32);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Configure multi-sig admin set for pause/unpause.
    pub fn setup_multisig(env: Env, admin: Address, admins: Vec<Address>, threshold: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if threshold == 0 {
            panic!("Threshold must be at least 1");
        }
        if threshold > admins.len() {
            panic!("Threshold exceeds number of admins");
        }

        let mut final_admins = admins;
        if !final_admins.iter().any(|a| a == admin) {
            final_admins.push_back(admin);
        }

        env.storage().instance().set(&DataKey::MultisigThreshold, &threshold);
        env.storage().instance().set(&DataKey::MultisigAdmins, &final_admins);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage().instance().set(&DataKey::PauseSignerCount, &0u32);
        env.storage().instance().set(&DataKey::UnpauseSignerCount, &0u32);
    }

    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            panic!("Contract is already paused");
        }

        let signer_key = DataKey::PauseSigner(caller.clone());
        if env.storage().instance().has(&signer_key) {
            panic!("Signer has already authorised pause");
        }
        env.storage().instance().set(&signer_key, &true);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PauseSignerCount)
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::PauseSignerCount, &new_count);

        let threshold: u32 = Self::get_multisig_threshold(env.clone());
        if new_count >= threshold {
            env.storage().instance().set(&DataKey::IsPaused, &true);
            env.storage().instance().set(&DataKey::PauseSignerCount, &0u32);
            env.events().publish(
                (symbol_short!("escrow"), symbol_short!("paused")),
                (),
            );
        }
    }

    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if !is_paused {
            panic!("Contract is not paused");
        }

        let signer_key = DataKey::UnpauseSigner(caller.clone());
        if env.storage().instance().has(&signer_key) {
            panic!("Signer has already authorised unpause");
        }
        env.storage().instance().set(&signer_key, &true);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UnpauseSignerCount)
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::UnpauseSignerCount, &new_count);

        let threshold: u32 = Self::get_multisig_threshold(env.clone());
        if new_count >= threshold {
            env.storage().instance().set(&DataKey::IsPaused, &false);
            env.storage().instance().set(&DataKey::UnpauseSignerCount, &0u32);
            env.events().publish(
                (symbol_short!("escrow"), symbol_short!("unpaused")),
                (),
            );
        }
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    pub fn get_multisig_admins(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_multisig_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MultisigThreshold)
            .unwrap_or(1)
    }

    pub fn get_pause_signer_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PauseSignerCount)
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    // ── Holds ─────────────────────────────────────────────────────────────────

    /// Lock `amount` of `token` from the lender in this contract and register
    /// the escrow commitment. Returns the new escrow `id`.
    pub fn create_hold(
        env: Env,
        lender: Address,
        borrower: Address,
        token: Address,
        loan_id: u32,
        amount: i128,
    ) -> u32 {
        lender.require_auth();
        Self::assert_not_paused(&env);

        if amount <= 0 {
            panic!("Amount must be positive");
        }

        // Take custody of the funds before recording the hold.
        token::Client::new(&env, &token).transfer(
            &lender,
            &env.current_contract_address(),
            &amount,
        );

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);
        let new_id = count + 1;

        let now = env.ledger().timestamp();
        let hold = EscrowHold {
            id: new_id,
            loan_id,
            lender: lender.clone(),
            borrower,
            token,
            amount,
            held_at: now,
            expires_at: now + 180, // 3-minute revocation window
            status: EscrowStatus::Held,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Hold(new_id), &hold);
        env.storage()
            .instance()
            .set(&DataKey::EscrowCount, &new_id);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("deposit")),
            (lender, loan_id, amount),
        );

        new_id
    }

    /// Returns true if the 3-minute revocation window is still open.
    pub fn is_within_revocation_window(env: Env, escrow_id: u32) -> bool {
        let now = env.ledger().timestamp();
        let hold = Self::load_hold(&env, escrow_id);
        now < hold.expires_at
    }

    /// Lender revokes before the 3-minute window closes.
    /// The held tokens are refunded to the lender from the contract's custody.
    pub fn revoke_hold(env: Env, lender: Address, escrow_id: u32) {
        lender.require_auth();

        let now = env.ledger().timestamp();
        let mut hold = Self::load_hold(&env, escrow_id);

        if hold.lender != lender {
            panic!("Only the lender can revoke");
        }
        if hold.status != EscrowStatus::Held {
            panic!("Hold is not in HELD state");
        }
        if now >= hold.expires_at {
            panic!("Revocation window has expired");
        }

        hold.status = EscrowStatus::Revoked;
        env.storage()
            .persistent()
            .set(&DataKey::Hold(escrow_id), &hold);

        token::Client::new(&env, &hold.token).transfer(
            &env.current_contract_address(),
            &hold.lender,
            &hold.amount,
        );

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("withdraw")),
            (lender, hold.loan_id, hold.amount),
        );
    }

    /// Release the held tokens to the borrower once the revocation window has
    /// closed (called by admin/backend).
    pub fn confirm_disbursement(env: Env, caller: Address, escrow_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::assert_not_paused(&env);

        let now = env.ledger().timestamp();
        let mut hold = Self::load_hold(&env, escrow_id);

        if hold.status != EscrowStatus::Held {
            panic!("Hold is not in HELD state");
        }
        if now < hold.expires_at {
            panic!("Revocation window has not expired yet");
        }

        hold.status = EscrowStatus::Transferred;
        env.storage()
            .persistent()
            .set(&DataKey::Hold(escrow_id), &hold);

        token::Client::new(&env, &hold.token).transfer(
            &env.current_contract_address(),
            &hold.borrower,
            &hold.amount,
        );

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("transfer")),
            (escrow_id, hold.loan_id, hold.borrower, hold.amount),
        );
    }

    /// Get escrow hold details.
    pub fn get_hold(env: Env, escrow_id: u32) -> EscrowHold {
        env.storage()
            .persistent()
            .get(&DataKey::Hold(escrow_id))
            .expect("Escrow hold not found")
    }

    pub fn get_escrow_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0)
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    fn assert_admin(env: &Env, caller: &Address) {
        let multisig_admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(env));
        if !multisig_admins.is_empty() && multisig_admins.iter().any(|a| a == *caller) {
            return;
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised");
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }

    fn assert_multisig_admin(env: &Env, caller: &Address) {
        let multisig_admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(env));
        if multisig_admins.is_empty() {
            panic!("Multisig not configured");
        }
        if !multisig_admins.iter().any(|a| a == *caller) {
            panic!("Unauthorised: caller is not a multisig admin");
        }
    }

    fn assert_not_paused(env: &Env) {
        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            panic!("Contract is paused");
        }
    }

    fn load_hold(env: &Env, escrow_id: u32) -> EscrowHold {
        env.storage()
            .persistent()
            .get(&DataKey::Hold(escrow_id))
            .expect("Escrow hold not found")
    }
}

#[cfg(test)]
mod test;
