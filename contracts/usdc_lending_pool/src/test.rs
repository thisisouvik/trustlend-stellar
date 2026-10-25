#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

// ─── Test helpers ─────────────────────────────────────────────────────────────

/// Deploy a native Stellar asset (acts as USDC in tests) and return its address.
fn create_token<'a>(env: &'a Env, admin: &Address) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let addr = token_id.address();
    let asset_client = StellarAssetClient::new(env, &addr);
    let token_client = TokenClient::new(env, &addr);
    (addr, asset_client, token_client)
}

/// Yield reserve `setup()` funds through `fund_yield` (500 USDC).
const FUNDED_RESERVE: i128 = 500_000_000;

/// Standard test setup: deploys the pool + a mock USDC token, mints USDC to
/// `user`, and funds the yield reserve so deposits earn the full 5 %.
fn setup() -> (Env, Address, Address, Address, Address) {
    let (env, pool_id, admin, user, usdc_addr) = setup_unfunded();

    // Fund the yield reserve the way the protocol would: an explicit,
    // accounted payment rather than a raw transfer to the pool.
    StellarAssetClient::new(&env, &usdc_addr).mint(&admin, &FUNDED_RESERVE);
    UsdcLendingPoolClient::new(&env, &pool_id).fund_yield(&admin, &FUNDED_RESERVE);

    (env, pool_id, admin, user, usdc_addr)
}

/// Like `setup()`, but with an empty yield reserve.
fn setup_unfunded() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Yield tests fast-forward the ledger by up to a full year (6.3M ledgers).
    // Raise the entry TTLs so contract storage is not archived along the way.
    env.ledger().with_mut(|li| {
        li.min_temp_entry_ttl = 100_000_000;
        li.min_persistent_entry_ttl = 100_000_000;
        li.max_entry_ttl = 100_000_000;
    });

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    // Deploy mock USDC token and mint to user
    let (usdc_addr, asset_client, _) = create_token(&env, &admin);
    asset_client.mint(&user, &1_000_000_000); // 1 000 USDC (7 decimals assumed)

    // Deploy pool contract
    let pool_id = env.register(UsdcLendingPool, ());

    // Initialize pool: 5 % annual yield (500 bps)
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.initialize(&admin, &usdc_addr, &500_u32);

    (env, pool_id, admin, user, usdc_addr)
}

/// Ledgers in one year / half a year at the contract's 5 s close time.
const YEAR: u32 = 6_307_200;
const HALF_YEAR: u32 = 3_153_600;

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| li.sequence_number += ledgers);
}

/// A fresh depositor holding `balance` USDC.
fn new_user(env: &Env, usdc: &Address, balance: i128) -> Address {
    let user = Address::generate(env);
    StellarAssetClient::new(env, usdc).mint(&user, &balance);
    user
}

/// The pool's USDC balance always equals what it owes plus what it holds in
/// reserve — principal is never used to pay yield, and nothing is unbacked.
fn assert_fully_backed(env: &Env, pool_id: &Address, usdc: &Address) {
    let state = UsdcLendingPoolClient::new(env, pool_id).get_pool_state();
    let balance = TokenClient::new(env, usdc).balance(pool_id);
    assert!(state.total_principal >= 0);
    assert!(state.yield_reserve >= 0);
    assert!(state.yield_unclaimed >= 0);
    assert_eq!(
        balance,
        state.total_principal + state.yield_unclaimed + state.yield_reserve,
        "pool balance must equal principal + unclaimed yield + reserve"
    );
}

// ─── Initialization tests ─────────────────────────────────────────────────────

