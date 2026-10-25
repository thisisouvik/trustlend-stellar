//! # USDC Lending Pool — Soroban Smart Contract
//!
//! Accepts USDC deposits from lenders and allows them to withdraw all or part of their
//! principal plus accrued yield at any time.
//!
//! ## Yield Model (Issue #337)
//! Yield is only ever paid out of USDC that was explicitly paid into the pool
//! as yield via [`UsdcLendingPool::fund_yield`] — borrower interest and loan
//! repayments routed by the protocol, treasury top-ups, or any other funder.
//! Depositor principal is never used to pay yield.
//!
//! Funded USDC sits in a *yield reserve* and is streamed to depositors at no
//! more than the configured annual rate:
//! ```text
//! index growth per ledger = annual_yield_bps / 10_000 / LEDGERS_PER_YEAR
//! ```
//! capped so the yield released never exceeds the reserve. Accrual is tracked
//! with a global per-unit index, so when the reserve runs short every
//! depositor's accrual is reduced pro-rata — there is no first-come,
//! first-served race for the reserve. The pool therefore always holds at
//! least `total_principal + yield_unclaimed + yield_reserve`.
//!
//! `LEDGERS_PER_YEAR` assumes a 5-second average ledger close time on Stellar
//! mainnet: 365 * 24 * 60 * 60 / 5 = 6_307_200 ledgers/year.
//!
//! USDC sent to the pool directly (not via `deposit` or `fund_yield`) is not
//! counted as principal or yield.
//!
//! ## Token Interface
//! All USDC movements use the SEP-41 token interface
//! (`soroban_sdk::token::TokenClient`).

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env,
};

// ─── Constants ────────────────────────────────────────────────────────────────

/// Assumed ledger closes per year (5-second average close time).
const LEDGERS_PER_YEAR: u64 = 6_307_200;

/// Basis-points denominator (10 000 bps = 100 %).
const MAX_BPS: u64 = 10_000;

/// Maximum change (in bps) `set_yield_rate` may apply in a single update.
const MAX_YIELD_RATE_CHANGE_BPS: u32 = 500;

/// Fixed-point scale of the yield index (yield per unit of principal).
const INDEX_PRECISION: u128 = 1_000_000_000_000_000_000;

// ─── Storage types ────────────────────────────────────────────────────────────

/// Per-depositor record written to persistent storage.
#[contracttype]
#[derive(Clone)]
pub struct DepositRecord {
    /// Amount of USDC deposited (in the token's smallest unit, i.e. stroops for USDC:XLM or micro-USDC).
    pub principal: i128,
    /// Ledger sequence number of the latest deposit (informational).
    pub deposit_ledger: u32,
    /// `PoolState::yield_index` when the position was last settled. Yield
    /// owed = principal * (current index - yield_index) / INDEX_PRECISION.
    pub yield_index: i128,
}

/// Global pool state.
#[contracttype]
#[derive(Clone)]
pub struct PoolState {
    /// Cumulative USDC deposited across all users (does not decrease on withdraw).
    pub total_deposited: i128,
    /// Cumulative USDC withdrawn (principal + yield) across all users.
    pub total_withdrawn: i128,
    /// Maximum annual yield rate in basis-points (e.g. 500 = 5.00 %). Yield
    /// only accrues at this rate while the yield reserve can fund it.
    pub annual_yield_bps: u32,
    /// Total number of unique depositors (monotonically increasing).
    pub depositor_count: u32,
    /// Principal currently owed to depositors (includes compounded yield).
    pub total_principal: i128,
    /// Funded yield not yet released to depositors.
    pub yield_reserve: i128,
    /// Yield released to depositors but not yet withdrawn or compounded.
    pub yield_unclaimed: i128,
    /// Cumulative yield released per unit of principal, scaled by
    /// `INDEX_PRECISION`.
    pub yield_index: i128,
    /// Ledger up to which yield has been accrued.
    pub last_accrual_ledger: u32,
    /// Cumulative USDC paid in via `fund_yield`.
    pub total_yield_funded: i128,
    /// Cumulative yield paid out to depositors on withdrawal.
    pub total_yield_paid: i128,
}

