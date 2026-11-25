#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{vec, IntoVal, Symbol};

fn setup<'a>() -> (Env, Address, TlendTokenContractClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let id = env.register(
        TlendTokenContract,
        (
            &admin,
            7_u32,
            String::from_str(&env, "TrustLend"),
            String::from_str(&env, "TLEND"),
        ),
    );
    let token = TlendTokenContractClient::new(&env, &id);

    (env, admin, token)
}

#[test]
fn test_metadata() {
    let (_env, _admin, token) = setup();
    assert_eq!(token.decimals(), 7);
    assert_eq!(token.total_supply(), 0);
}

/// Issue #352: initialization happens in the constructor at deploy time, so
/// there is no `initialize` entrypoint to front-run, and the constructor
/// cannot be re-invoked on a live contract.
#[test]
fn test_constructor_initializes_and_cannot_be_reinvoked() {
    let (env, admin, token) = setup();
    assert_eq!(token.admin(), admin);
    assert_eq!(token.decimals(), 7);

    let attacker = Address::generate(&env);
    let args = vec![
        &env,
        attacker.into_val(&env),
        7u32.into_val(&env),
        String::from_str(&env, "X").into_val(&env),
        String::from_str(&env, "X").into_val(&env),
    ];
    for name in ["initialize", "__constructor"] {
        let res = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &token.address,
            &Symbol::new(&env, name),
            args.clone(),
        );
        assert!(res.is_err(), "{name} must not be callable after deployment");
    }
    assert_eq!(token.admin(), admin);
}

#[test]
fn test_mint_and_balance() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    token.mint(&alice, &1_000);
    assert_eq!(token.balance(&alice), 1_000);
    assert_eq!(token.total_supply(), 1_000);
}

#[test]
#[should_panic]
fn test_mint_requires_admin_auth() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    // Explicitly empty auth entries for the next call — admin.require_auth()
    // has no matching signature and must fail, unlike mock_all_auths().
    env.set_auths(&[]);
    token.mint(&alice, &1_000);
}

#[test]
fn test_transfer() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token.mint(&alice, &1_000);
    token.transfer(&alice, &bob, &400);

    assert_eq!(token.balance(&alice), 600);
    assert_eq!(token.balance(&bob), 400);
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn test_transfer_insufficient_balance_panics() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token.mint(&alice, &100);
    token.transfer(&alice, &bob, &200);
}

#[test]
fn test_approve_and_transfer_from() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let spender = Address::generate(&env);

    token.mint(&alice, &1_000);
    let expiration = env.ledger().sequence() + 100;
    token.approve(&alice, &spender, &300, &expiration);
    assert_eq!(token.allowance(&alice, &spender), 300);

    token.transfer_from(&spender, &alice, &bob, &200);
    assert_eq!(token.balance(&alice), 800);
    assert_eq!(token.balance(&bob), 200);
    assert_eq!(token.allowance(&alice, &spender), 100);
}

#[test]
#[should_panic(expected = "Insufficient allowance")]
fn test_transfer_from_exceeds_allowance_panics() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let spender = Address::generate(&env);

    token.mint(&alice, &1_000);
    let expiration = env.ledger().sequence() + 100;
    token.approve(&alice, &spender, &50, &expiration);
    token.transfer_from(&spender, &alice, &bob, &51);
}

#[test]
fn test_allowance_expires() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);
    let spender = Address::generate(&env);

    let expiration = env.ledger().sequence() + 5;
    token.approve(&alice, &spender, &100, &expiration);
    assert_eq!(token.allowance(&alice, &spender), 100);

    env.ledger()
        .with_mut(|l| l.sequence_number = expiration + 1);
    assert_eq!(token.allowance(&alice, &spender), 0);
}

#[test]
fn test_burn() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    token.mint(&alice, &500);
    token.burn(&alice, &200);

    assert_eq!(token.balance(&alice), 300);
    assert_eq!(token.total_supply(), 300);
}

#[test]
#[should_panic(expected = "not authorised")]
fn test_set_authorized_blocks_transfer() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token.mint(&alice, &1_000);
    token.set_authorized(&alice, &false);
    assert!(!token.authorized(&alice));

    token.transfer(&alice, &bob, &10);
}

#[test]
fn test_reauthorize_allows_transfer_again() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token.mint(&alice, &1_000);
    token.set_authorized(&alice, &false);
    token.set_authorized(&alice, &true);

    token.transfer(&alice, &bob, &10);
    assert_eq!(token.balance(&bob), 10);
}

#[test]
fn test_clawback() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    token.mint(&alice, &500);
    token.clawback(&alice, &300);

    assert_eq!(token.balance(&alice), 200);
    assert_eq!(token.total_supply(), 200);
}

#[test]
fn test_set_admin() {
    let (env, _admin, token) = setup();
    let new_admin = Address::generate(&env);
    token.set_admin(&new_admin);
    assert_eq!(token.admin(), new_admin);
}

// ─── Maximum Total Supply Cap Tests (Issue #426) ───────────────────────────

#[test]
fn test_max_supply_constant() {
    let (_env, _admin, token) = setup();
    assert_eq!(token.max_supply(), MAX_TOTAL_SUPPLY);
    assert_eq!(MAX_SUPPLY, MAX_TOTAL_SUPPLY);
}

#[test]
fn test_mint_up_to_max_supply_succeeds() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    // Mint in two chunks up to exactly MAX_TOTAL_SUPPLY
    let chunk1 = MAX_TOTAL_SUPPLY - 5_000_000;
    let chunk2 = 5_000_000;

    token.mint(&alice, &chunk1);
    assert_eq!(token.total_supply(), chunk1);
    assert_eq!(token.balance(&alice), chunk1);

    token.mint(&alice, &chunk2);
    assert_eq!(token.total_supply(), MAX_TOTAL_SUPPLY);
    assert_eq!(token.balance(&alice), MAX_TOTAL_SUPPLY);
}

#[test]
#[should_panic(expected = "Total supply exceeds maximum cap")]
fn test_mint_exceeding_max_supply_panics() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    token.mint(&alice, &(MAX_TOTAL_SUPPLY + 1));
}

#[test]
#[should_panic(expected = "Total supply exceeds maximum cap")]
fn test_mint_incremental_beyond_max_supply_panics() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    token.mint(&alice, &MAX_TOTAL_SUPPLY);
    assert_eq!(token.total_supply(), MAX_TOTAL_SUPPLY);

    // 1 stroop beyond cap must revert
    token.mint(&alice, &1);
}

#[test]
fn test_burn_allows_reminting_under_cap() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    token.mint(&alice, &MAX_TOTAL_SUPPLY);
    assert_eq!(token.total_supply(), MAX_TOTAL_SUPPLY);

    // Burn 10,000 units
    token.burn(&alice, &10_000);
    assert_eq!(token.total_supply(), MAX_TOTAL_SUPPLY - 10_000);

    // Can re-mint 10,000 units back up to cap
    token.mint(&alice, &10_000);
    assert_eq!(token.total_supply(), MAX_TOTAL_SUPPLY);
}

#[test]
#[should_panic(expected = "Total supply exceeds maximum cap")]
fn test_remint_beyond_cap_after_burn_panics() {
    let (env, _admin, token) = setup();
    let alice = Address::generate(&env);

    token.mint(&alice, &MAX_TOTAL_SUPPLY);
    token.burn(&alice, &5_000);

    // Minting 5_001 exceeds cap by 1
    token.mint(&alice, &5_001);
}
