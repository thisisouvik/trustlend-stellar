#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Vec, BytesN};

// ─── Types ────────────────────────────────────────────────────────────────────

/// Default enforcement phases aligned to the spec.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
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
    MultiSigAdmin,
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
                (symbol_short!("defmgmt"), symbol_short!("paused")),
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
                (symbol_short!("defmgmt"), symbol_short!("unpaused")),
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

    /// One-time bootstrap linking the MultiSigAdmin contract (admin only).
    /// Once set, `add_to_insurance` / `trigger_insurance_payout` — moving the
    /// insurance fund's balance — can ONLY be called by this address.
    pub fn set_multisig_admin(env: Env, admin: Address, multisig: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if env.storage().instance().has(&DataKey::MultiSigAdmin) {
            panic!("Multisig admin already configured");
        }
        env.storage().instance().set(&DataKey::MultiSigAdmin, &multisig);
        let mut msig_admins = Vec::new(&env);
        msig_admins.push_back(multisig);
        Self::reset_signer_rounds(&env);
        env.storage().instance().set(&DataKey::MultisigAdmins, &msig_admins);
    }

    pub fn get_multisig_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::MultiSigAdmin)
            .expect("Multisig admin not configured")
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
        Self::assert_not_paused(&env);

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

    /// Increase the insurance fund (from platform fee income). Multisig-gated
    /// — "handling protocol fees" is exactly the kind of rare, high-impact
    /// fund movement this contract protects with N-of-M approval.
    pub fn add_to_insurance(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        let current = Self::get_insurance_balance(env.clone());
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceBalance, &(current + amount));
    }

    /// Trigger an insurance payout ("withdrawing protocol fees") to a lender
    /// for a defaulted loan. Multisig-gated. Actual XLM moves via a PAYMENT
    /// operation by the admin wallet; this function records the event and
    /// deducts from the fund balance.
    pub fn trigger_insurance_payout(
        env: Env,
        caller: Address,
        loan_id: u32,
        lender: Address,
        amount: i128,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::assert_not_paused(&env);

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
}

#[cfg(test)]
mod test;
