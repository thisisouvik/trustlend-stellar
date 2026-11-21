#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, Vec,
};

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
///
/// The contract takes custody of `amount` of `token` from the lender when the
/// hold is created and releases it on-chain: back to the lender on
/// revocation, or to the borrower on disbursement (Issue #417).
#[contracttype]
#[derive(Clone)]
pub struct EscrowHold {
    pub id: u32,
    pub loan_id: u32,
    pub lender: Address,
    pub borrower: Address,
    /// SEP-41 token held in custody (e.g. the native XLM or USDC contract).
    pub token: Address,
    /// Amount in the token's smallest unit (stroops for XLM)
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
    /// Whether a signer has authorised pause in a given round (dedup)
    PauseSigner(Address, u32),
    PauseSignerCount,
    /// Whether a signer has authorised unpause in a given round (dedup)
    UnpauseSigner(Address, u32),
    UnpauseSignerCount,
    /// Current pause approval round; advances each time a pause completes
    PauseRound,
    /// Current unpause approval round; advances each time an unpause completes
    UnpauseRound,
    /// Whether a token may be escrowed (admin-managed allowlist).
    AllowedToken(Address),
    /// Total amount of a token currently held across all `Held` escrows.
    /// The contract's balance of that token must never fall below it.
    TotalHeld(Address),
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Soroban constructor: runs atomically as part of `stellar contract deploy`
    /// (`-- <constructor args>`), so the contract is never live in an
    /// uninitialised state that a third party could front-run to claim
    /// admin rights (issue #352). There is no public `initialize`.
    pub fn __constructor(env: Env, admin: Address) {
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
        Self::reset_signer_rounds(&env);
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

        let round = Self::signer_round(&env, &DataKey::PauseRound);
        let signer_key = DataKey::PauseSigner(caller.clone(), round);
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
            // Clear this round's approvals so the same signers can act again
            // in the next cycle (issue #354).
            Self::close_signer_round(&env, true);
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

        let round = Self::signer_round(&env, &DataKey::UnpauseRound);
        let signer_key = DataKey::UnpauseSigner(caller.clone(), round);
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
            // Clear this round's approvals so the same signers can act again
            // in the next cycle (issue #354).
            Self::close_signer_round(&env, false);
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

    // ── Token allowlist ───────────────────────────────────────────────────────

    /// Allow or disallow a token for new escrow holds (admin only).
    /// Only allowlisted tokens (e.g. native XLM, USDC) can be escrowed, so a
    /// hold can never be backed by an arbitrary, worthless token.
    /// Disallowing a token does not affect holds that already exist.
    pub fn set_allowed_token(env: Env, caller: Address, token: Address, allowed: bool) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if allowed {
            env.storage()
                .instance()
                .set(&DataKey::AllowedToken(token.clone()), &true);
        } else {
            env.storage()
                .instance()
                .remove(&DataKey::AllowedToken(token.clone()));
        }

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("token")),
            (token, allowed),
        );
    }

    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::AllowedToken(token))
    }

    /// Total amount of `token` currently held in custody across all holds
    /// in the `Held` state.
    pub fn get_total_held(env: Env, token: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalHeld(token))
            .unwrap_or(0)
    }

    // ── Holds ─────────────────────────────────────────────────────────────────

    /// Create an escrow hold, taking custody of the lender's funds.
    ///
    /// `amount` of `token` is transferred from the lender into this contract
    /// (Issue #417); the call fails if the token is not allowlisted or the
    /// lender cannot cover the transfer. Returns the new escrow `id`.
    pub fn create_hold(
        env: Env,
        lender: Address,
        borrower: Address,
        loan_id: u32,
        token: Address,
        amount: i128,
    ) -> u32 {
        lender.require_auth();
        Self::assert_not_paused(&env);

        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if !Self::is_token_allowed(env.clone(), token.clone()) {
            panic!("Token is not allowed for escrow");
        }

        // Take custody before recording anything.
        token::Client::new(&env, &token).transfer(
            &lender,
            &env.current_contract_address(),
            &amount,
        );
        Self::add_total_held(&env, &token, amount);

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

    /// Lender revokes before the 3-minute window closes. The held tokens are
    /// returned from custody to the lender in the same call (Issue #417).
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
        Self::sub_total_held(&env, &hold.token, hold.amount);

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

    /// Release the held tokens to the borrower once the revocation window
    /// has closed (called by admin/backend when the loan activates). The
    /// transfer happens in the same call (Issue #417).
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
        Self::sub_total_held(&env, &hold.token, hold.amount);

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

    // ── Pause / unpause signer rounds (issue #354) ───────────────────────────

    /// Current approval round for pause (`PauseRound`) or unpause
    /// (`UnpauseRound`). Signer approvals are keyed by round, so approvals
    /// from a completed cycle can never block the same signers in a later one.
    fn signer_round(env: &Env, round_key: &DataKey) -> u32 {
        env.storage().instance().get(round_key).unwrap_or(0)
    }

    /// Close the current pause (`pause == true`) or unpause round: delete its
    /// per-signer approvals for the current signer set, reset the counter and
    /// advance to a fresh round. Deleting the entries keeps instance storage
    /// from growing with every cycle; advancing the round guarantees a clean
    /// slate even for approvals of signers no longer in the set.
    fn close_signer_round(env: &Env, pause: bool) {
        let (round_key, count_key) = if pause {
            (DataKey::PauseRound, DataKey::PauseSignerCount)
        } else {
            (DataKey::UnpauseRound, DataKey::UnpauseSignerCount)
        };
        let round = Self::signer_round(env, &round_key);
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(env));
        for admin in admins.iter() {
            let signer_key = if pause {
                DataKey::PauseSigner(admin, round)
            } else {
                DataKey::UnpauseSigner(admin, round)
            };
            env.storage().instance().remove(&signer_key);
        }
        env.storage().instance().set(&count_key, &0u32);
        env.storage().instance().set(&round_key, &(round + 1));
    }

    /// Start fresh pause and unpause rounds. Called whenever the signer set
    /// changes, so partial approvals from the old set neither linger as
    /// "already authorised" nor count toward the new set's threshold.
    fn reset_signer_rounds(env: &Env) {
        Self::close_signer_round(env, true);
        Self::close_signer_round(env, false);
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

    fn add_total_held(env: &Env, token: &Address, amount: i128) {
        let key = DataKey::TotalHeld(token.clone());
        let total: i128 = env.storage().instance().get(&key).unwrap_or(0);
        let new_total = total
            .checked_add(amount)
            .expect("Overflow adding to total held");
        env.storage().instance().set(&key, &new_total);
    }

    fn sub_total_held(env: &Env, token: &Address, amount: i128) {
        let key = DataKey::TotalHeld(token.clone());
        let total: i128 = env.storage().instance().get(&key).unwrap_or(0);
        let new_total = total
            .checked_sub(amount)
            .expect("Underflow subtracting from total held");
        if new_total < 0 {
            panic!("Total held cannot be negative");
        }
        env.storage().instance().set(&key, &new_total);
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