/// Ledger storage keys.
#[contracttype]
pub enum DataKey {
    /// Contract administrator.
    Admin,
    /// Address of the USDC token contract (SEP-41).
    UsdcToken,
    /// Global pool state.
    Pool,
    /// Per-depositor record: `Deposit(depositor_address)`.
    Deposit(Address),
    /// Whether the pool is paused for deposits/withdrawals.
    IsPaused,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct UsdcLendingPool;

#[contractimpl]
impl UsdcLendingPool {
    // ── Initialization ────────────────────────────────────────────────────────

    /// One-time setup. Must be called before any other function.
    ///
    /// # Arguments
    /// * `admin`           – Address authorised to pause/unpause and set the rate.
    /// * `usdc_token`      – SEP-41 USDC token contract address.
    /// * `annual_yield_bps`– Maximum annual yield in basis-points (e.g. 500 = 5.00 %).
    pub fn initialize(env: Env, admin: Address, usdc_token: Address, annual_yield_bps: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if annual_yield_bps == 0 {
            panic!("annual_yield_bps must be > 0");
        }
        if annual_yield_bps > MAX_BPS as u32 {
            panic!("annual_yield_bps must be <= 10000");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::UsdcToken, &usdc_token);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage().instance().set(
            &DataKey::Pool,
            &PoolState {
                total_deposited: 0,
                total_withdrawn: 0,
                annual_yield_bps,
                depositor_count: 0,
                total_principal: 0,
                yield_reserve: 0,
                yield_unclaimed: 0,
                yield_index: 0,
                last_accrual_ledger: env.ledger().sequence(),
                total_yield_funded: 0,
                total_yield_paid: 0,
            },
        );

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("init")),
            (admin, usdc_token, annual_yield_bps),
        );
    }

    // ── Core pool functions ───────────────────────────────────────────────────

    /// Deposit USDC into the lending pool.
    ///
    /// Transfers `amount` USDC from `depositor` into this contract and records
    /// the deposit. If the depositor already has an open position, the yield
    /// it has earned so far is compounded into the new principal.
    ///
    /// # Arguments
    /// * `depositor` – Address making the deposit (must have authorised this call).
    /// * `amount`    – USDC amount to deposit (must be > 0).
    pub fn deposit(env: Env, depositor: Address, amount: i128) {
        depositor.require_auth();
        Self::assert_not_paused(&env);

        if amount <= 0 {
            panic!("amount must be > 0");
        }

        // Transfer USDC from depositor → pool contract. `depositor.require_auth()`
        // above covers the token transfer, so no prior allowance is needed.
        let usdc = Self::usdc_client(&env);
        let contract_addr = env.current_contract_address();
        usdc.transfer(&depositor, &contract_addr, &amount);

        let current_ledger = env.ledger().sequence();
        let mut pool = Self::accrued_pool(&env);

        // Settle earned yield into the new principal so the depositor keeps
        // it. That yield moves from `yield_unclaimed` into principal.
        let new_principal = match env
            .storage()
            .persistent()
            .get::<DataKey, DepositRecord>(&DataKey::Deposit(depositor.clone()))
        {
            Some(existing) => {
                let settled_yield = Self::take_pending_yield(&mut pool, &existing);
                pool.total_principal += settled_yield;
                existing.principal + settled_yield + amount
            }
            None => {
                pool.depositor_count += 1;
                amount
            }
        };

        pool.total_deposited += amount;
        pool.total_principal += amount;
        let yield_index = pool.yield_index;
        Self::save_pool(&env, &pool);

        env.storage().persistent().set(
            &DataKey::Deposit(depositor.clone()),
            &DepositRecord {
                principal: new_principal,
                deposit_ledger: current_ledger,
                yield_index,
            },
        );

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("deposit")),
            (depositor, amount, current_ledger),
        );
    }

    /// Withdraw principal (plus earned yield) from the lending pool.
    ///
    /// `amount` of principal is withdrawn together with all yield the position
    /// has earned so far. If `amount` is less than the principal, the rest
    /// stays in the pool and keeps earning yield; if it equals the principal
    /// the deposit record is closed. Yield is limited to what has been funded
    /// via `fund_yield` and released to the depositor; it is never paid out of
    /// other depositors' principal.
    ///
    /// # Arguments
    /// * `depositor` – Address to withdraw on behalf of (must have authorised this call).
    /// * `amount`    – Principal to withdraw (must be > 0 and <= current principal).
    pub fn withdraw(env: Env, depositor: Address, amount: i128) {
        depositor.require_auth();
        Self::assert_not_paused(&env);

        if amount <= 0 {
            panic!("amount must be > 0");
        }

        let record: DepositRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Deposit(depositor.clone()))
            .expect("no deposit found for this address");

        if record.principal <= 0 {
            panic!("nothing to withdraw");
        }
        if amount > record.principal {
            panic!("amount exceeds deposited principal");
        }

        let current_ledger = env.ledger().sequence();
        let mut pool = Self::accrued_pool(&env);
        let yield_amount = Self::take_pending_yield(&mut pool, &record);
        let total_payout = amount + yield_amount;
        let remaining = record.principal - amount;

        pool.total_principal -= amount;
        pool.total_withdrawn += total_payout;
        pool.total_yield_paid += yield_amount;
        let yield_index = pool.yield_index;
        Self::save_pool(&env, &pool);

        if remaining == 0 {
            // Full withdrawal: clear the deposit record.
            env.storage()
                .persistent()
                .remove(&DataKey::Deposit(depositor.clone()));
        } else {
            // Partial withdrawal: yield was settled above, so restart the
            // remaining principal from the current index.
            env.storage().persistent().set(
                &DataKey::Deposit(depositor.clone()),
                &DepositRecord {
                    principal: remaining,
                    deposit_ledger: record.deposit_ledger,
                    yield_index,
                },
            );
        }

        // Transfer payout from pool → depositor.
        let usdc = Self::usdc_client(&env);
        usdc.transfer(&env.current_contract_address(), &depositor, &total_payout);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("withdraw")),
            (depositor, amount, yield_amount, current_ledger),
        );
    }

    /// Pay USDC into the yield reserve.
    ///
    /// This is the only source of depositor yield: borrower interest and
    /// repayments routed by the protocol, treasury top-ups, or any other
    /// funder. Anyone may fund; the USDC is streamed to depositors at no more
    /// than `annual_yield_bps`. Allowed while paused so funding never stalls.
    ///
    /// # Arguments
    /// * `funder` – Address paying the yield (must have authorised this call).
    /// * `amount` – USDC amount to add to the reserve (must be > 0).
    pub fn fund_yield(env: Env, funder: Address, amount: i128) {
        funder.require_auth();

        if amount <= 0 {
            panic!("amount must be > 0");
        }

        let usdc = Self::usdc_client(&env);
        usdc.transfer(&funder, &env.current_contract_address(), &amount);

        // Accrue first: ledgers that elapsed while the reserve was empty earn
        // nothing, so new funding is never applied retroactively.
        let mut pool = Self::accrued_pool(&env);
        pool.yield_reserve += amount;
        pool.total_yield_funded += amount;
        Self::save_pool(&env, &pool);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("funded")),
            (funder, amount),
        );
    }

    // ── View functions ────────────────────────────────────────────────────────

    /// Returns the depositor's current `(principal, accrued_yield)` tuple.
    /// Returns `(0, 0)` if the address has no open deposit.
    pub fn get_deposit(env: Env, depositor: Address) -> (i128, i128) {
        match env
            .storage()
            .persistent()
            .get::<DataKey, DepositRecord>(&DataKey::Deposit(depositor))
        {
            Some(record) => {
                let pool = Self::accrued_pool(&env);
                let yield_amount = Self::pending_yield(&record, pool.yield_index);
                (record.principal, yield_amount)
            }
            None => (0, 0),
        }
    }

    /// Returns the global pool state, with yield accrued up to the current ledger.
    pub fn get_pool_state(env: Env) -> PoolState {
        Self::accrued_pool(&env)
    }

    /// Returns true if the pool is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    // ── Admin functions ───────────────────────────────────────────────────────

    /// Pause deposits and withdrawals (admin only).
    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::IsPaused, &true);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("paused")), ());
    }

    /// Resume deposits and withdrawals (admin only).
    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("unpaused")), ());
    }

    /// Update the maximum annual yield rate (admin only).
    ///
    /// Yield is accrued at the old rate up to this ledger before the new rate
    /// takes effect. A single update may move the rate by at most
    /// `MAX_YIELD_RATE_CHANGE_BPS` (500 bps) in either direction.
    pub fn set_yield_rate(env: Env, admin: Address, new_annual_yield_bps: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if new_annual_yield_bps == 0 {
            panic!("annual_yield_bps must be > 0");
        }
        if new_annual_yield_bps > MAX_BPS as u32 {
            panic!("annual_yield_bps must be <= 10000");
        }

        let mut pool = Self::accrued_pool(&env);
        if pool.annual_yield_bps.abs_diff(new_annual_yield_bps) > MAX_YIELD_RATE_CHANGE_BPS {
            panic!("yield rate change exceeds max step");
        }
        pool.annual_yield_bps = new_annual_yield_bps;
        Self::save_pool(&env, &pool);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("rate")),
            new_annual_yield_bps,
        );
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Load the pool state with yield accrued up to the current ledger.
    /// Callers that mutate state must persist it with `save_pool`.
    fn accrued_pool(env: &Env) -> PoolState {
        let mut pool: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .expect("pool not initialized");
        Self::accrue(&mut pool, env.ledger().sequence());
        pool
    }

    fn save_pool(env: &Env, pool: &PoolState) {
        env.storage().instance().set(&DataKey::Pool, pool);
    }

    /// Release yield from the reserve into the index for the ledgers elapsed
    /// since the last accrual.
    ///
    /// The index grows at `annual_yield_bps` per year, but never by more than
    /// the reserve can pay for. The amount moved out of the reserve is rounded
    /// *up*, while each depositor's share is rounded *down*, so the sum of
    /// all depositors' pending yield never exceeds `yield_unclaimed`.
    fn accrue(pool: &mut PoolState, current_ledger: u32) {
        if current_ledger <= pool.last_accrual_ledger {
            return;
        }
        let elapsed = (current_ledger - pool.last_accrual_ledger) as u128;
        pool.last_accrual_ledger = current_ledger;

        if pool.total_principal <= 0 || pool.yield_reserve <= 0 {
            return;
        }
        let total_principal = pool.total_principal as u128;

        // Index growth the target rate would grant…
        let rate_delta = (pool.annual_yield_bps as u128)
            .checked_mul(elapsed)
            .and_then(|v| v.checked_mul(INDEX_PRECISION))
            .expect("overflow computing rate index delta")
            / (MAX_BPS as u128 * LEDGERS_PER_YEAR as u128);
        // …and the growth the reserve can actually fund.
        let funded_delta = (pool.yield_reserve as u128)
            .checked_mul(INDEX_PRECISION)
            .expect("overflow computing funded index delta")
            / total_principal;
        let delta = rate_delta.min(funded_delta);
        if delta == 0 {
            return;
        }

        let released = total_principal
            .checked_mul(delta)
            .expect("overflow computing released yield")
            .div_ceil(INDEX_PRECISION) as i128;

        pool.yield_index += delta as i128;
        pool.yield_reserve -= released;
        pool.yield_unclaimed += released;
    }

    /// Yield earned by `record` at `yield_index`, rounded down.
    fn pending_yield(record: &DepositRecord, yield_index: i128) -> i128 {
        if record.principal <= 0 || yield_index <= record.yield_index {
            return 0;
        }
        let delta = (yield_index - record.yield_index) as u128;
        ((record.principal as u128)
            .checked_mul(delta)
            .expect("overflow computing pending yield")
            / INDEX_PRECISION) as i128
    }

    /// Settle `record`'s pending yield out of `yield_unclaimed`, enforcing
    /// that a depositor can never be paid more yield than the pool has earned.
    fn take_pending_yield(pool: &mut PoolState, record: &DepositRecord) -> i128 {
        let pending = Self::pending_yield(record, pool.yield_index);
        if pending > pool.yield_unclaimed {
            panic!("yield exceeds funded yield");
        }
        pool.yield_unclaimed -= pending;
        pending
    }

    /// Build a typed SEP-41 token client for the USDC contract.
    fn usdc_client(env: &Env) -> token::TokenClient<'_> {
        let addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcToken)
            .expect("usdc token not configured");
        token::TokenClient::new(env, &addr)
    }

    /// Panic if `caller` is not the stored admin.
    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");
        if *caller != admin {
            panic!("unauthorized: caller is not admin");
        }
    }

    /// Panic if the pool is currently paused.
    fn assert_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if paused {
            panic!("pool is paused");
        }
    }
}

#[cfg(test)]
mod test;