#[test]
fn test_initialize_stores_pool_state() {
    let (env, pool_id, _admin, _user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    let state = client.get_pool_state();
    assert_eq!(state.total_deposited, 0);
    assert_eq!(state.total_withdrawn, 0);
    assert_eq!(state.annual_yield_bps, 500);
    assert_eq!(state.depositor_count, 0);
    assert_eq!(state.total_principal, 0);
    assert_eq!(state.yield_reserve, FUNDED_RESERVE);
    assert_eq!(state.yield_unclaimed, 0);
    assert_eq!(state.total_yield_funded, FUNDED_RESERVE);
    assert_eq!(state.total_yield_paid, 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_initialize_rejects_double_init() {
    let (env, pool_id, admin, _user, usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.initialize(&admin, &usdc, &500_u32);
}

#[test]
#[should_panic(expected = "annual_yield_bps must be > 0")]
fn test_initialize_rejects_zero_yield() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let (usdc_addr, _, _) = create_token(&env, &admin);
    let pool_id = env.register(UsdcLendingPool, ());
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.initialize(&admin, &usdc_addr, &0_u32);
}

#[test]
#[should_panic(expected = "annual_yield_bps must be <= 10000")]
fn test_initialize_rejects_yield_over_max() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let (usdc_addr, _, _) = create_token(&env, &admin);
    let pool_id = env.register(UsdcLendingPool, ());
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.initialize(&admin, &usdc_addr, &10_001_u32);
}

// ─── Deposit tests ────────────────────────────────────────────────────────────

#[test]
fn test_deposit_records_principal_and_updates_pool() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    let deposit_amount: i128 = 100_000_000; // 100 USDC
    client.deposit(&user, &deposit_amount);

    let (principal, accrued) = client.get_deposit(&user);
    assert_eq!(principal, deposit_amount);
    assert_eq!(accrued, 0); // no ledgers have advanced

    let state = client.get_pool_state();
    assert_eq!(state.total_deposited, deposit_amount);
    assert_eq!(state.depositor_count, 1);
}

#[test]
#[should_panic(expected = "amount must be > 0")]
fn test_deposit_rejects_zero_amount() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.deposit(&user, &0_i128);
}

#[test]
#[should_panic(expected = "amount must be > 0")]
fn test_deposit_rejects_negative_amount() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.deposit(&user, &(-1_i128));
}

#[test]
fn test_deposit_accumulates_on_second_deposit() {
    let (env, pool_id, _admin, user, _usdc_addr) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    // First deposit
    client.deposit(&user, &100_000_000_i128);

    // Advance ledger by ~1 year worth of ledgers so yield is meaningful
    env.ledger().with_mut(|li| li.sequence_number += 6_307_200_u32);

    // Second deposit: the previous principal + accrued yield should roll into new principal
    client.deposit(&user, &50_000_000_i128);

    let (principal, _accrued) = client.get_deposit(&user);
    // new principal = original_principal(100M) + yield(~5% of 100M = ~5M) + new_deposit(50M) ≈ 155M
    assert!(principal > 150_000_000, "principal should include rolled-over yield");
    assert!(principal < 160_000_000, "principal should be reasonable");

    let state = client.get_pool_state();
    // total_deposited tracks raw deposit amounts only (100M + 50M)
    assert_eq!(state.total_deposited, 150_000_000);
    // depositor_count stays 1 (same user)
    assert_eq!(state.depositor_count, 1);
}

// ─── Withdrawal tests ─────────────────────────────────────────────────────────

#[test]
fn test_withdraw_returns_principal_plus_yield() {
    let (env, pool_id, _admin, user, usdc_addr) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    // setup() funded the yield reserve, so the full rate is paid
    let token_client = TokenClient::new(&env, &usdc_addr);
    let deposit_amount: i128 = 100_000_000;

    client.deposit(&user, &deposit_amount);

    // Balance after deposit: user gave 100M to pool
    let balance_after_deposit = token_client.balance(&user);

    // Advance ledger by half a year
    env.ledger().with_mut(|li| li.sequence_number += 3_153_600_u32);

    let (principal, expected_yield) = client.get_deposit(&user);
    assert_eq!(principal, deposit_amount);
    // 5% annual / 2 years ≈ 2.5% of 100M = ~2.5M
    assert!(expected_yield > 0, "yield should accrue over ledger time");

    client.withdraw(&user, &client.get_deposit(&user).0);

    let balance_after_withdraw = token_client.balance(&user);
    let received = balance_after_withdraw - balance_after_deposit;

    assert_eq!(received, principal + expected_yield);
    assert!(received > deposit_amount, "user must receive more than deposited");
}

