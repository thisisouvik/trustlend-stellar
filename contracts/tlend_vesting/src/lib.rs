#![no_std]
//! TLEND Vesting & Distribution
//!
//! Escrows TLEND for early lenders, early borrowers, and the team behind a
//! cliff + linear-release schedule, and lets each beneficiary claim whatever
//! has vested so far. The admin funds a schedule at creation time (tokens
//! move from the admin into this contract immediately), so a beneficiary's
//! claim is always backed by an on-hand balance.
//!
//! Release model: nothing unlocks before `start_time + cliff_secs`. At the
//! cliff, `total_amount * cliff_secs / duration_secs` is already unlocked (a
//! lump-sum "cliff release"), and the remainder continues to unlock linearly
//! until `start_time + duration_secs`, at which point the full amount is
//! vested. Schedules marked `revocable` let the admin claw back whatever has
//! not yet vested (e.g. a team member who leaves early); anything already
//! vested remains claimable by the beneficiary.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env};

#[cfg(test)]
mod test;

// ─── Types & Storage ─────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeneficiaryCategory {
    EarlyLender,
    EarlyBorrower,
    Team,
}

/// Timing/terms for a new schedule, bundled into one struct purely to keep
/// `create_vesting_schedule`'s argument count small.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingTerms {
    pub start_time: u64,
    pub cliff_secs: u64,
    pub duration_secs: u64,
    pub revocable: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub beneficiary: Address,
    pub category: BeneficiaryCategory,
    pub total_amount: i128,
    pub start_time: u64,
    pub cliff_secs: u64,
    pub duration_secs: u64,
    pub claimed_amount: i128,
    pub revocable: bool,
    /// Set once `revoke` is called: the vested amount is frozen at this
    /// value and no further vesting accrues.
    pub frozen_vested: Option<i128>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    Schedule(Address),
}

// ─── TlendVestingContract ────────────────────────────────────────────────────

#[contract]
pub struct TlendVestingContract;

#[contractimpl]
impl TlendVestingContract {
    /// Soroban constructor: runs atomically as part of `stellar contract deploy`
    /// (`-- <constructor args>`), so the contract is never live in an
    /// uninitialised state that a third party could front-run to claim
    /// admin rights (issue #352). There is no public `initialize`.
    pub fn __constructor(env: Env, admin: Address, token: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("Unauthorised caller");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Create a vesting schedule for `beneficiary`, pulling `total_amount`
    /// TLEND from `admin` into this contract to back future claims.
    pub fn create_vesting_schedule(
        env: Env,
        admin: Address,
        beneficiary: Address,
        category: BeneficiaryCategory,
        total_amount: i128,
        terms: VestingTerms,
    ) {
        admin.require_auth();
        let stored_admin = Self::get_admin(env.clone());
        if admin != stored_admin {
            panic!("Unauthorised caller: not admin");
        }
        if env.storage().persistent().has(&DataKey::Schedule(beneficiary.clone())) {
            panic!("Beneficiary already has a vesting schedule");
        }
        if total_amount <= 0 {
            panic!("total_amount must be positive");
        }
        if terms.duration_secs == 0 {
            panic!("duration_secs must be positive");
        }
        if terms.cliff_secs > terms.duration_secs {
            panic!("cliff_secs cannot exceed duration_secs");
        }

        let token_addr = Self::get_token(env.clone());
        token::Client::new(&env, &token_addr).transfer(
            &admin,
            &env.current_contract_address(),
            &total_amount,
        );

        let schedule = VestingSchedule {
            beneficiary: beneficiary.clone(),
            category,
            total_amount,
            start_time: terms.start_time,
            cliff_secs: terms.cliff_secs,
            duration_secs: terms.duration_secs,
            claimed_amount: 0,
            revocable: terms.revocable,
            frozen_vested: None,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(beneficiary.clone()), &schedule);

        env.events().publish(
            (symbol_short!("vesting"), symbol_short!("create")),
            (beneficiary, total_amount, terms.start_time, terms.duration_secs),
        );
    }

    /// Claim whatever has vested and not yet been claimed.
    pub fn claim(env: Env, beneficiary: Address) -> i128 {
        beneficiary.require_auth();

        let mut schedule = Self::get_vesting_schedule(env.clone(), beneficiary.clone());
        let vested = Self::calc_vested(&env, &schedule);
        let claimable = vested - schedule.claimed_amount;
        if claimable <= 0 {
            panic!("Nothing to claim");
        }

        schedule.claimed_amount += claimable;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(beneficiary.clone()), &schedule);

        let token_addr = Self::get_token(env.clone());
        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &beneficiary,
            &claimable,
        );

        env.events().publish(
            (symbol_short!("vesting"), symbol_short!("claim")),
            (beneficiary, claimable),
        );
        claimable
    }

    /// Admin claws back whatever has not yet vested from a revocable
    /// schedule. Already-vested tokens remain claimable by the beneficiary.
    pub fn revoke(env: Env, admin: Address, beneficiary: Address) -> i128 {
        admin.require_auth();
        let stored_admin = Self::get_admin(env.clone());
        if admin != stored_admin {
            panic!("Unauthorised caller: not admin");
        }

        let mut schedule = Self::get_vesting_schedule(env.clone(), beneficiary.clone());
        if !schedule.revocable {
            panic!("Schedule is not revocable");
        }
        if schedule.frozen_vested.is_some() {
            panic!("Schedule already revoked");
        }

        let vested = Self::calc_vested(&env, &schedule);
        let unvested = schedule.total_amount - vested;
        schedule.frozen_vested = Some(vested);
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(beneficiary.clone()), &schedule);

        if unvested > 0 {
            let token_addr = Self::get_token(env.clone());
            token::Client::new(&env, &token_addr).transfer(
                &env.current_contract_address(),
                &admin,
                &unvested,
            );
        }

        env.events().publish(
            (symbol_short!("vesting"), symbol_short!("revoke")),
            (beneficiary, unvested),
        );
        unvested
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("Vesting contract not initialised")
    }

    pub fn get_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token).expect("Vesting contract not initialised")
    }

    pub fn get_vesting_schedule(env: Env, beneficiary: Address) -> VestingSchedule {
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(beneficiary))
            .expect("No vesting schedule for beneficiary")
    }

    pub fn has_schedule(env: Env, beneficiary: Address) -> bool {
        env.storage().persistent().has(&DataKey::Schedule(beneficiary))
    }

    /// Total amount vested so far (claimed + unclaimed).
    pub fn vested_amount(env: Env, beneficiary: Address) -> i128 {
        let schedule = Self::get_vesting_schedule(env.clone(), beneficiary);
        Self::calc_vested(&env, &schedule)
    }

    /// Vested but not yet claimed.
    pub fn claimable_amount(env: Env, beneficiary: Address) -> i128 {
        let schedule = Self::get_vesting_schedule(env.clone(), beneficiary);
        Self::calc_vested(&env, &schedule) - schedule.claimed_amount
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fn calc_vested(env: &Env, schedule: &VestingSchedule) -> i128 {
        if let Some(frozen) = schedule.frozen_vested {
            return frozen;
        }

        let now = env.ledger().timestamp();
        if now < schedule.start_time + schedule.cliff_secs {
            return 0;
        }
        if now >= schedule.start_time + schedule.duration_secs {
            return schedule.total_amount;
        }

        let elapsed = now - schedule.start_time;
        (schedule.total_amount * (elapsed as i128)) / (schedule.duration_secs as i128)
    }
}
