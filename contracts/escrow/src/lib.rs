#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

// ─── Types ────────────────────────────────────────────────────────────────────

/// Escrow hold status.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Held,
    Transferred,
    Revoked,
}

/// A single escrow commitment.
/// NOTE: actual XLM movement happens via Stellar PAYMENT operations.
/// This contract records the *intent* and enforces the timing rules.
#[contracttype]
#[derive(Clone)]
pub struct EscrowHold {
    pub id: u32,
    pub loan_id: u32,
    pub lender: Address,
    pub borrower: Address,
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

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    // ── Holds ─────────────────────────────────────────────────────────────────

    /// Register an escrow commitment once the lender has sent the PAYMENT.
    /// Returns the new escrow `id`.
    pub fn create_hold(
        env: Env,
        lender: Address,
        borrower: Address,
        loan_id: u32,
        amount: i128,
    ) -> u32 {
        lender.require_auth();

        if amount <= 0 {
            panic!("Amount must be positive");
        }

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
            lender,
            borrower,
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

        new_id
    }

    /// Returns true if the 3-minute revocation window is still open.
    pub fn is_within_revocation_window(env: Env, escrow_id: u32) -> bool {
        let hold = Self::get_hold(env.clone(), escrow_id);
        env.ledger().timestamp() < hold.expires_at
    }

    /// Lender revokes before the 3-minute window closes.
    /// The *actual* XLM refund must happen via a separate PAYMENT operation
    /// signed by the platform after this call confirms on-chain.
    pub fn revoke_hold(env: Env, lender: Address, escrow_id: u32) {
        lender.require_auth();

        let mut hold = Self::get_hold(env.clone(), escrow_id);

        if hold.lender != lender {
            panic!("Only the lender can revoke");
        }
        if hold.status != EscrowStatus::Held {
            panic!("Hold is not in HELD state");
        }
        if env.ledger().timestamp() >= hold.expires_at {
            panic!("Revocation window has expired");
        }

        hold.status = EscrowStatus::Revoked;
        env.storage()
            .persistent()
            .set(&DataKey::Hold(escrow_id), &hold);
    }

    /// Mark escrow as disbursed once the on-chain payment to the borrower
    /// has been confirmed (called by admin/backend after Horizon verification).
    pub fn confirm_disbursement(env: Env, caller: Address, escrow_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let mut hold = Self::get_hold(env.clone(), escrow_id);

        if hold.status != EscrowStatus::Held {
            panic!("Hold is not in HELD state");
        }
        if env.ledger().timestamp() < hold.expires_at {
            panic!("Revocation window has not expired yet");
        }

        hold.status = EscrowStatus::Transferred;
        env.storage()
            .persistent()
            .set(&DataKey::Hold(escrow_id), &hold);
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
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised");
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }
}