#[test]
fn test_withdraw_updates_pool_total_withdrawn() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    let deposit_amount: i128 = 50_000_000;
    client.deposit(&user, &deposit_amount);

    // Small ledger advance
    env.ledger().with_mut(|li| li.sequence_number += 100_u32);

    let (principal, yield_amt) = client.get_deposit(&user);
    client.withdraw(&user, &client.get_deposit(&user).0);

    let state = client.get_pool_state();
    assert_eq!(state.total_withdrawn, principal + yield_amt);
}

#[test]
fn test_withdraw_clears_deposit_record() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    client.deposit(&user, &100_000_000_i128);
    client.withdraw(&user, &client.get_deposit(&user).0);

    let (principal, accrued) = client.get_deposit(&user);
    assert_eq!(principal, 0);
    assert_eq!(accrued, 0);
}

#[test]
#[should_panic(expected = "no deposit found for this address")]
fn test_withdraw_without_deposit_panics() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.withdraw(&user, &1_000_000);
}

// ─── Yield accrual tests ──────────────────────────────────────────────────────

#[test]
fn test_zero_yield_when_same_ledger() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    client.deposit(&user, &100_000_000_i128);
    let (principal, accrued) = client.get_deposit(&user);
    assert_eq!(principal, 100_000_000);
    assert_eq!(accrued, 0, "no yield on same ledger");
}

#[test]
fn test_yield_increases_with_ledger_advancement() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    client.deposit(&user, &100_000_000_i128);

    env.ledger().with_mut(|li| li.sequence_number += 1_000_000_u32);
    let (_, yield_1m) = client.get_deposit(&user);

    env.ledger().with_mut(|li| li.sequence_number += 1_000_000_u32);
    let (_, yield_2m) = client.get_deposit(&user);

    assert!(yield_2m > yield_1m, "yield should grow with more ledgers");
}

#[test]
fn test_full_year_yield_approximately_correct() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    let deposit_amount: i128 = 100_000_000; // 100 USDC (7 decimals)
    client.deposit(&user, &deposit_amount);

    // Advance exactly 1 year of ledgers
    env.ledger().with_mut(|li| li.sequence_number += 6_307_200_u32);

    let (_, accrued) = client.get_deposit(&user);

    // Expected: 5% of 100M = 5M
    let expected = 5_000_000_i128;
    let tolerance = 1_000_i128; // tiny rounding tolerance
    assert!(
        (accrued - expected).abs() <= tolerance,
        "1-year yield should be ~5%, got {}",
        accrued
    );
}

// ─── Multiple depositors ──────────────────────────────────────────────────────

#[test]
fn test_multiple_depositors_tracked_independently() {
    let (env, pool_id, admin, user1, usdc_addr) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    // Create a second user and mint tokens
    let user2 = Address::generate(&env);
    let asset_client = StellarAssetClient::new(&env, &usdc_addr);
    asset_client.mint(&user2, &500_000_000_i128);

    client.deposit(&user1, &100_000_000_i128);

    env.ledger().with_mut(|li| li.sequence_number += 100_u32);

    client.deposit(&user2, &200_000_000_i128);

    let (p1, _) = client.get_deposit(&user1);
    let (p2, _) = client.get_deposit(&user2);

    assert_eq!(p1, 100_000_000);
    assert_eq!(p2, 200_000_000);

    let state = client.get_pool_state();
    assert_eq!(state.total_deposited, 300_000_000);
    assert_eq!(state.depositor_count, 2);
    let _ = admin; // suppress unused warning
}

