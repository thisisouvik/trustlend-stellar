#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

// ─── Types ────────────────────────────────────────────────────────────────────

/// Default enforcement phases aligned to the spec.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DefaultPhase {
    /// Days 1-7 — friendly reminders, no penalty yet
    Friendly,
    /// Days 8-21 — reputation hit, blacklisted from new loans
    Warning,
    /// Days 22-60 — wallet frozen, platform enforcement
    Enforcement,
    /// 60+ days — reported; insurance/collection triggered
    Reported,
}

/// A default record for a specific loan.
#[contracttype]
#[derive(Clone)]
pub struct DefaultRecord {
    pub loan_id: u32,
    pub borrower: Address,
    /// Principal amount in stroops
    pub amount: i128,
    /// Ledger timestamp when this record was created
    pub recorded_at: u64,
    pub days_overdue: u64,
    pub phase: DefaultPhase,
}

/// Insurance fund event.
#[contracttype]
#[derive(Clone)]
pub struct InsuranceEvent {
    pub loan_id: u32,
    pub lender: Address,
    pub amount_paid: i128,
    pub paid_at: u64,
}

/// Ledger storage keys.
#[contracttype]
pub enum DataKey {
    DefaultRecord(u32),
    InsuranceBalance,
    InsuranceEvent(u32),
    InsuranceEventCount,
    Admin,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct DefaultManagementContract;

#[contractimpl]
impl DefaultManagementContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address, initial_insurance_balance: i128) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceBalance, &initial_insurance_balance);
        env.storage()
            .instance()
            .set(&DataKey::InsuranceEventCount, &0u32);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    // ── Default management ────────────────────────────────────────────────────

    /// Called by admin/backend (daily cron) after checking Horizon for overdue
    /// loans. `days_overdue` is calculated off-chain and passed in.
    ///
    /// Returns the current DefaultPhase so the caller can trigger further
    /// actions (freeze wallet via ReputationContract, etc.).
    pub fn record_default(
        env: Env,
        caller: Address,
        loan_id: u32,
        borrower: Address,
        amount: i128,
        days_overdue: u64,
    ) -> DefaultPhase {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let phase = Self::days_to_phase(days_overdue);

        let record = DefaultRecord {
            loan_id,
            borrower,
            amount,
            recorded_at: env.ledger().timestamp(),
            days_overdue,
            phase: phase.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::DefaultRecord(loan_id), &record);

        phase
    }

    pub fn get_default_record(env: Env, loan_id: u32) -> DefaultRecord {
        env.storage()
            .persistent()
            .get(&DataKey::DefaultRecord(loan_id))
            .expect("Default record not found")
    }

    // ── Insurance fund ────────────────────────────────────────────────────────

    /// Get current insurance fund balance (in stroops).
    pub fn get_insurance_balance(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::InsuranceBalance)
            .unwrap_or(0)
    }

    /// Increase the insurance fund (from platform fee income).
    pub fn add_to_insurance(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let current = Self::get_insurance_balance(env.clone());
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceBalance, &(current + amount));
    }

    /// Trigger an insurance payout to a lender for a defaulted loan.
    /// Actual XLM moves via a PAYMENT operation by the admin wallet; this
    /// function records the event and deducts from the fund balance.
    pub fn trigger_insurance_payout(
        env: Env,
        caller: Address,
        loan_id: u32,
        lender: Address,
        amount: i128,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let balance = Self::get_insurance_balance(env.clone());
        if balance < amount {
            panic!("Insufficient insurance funds");
        }

        // Deduct from fund
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceBalance, &(balance - amount));

        // Record the event
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::InsuranceEventCount)
            .unwrap_or(0);
        let new_count = count + 1;
        let event = InsuranceEvent {
            loan_id,
            lender,
            amount_paid: amount,
            paid_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceEvent(new_count), &event);
        env.storage()
            .instance()
            .set(&DataKey::InsuranceEventCount, &new_count);
    }

    pub fn get_insurance_event(env: Env, event_index: u32) -> InsuranceEvent {
        env.storage()
            .persistent()
            .get(&DataKey::InsuranceEvent(event_index))
            .expect("Insurance event not found")
    }

    pub fn get_insurance_event_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::InsuranceEventCount)
            .unwrap_or(0)
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    fn days_to_phase(days: u64) -> DefaultPhase {
        match days {
            1..=7 => DefaultPhase::Friendly,
            8..=21 => DefaultPhase::Warning,
            22..=60 => DefaultPhase::Enforcement,
            _ => DefaultPhase::Reported,
        }
    }

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
