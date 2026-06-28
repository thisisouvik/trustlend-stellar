#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    symbol_short, Address, Env, IntoVal,
};

const WINDOW_SECONDS: u64 = 180;
const START_TIMESTAMP: u64 = 1_000;

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIMESTAMP);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);

    (env, contract_id, admin, lender, borrower)
}

#[test]
fn test_revocation_window_is_open_until_exact_expiry() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &7, &5_000_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at - 1);
    assert!(client.is_within_revocation_window(&escrow_id));

    env.ledger().set_timestamp(hold.expires_at);
    assert!(!client.is_within_revocation_window(&escrow_id));
}

#[test]
fn test_revoke_hold_succeeds_before_expiry() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &12, &8_000_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at - 1);
    client.revoke_hold(&lender, &escrow_id);

    let updated = client.get_hold(&escrow_id);
    assert_eq!(updated.status, EscrowStatus::Revoked);
}

#[test]
#[should_panic(expected = "Revocation window has expired")]
fn test_revoke_hold_fails_at_exact_expiry() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &13, &8_000_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at);
    client.revoke_hold(&lender, &escrow_id);
}

#[test]
fn test_confirm_disbursement_succeeds_at_exact_expiry() {
    let (env, contract_id, admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &99, &9_500_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at);
    client.confirm_disbursement(&admin, &escrow_id);

    let updated = client.get_hold(&escrow_id);
    assert_eq!(updated.status, EscrowStatus::Transferred);
}

#[test]
#[should_panic(expected = "Revocation window has not expired yet")]
fn test_confirm_disbursement_fails_before_expiry() {
    let (env, contract_id, admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &100, &9_500_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at - 1);
    client.confirm_disbursement(&admin, &escrow_id);
}

#[test]
fn test_create_hold_sets_expected_expiry_window() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &5, &1_000_000);
    let hold = client.get_hold(&escrow_id);

    assert_eq!(hold.held_at, START_TIMESTAMP);
    assert_eq!(hold.expires_at, START_TIMESTAMP + WINDOW_SECONDS);
    assert_eq!(hold.status, EscrowStatus::Held);
}

#[test]
fn test_deposit_and_withdraw_emit_events() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let pool_id = 42u32;
    let amount = 5_000_000i128;

    let escrow_id = client.create_hold(&lender, &borrower, &pool_id, &amount);

    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("escrow"), symbol_short!("deposit")).into_val(&env),
                (lender.clone(), pool_id, amount).into_val(&env),
            ),
        ]
    );

    let hold = client.get_hold(&escrow_id);
    env.ledger().set_timestamp(hold.expires_at - 1);
    client.revoke_hold(&lender, &escrow_id);

    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("escrow"), symbol_short!("deposit")).into_val(&env),
                (lender.clone(), pool_id, amount).into_val(&env),
            ),
            (
                contract_id,
                (symbol_short!("escrow"), symbol_short!("withdraw")).into_val(&env),
                (lender, pool_id, amount).into_val(&env),
            ),
        ]
    );
}