// ─── Pause / unpause tests ────────────────────────────────────────────────────

#[test]
fn test_pause_prevents_deposit() {
    let (env, pool_id, admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    client.pause(&admin);
    assert!(client.is_paused());

    // deposit must fail while paused (try_ variant surfaces the panic as Err
    // without needing catch_unwind, which the Env handle does not support)
    let result = client.try_deposit(&user, &100_000_000_i128);
    assert!(result.is_err(), "deposit should be blocked when paused");
}

#[test]
fn test_unpause_restores_deposits() {
    let (env, pool_id, admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    client.pause(&admin);
    client.unpause(&admin);
    assert!(!client.is_paused());

    // Should succeed after unpausing
    client.deposit(&user, &100_000_000_i128);
    let (principal, _) = client.get_deposit(&user);
    assert_eq!(principal, 100_000_000);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_pause_by_non_admin_panics() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.pause(&user); // user is not admin
}

// ─── Yield rate update tests ───────────────────────────────────────────────────

#[test]
fn test_set_yield_rate_updates_pool_state() {
    let (env, pool_id, admin, _user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    client.set_yield_rate(&admin, &1000_u32); // 10%
    let state = client.get_pool_state();
    assert_eq!(state.annual_yield_bps, 1000);
}

#[test]
#[should_panic(expected = "annual_yield_bps must be > 0")]
fn test_set_yield_rate_rejects_zero() {
    let (env, pool_id, admin, _user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.set_yield_rate(&admin, &0_u32);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_set_yield_rate_by_non_admin_panics() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.set_yield_rate(&user, &1000_u32);
}

// ─── Funded yield & solvency invariants (Issue #337) ───────────────────────────

/// The original bug: with no yield funded, early withdrawers used to be paid
/// "yield" out of later depositors' principal. Now everyone gets exactly
/// their principal back and the pool ends empty.
#[test]
fn test_no_yield_without_funding() {
    let (env, pool_id, _admin, user1, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let token = TokenClient::new(&env, &usdc);
    let user2 = new_user(&env, &usdc, 100_000_000);

    client.deposit(&user1, &100_000_000);
    client.deposit(&user2, &100_000_000);
    advance(&env, YEAR);

    assert_eq!(client.get_deposit(&user1), (100_000_000, 0));
    let before = token.balance(&user1);
    client.withdraw(&user1, &client.get_deposit(&user1).0);
    assert_eq!(token.balance(&user1) - before, 100_000_000);

    // The second depositor's principal is intact.
    client.withdraw(&user2, &client.get_deposit(&user2).0);
    assert_eq!(token.balance(&user2), 100_000_000);
    assert_eq!(token.balance(&pool_id), 0);
    assert_fully_backed(&env, &pool_id, &usdc);
}

/// USDC sent to the pool outside `fund_yield` is not treated as yield.
#[test]
fn test_direct_transfer_is_not_yield() {
    let (env, pool_id, _admin, user, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let token = TokenClient::new(&env, &usdc);

    StellarAssetClient::new(&env, &usdc).mint(&pool_id, &500_000_000);
    client.deposit(&user, &100_000_000);
    advance(&env, YEAR);

    assert_eq!(client.get_deposit(&user), (100_000_000, 0));
    let before = token.balance(&user);
    client.withdraw(&user, &client.get_deposit(&user).0);
    assert_eq!(token.balance(&user) - before, 100_000_000);
    assert_eq!(client.get_pool_state().yield_reserve, 0);
}

/// Yield is capped by the funded reserve, however long the deposit runs.
#[test]
fn test_yield_capped_by_funded_reserve() {
    let (env, pool_id, _admin, user, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let token = TokenClient::new(&env, &usdc);
    let funder = new_user(&env, &usdc, 1_000_000);

    client.fund_yield(&funder, &1_000_000); // 1 USDC of real yield
    client.deposit(&user, &100_000_000);
    advance(&env, YEAR); // 5 % would be 5 USDC

    assert_eq!(client.get_deposit(&user), (100_000_000, 1_000_000));
    let state = client.get_pool_state();
    assert_eq!(state.yield_reserve, 0);
    assert_eq!(state.yield_unclaimed, 1_000_000);
    assert_fully_backed(&env, &pool_id, &usdc);

    // More time does not create more yield.
    advance(&env, YEAR);
    assert_eq!(client.get_deposit(&user), (100_000_000, 1_000_000));

    let before = token.balance(&user);
    client.withdraw(&user, &client.get_deposit(&user).0);
    assert_eq!(token.balance(&user) - before, 101_000_000);
    assert_eq!(token.balance(&pool_id), 0);
    assert_eq!(client.get_pool_state().total_yield_paid, 1_000_000);
}

/// When the reserve cannot cover the target rate, the shortfall is shared
/// pro-rata — an early withdrawer cannot drain the reserve at the expense of
/// those who stay.
#[test]
fn test_reserve_shortfall_shared_pro_rata() {
    let (env, pool_id, _admin, small, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let token = TokenClient::new(&env, &usdc);
    let large = new_user(&env, &usdc, 300_000_000);
    let funder = new_user(&env, &usdc, 4_000_000);

    client.fund_yield(&funder, &4_000_000);
    client.deposit(&small, &100_000_000);
    client.deposit(&large, &300_000_000);
    advance(&env, YEAR); // target 20 USDC, only 4 USDC funded

    assert_eq!(client.get_deposit(&small).1, 1_000_000);
    assert_eq!(client.get_deposit(&large).1, 3_000_000);

    let before = token.balance(&small);
    client.withdraw(&small, &client.get_deposit(&small).0);
    assert_eq!(token.balance(&small) - before, 101_000_000);
    assert_fully_backed(&env, &pool_id, &usdc);

    // The remaining depositor's share is untouched by the early exit.
    advance(&env, YEAR);
    assert_eq!(client.get_deposit(&large).1, 3_000_000);
    client.withdraw(&large, &client.get_deposit(&large).0);
    assert_eq!(token.balance(&large), 303_000_000);
    assert_eq!(token.balance(&pool_id), 0);
}

/// Funding is not applied retroactively to ledgers that elapsed while the
/// reserve was empty.
#[test]
fn test_funding_is_not_retroactive() {
    let (env, pool_id, _admin, user, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let funder = new_user(&env, &usdc, 100_000_000);

    client.deposit(&user, &100_000_000);
    advance(&env, YEAR);
    client.fund_yield(&funder, &100_000_000);
    assert_eq!(client.get_deposit(&user).1, 0);

    advance(&env, HALF_YEAR);
    assert_eq!(client.get_deposit(&user).1, 2_500_000);
    assert_fully_backed(&env, &pool_id, &usdc);
}

/// A rate change applies from the ledger it is made; earlier ledgers keep
/// the old rate.
#[test]
fn test_rate_change_accrues_old_rate_first() {
    let (env, pool_id, admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);

    client.deposit(&user, &100_000_000);
    advance(&env, HALF_YEAR); // 2.5 % at 5 %
    client.set_yield_rate(&admin, &1000_u32);
    advance(&env, HALF_YEAR); // 5 % at 10 %

    assert_eq!(client.get_deposit(&user).1, 7_500_000);
}

#[test]
fn test_fund_yield_updates_reserve_and_emits_totals() {
    let (env, pool_id, _admin, _user, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let funder = new_user(&env, &usdc, 30_000_000);

    client.fund_yield(&funder, &10_000_000);
    client.fund_yield(&funder, &20_000_000);

    let state = client.get_pool_state();
    assert_eq!(state.yield_reserve, 30_000_000);
    assert_eq!(state.total_yield_funded, 30_000_000);
    assert_eq!(TokenClient::new(&env, &usdc).balance(&funder), 0);
    assert_fully_backed(&env, &pool_id, &usdc);
}

#[test]
#[should_panic(expected = "amount must be > 0")]
fn test_fund_yield_rejects_zero_amount() {
    let (env, pool_id, admin, _user, _usdc) = setup_unfunded();
    UsdcLendingPoolClient::new(&env, &pool_id).fund_yield(&admin, &0_i128);
}

/// Funding keeps working while deposits and withdrawals are paused.
#[test]
fn test_fund_yield_allowed_while_paused() {
    let (env, pool_id, admin, _user, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let funder = new_user(&env, &usdc, 1_000_000);

    client.pause(&admin);
    client.fund_yield(&funder, &1_000_000);
    assert_eq!(client.get_pool_state().yield_reserve, 1_000_000);
}

/// Multi-user lifecycle with intermittent, insufficient and ample funding.
/// After every step the pool is exactly backed, nobody loses principal, and
/// total yield paid never exceeds total yield funded.
#[test]
fn test_multi_user_lifecycle_never_pays_unfunded_yield() {
    let (env, pool_id, _admin, _user, usdc) = setup_unfunded();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let token = TokenClient::new(&env, &usdc);
    let funder = new_user(&env, &usdc, 1_000_000_000);
    let alice = new_user(&env, &usdc, 250_000_000);
    let bob = new_user(&env, &usdc, 100_000_000);
    let carol = new_user(&env, &usdc, 300_000_000);

    // Alice alone, under-funded: 3 USDC funded against a 5 USDC target.
    client.fund_yield(&funder, &3_000_000);
    client.deposit(&alice, &200_000_000);
    advance(&env, HALF_YEAR);
    assert_eq!(client.get_deposit(&alice).1, 3_000_000);
    assert_fully_backed(&env, &pool_id, &usdc);

    // Bob joins and the reserve is topped up enough for the full rate.
    client.deposit(&bob, &100_000_000);
    client.fund_yield(&funder, &10_000_000);
    advance(&env, HALF_YEAR);
    assert_eq!(client.get_deposit(&alice).1, 8_000_000); // 3 + 5
    assert_eq!(client.get_deposit(&bob).1, 2_500_000);
    assert_fully_backed(&env, &pool_id, &usdc);

    // Alice tops up: her 8 USDC of yield compounds into principal.
    client.deposit(&alice, &50_000_000);
    assert_eq!(client.get_deposit(&alice), (258_000_000, 0));
    assert_fully_backed(&env, &pool_id, &usdc);

    // Carol joins; only 2.5 USDC is left against a much larger target.
    client.deposit(&carol, &300_000_000);
    advance(&env, YEAR);
    assert_eq!(client.get_pool_state().yield_reserve, 0);
    assert_fully_backed(&env, &pool_id, &usdc);

    // Bob exits with his principal plus only funded yield.
    let (bob_principal, bob_yield) = client.get_deposit(&bob);
    assert!(bob_yield > 2_500_000 && bob_yield < 3_000_000);
    client.withdraw(&bob, &client.get_deposit(&bob).0);
    assert_eq!(token.balance(&bob), bob_principal + bob_yield);
    assert_fully_backed(&env, &pool_id, &usdc);

    // More funding arrives; the remaining depositors exit.
    client.fund_yield(&funder, &20_000_000);
    advance(&env, YEAR);
    client.withdraw(&alice, &client.get_deposit(&alice).0);
    assert_fully_backed(&env, &pool_id, &usdc);
    client.withdraw(&carol, &client.get_deposit(&carol).0);
    assert_fully_backed(&env, &pool_id, &usdc);

    // Nobody lost principal.
    assert!(token.balance(&alice) > 250_000_000);
    assert!(token.balance(&bob) > 100_000_000);
    assert!(token.balance(&carol) > 300_000_000);

    let state = client.get_pool_state();
    assert_eq!(state.total_principal, 0);
    // All yield delivered — paid on withdrawal or compounded into principal
    // first — came out of funding, never out of principal.
    let yield_delivered = state.total_withdrawn - state.total_deposited;
    assert!(yield_delivered > 0);
    assert!(yield_delivered <= state.total_yield_funded);
    assert!(state.total_yield_paid <= yield_delivered);
    // Everything not delivered is still held: the undistributed reserve plus
    // at most a few units of rounding dust.
    assert_eq!(
        token.balance(&pool_id),
        state.total_yield_funded - yield_delivered
    );
    assert_eq!(
        token.balance(&pool_id),
        state.yield_reserve + state.yield_unclaimed
    );
    assert!(state.yield_unclaimed < 10, "only rounding dust may remain");
}

// ─── Partial withdrawals & rate-change limit ──────────────────────────────────

#[test]
fn test_partial_withdraw_keeps_remaining_principal_earning() {
    let (env, pool_id, _admin, user, usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    let token = TokenClient::new(&env, &usdc);
    client.deposit(&user, &100_000_000);
    advance(&env, 3_153_600);

    let (_, pending) = client.get_deposit(&user);
    assert!(pending > 0);
    let before = token.balance(&user);
    client.withdraw(&user, &40_000_000);

    // Requested principal plus all accrued yield is paid out.
    assert_eq!(token.balance(&user) - before, 40_000_000 + pending);
    let (principal, yield_left) = client.get_deposit(&user);
    assert_eq!(principal, 60_000_000);
    assert_eq!(yield_left, 0);

    let pool = client.get_pool_state();
    assert_eq!(pool.total_principal, 60_000_000);
    assert_eq!(pool.total_withdrawn, 40_000_000 + pending);
    assert_eq!(pool.total_yield_paid, pending);

    // The remainder keeps earning.
    advance(&env, 1_000_000);
    let (_, later) = client.get_deposit(&user);
    assert!(later > 0, "remaining principal should keep accruing yield");
    assert_fully_backed(&env, &pool_id, &usdc);
}

#[test]
fn test_partial_then_full_withdraw_closes_position() {
    let (env, pool_id, _admin, user, usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.deposit(&user, &100_000_000);
    client.withdraw(&user, &30_000_000);
    client.withdraw(&user, &70_000_000);
    assert_eq!(client.get_deposit(&user), (0, 0));
    assert_eq!(client.get_pool_state().total_principal, 0);
    assert_fully_backed(&env, &pool_id, &usdc);
}

#[test]
#[should_panic(expected = "amount exceeds deposited principal")]
fn test_withdraw_rejects_amount_above_principal() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.deposit(&user, &100_000_000);
    client.withdraw(&user, &100_000_001);
}

#[test]
#[should_panic(expected = "amount must be > 0")]
fn test_withdraw_rejects_zero_amount() {
    let (env, pool_id, _admin, user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.deposit(&user, &100_000_000);
    client.withdraw(&user, &0);
}

#[test]
fn test_set_yield_rate_allows_max_step() {
    let (env, pool_id, admin, _user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.set_yield_rate(&admin, &1000_u32);
    assert_eq!(client.get_pool_state().annual_yield_bps, 1000);
    client.set_yield_rate(&admin, &500_u32);
    assert_eq!(client.get_pool_state().annual_yield_bps, 500);
}

#[test]
#[should_panic(expected = "yield rate change exceeds max step")]
fn test_set_yield_rate_rejects_increase_above_step() {
    let (env, pool_id, admin, _user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.set_yield_rate(&admin, &1001_u32);
}

#[test]
#[should_panic(expected = "yield rate change exceeds max step")]
fn test_set_yield_rate_rejects_decrease_above_step() {
    let (env, pool_id, admin, _user, _usdc) = setup();
    let client = UsdcLendingPoolClient::new(&env, &pool_id);
    client.set_yield_rate(&admin, &1000_u32);
    client.set_yield_rate(&admin, &499_u32);
}
