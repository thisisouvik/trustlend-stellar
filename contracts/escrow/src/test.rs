#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    symbol_short, token, Address, Env, IntoVal, vec,
};

const WINDOW_SECONDS: u64 = 180;
const START_TIMESTAMP: u64 = 1_000;
const MINTED: i128 = 100_000_000;

/// Events emitted by the escrow contract itself (token transfer events excluded).
fn escrow_events(
    env: &Env,
    contract_id: &Address,
) -> soroban_sdk::Vec<(Address, soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val)> {
    let mut out = vec![env];
    for e in env.events().all().iter() {
        if e.0 == *contract_id {
            out.push_back(e);
        }
    }
    out
}

/// Register a Stellar asset contract and mint `MINTED` units to `holder`.
fn new_token(env: &Env, holder: &Address) -> Address {
    let issuer = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    token::StellarAssetClient::new(env, &token).mint(holder, &MINTED);
    token
}

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
    let token = new_token(&env, &lender);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &7, &5_000_000);
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
    let token = new_token(&env, &lender);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &12, &8_000_000);
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
    let token = new_token(&env, &lender);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &13, &8_000_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at);
    client.revoke_hold(&lender, &escrow_id);
}

#[test]
fn test_confirm_disbursement_succeeds_at_exact_expiry() {
    let (env, contract_id, admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &99, &9_500_000);
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
    let token = new_token(&env, &lender);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &100, &9_500_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at - 1);
    client.confirm_disbursement(&admin, &escrow_id);
}

#[test]
fn test_create_hold_sets_expected_expiry_window() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &5, &1_000_000);
    let hold = client.get_hold(&escrow_id);

    assert_eq!(hold.held_at, START_TIMESTAMP);
    assert_eq!(hold.expires_at, START_TIMESTAMP + WINDOW_SECONDS);
    assert_eq!(hold.status, EscrowStatus::Held);
}

#[test]
fn test_deposit_and_withdraw_emit_events() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    let pool_id = 42u32;
    let amount = 5_000_000i128;

    let escrow_id = client.create_hold(&lender, &borrower, &token, &pool_id, &amount);

    assert_eq!(
        escrow_events(&env, &contract_id),
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
        escrow_events(&env, &contract_id),
        vec![
            &env,
            (
                contract_id,
                (symbol_short!("escrow"), symbol_short!("withdraw")).into_val(&env),
                (lender, pool_id, amount).into_val(&env),
            ),
        ]
    );
}

// ─── Pausable / Multi-sig tests ──────────────────────────────────────────────

fn setup_with_multisig() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIMESTAMP);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let signer1 = Address::generate(&env);

    client.initialize(&admin);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1.clone()];
    client.setup_multisig(&admin, &admins, &2);

    (env, contract_id, admin, lender, borrower, signer1)
}

#[test]
fn test_escrow_setup_multisig() {
    let (env, contract_id, admin, _lender, _borrower, signer1) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    let admins = client.get_multisig_admins();
    assert_eq!(admins.len(), 2);
    assert!(admins.iter().any(|a| a == admin));
    assert!(admins.iter().any(|a| a == signer1));
    assert_eq!(client.get_multisig_threshold(), 2);
    assert!(!client.is_paused());
}

#[test]
fn test_escrow_pause_activates_with_threshold() {
    let (env, contract_id, admin, _lender, _borrower, signer1) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    assert!(!client.is_paused());

    client.pause(&admin);
    assert!(!client.is_paused());

    client.pause(&signer1);
    assert!(client.is_paused());
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_escrow_create_hold_blocked_when_paused() {
    let (env, contract_id, admin, lender, borrower, signer1) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    client.pause(&admin);
    client.pause(&signer1);

    client.create_hold(&lender, &borrower, &token, &1, &5_000_000);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_escrow_confirm_disbursement_blocked_when_paused() {
    let (env, contract_id, admin, lender, borrower, signer1) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    // Create a hold while unpaused
    let escrow_id = client.create_hold(&lender, &borrower, &token, &7, &5_000_000);
    let hold = client.get_hold(&escrow_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // Move time past the revocation window
    env.ledger().set_timestamp(hold.expires_at);
    client.confirm_disbursement(&admin, &escrow_id);
}

#[test]
fn test_escrow_revoke_hold_allowed_when_paused() {
    let (env, contract_id, admin, lender, borrower, signer1) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    // Create a hold while unpaused
    let escrow_id = client.create_hold(&lender, &borrower, &token, &7, &5_000_000);
    let hold = client.get_hold(&escrow_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // Revoke should still work (lender protecting their funds)
    env.ledger().set_timestamp(hold.expires_at - 1);
    client.revoke_hold(&lender, &escrow_id);

    let updated = client.get_hold(&escrow_id);
    assert_eq!(updated.status, EscrowStatus::Revoked);
}

#[test]
fn test_escrow_unpause_restores_operations() {
    let (env, contract_id, admin, lender, borrower, signer1) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    // Unpause
    client.unpause(&admin);
    client.unpause(&signer1);
    assert!(!client.is_paused());

    // Create hold should work again
    let escrow_id = client.create_hold(&lender, &borrower, &token, &7, &5_000_000);
    let hold = client.get_hold(&escrow_id);
    assert_eq!(hold.status, EscrowStatus::Held);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_escrow_non_admin_cannot_pause() {
    let (env, contract_id, _admin, _lender, _borrower, _signer1) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.pause(&random);
}

// --- Token custody tests -----------------------------------------------------

#[test]
fn test_create_hold_moves_tokens_into_escrow() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);
    let tc = token::Client::new(&env, &token);

    let amount = 5_000_000i128;
    let escrow_id = client.create_hold(&lender, &borrower, &token, &1, &amount);

    assert_eq!(tc.balance(&lender), MINTED - amount);
    assert_eq!(tc.balance(&contract_id), amount);
    assert_eq!(client.get_hold(&escrow_id).token, token);
}

#[test]
fn test_balance_matches_active_holds() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);
    let tc = token::Client::new(&env, &token);

    client.create_hold(&lender, &borrower, &token, &1, &2_000_000);
    let second = client.create_hold(&lender, &borrower, &token, &2, &3_000_000);
    assert_eq!(tc.balance(&contract_id), 5_000_000);

    env.ledger().set_timestamp(START_TIMESTAMP + 1);
    client.revoke_hold(&lender, &second);
    assert_eq!(tc.balance(&contract_id), 2_000_000);
}

#[test]
fn test_revoke_hold_refunds_lender() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);
    let tc = token::Client::new(&env, &token);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &1, &5_000_000);
    client.revoke_hold(&lender, &escrow_id);

    assert_eq!(tc.balance(&lender), MINTED);
    assert_eq!(tc.balance(&contract_id), 0);
    assert_eq!(tc.balance(&borrower), 0);
}

#[test]
fn test_confirm_disbursement_pays_borrower() {
    let (env, contract_id, admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);
    let tc = token::Client::new(&env, &token);

    let amount = 5_000_000i128;
    let escrow_id = client.create_hold(&lender, &borrower, &token, &1, &amount);
    env.ledger().set_timestamp(START_TIMESTAMP + WINDOW_SECONDS);
    client.confirm_disbursement(&admin, &escrow_id);

    assert_eq!(tc.balance(&borrower), amount);
    assert_eq!(tc.balance(&contract_id), 0);
    assert_eq!(tc.balance(&lender), MINTED - amount);
}

#[test]
#[should_panic]
fn test_create_hold_fails_without_funds() {
    let (env, contract_id, _admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    // More than the lender owns: nothing can be fabricated without custody.
    client.create_hold(&lender, &borrower, &token, &1, &(MINTED + 1));
}

#[test]
#[should_panic(expected = "Hold is not in HELD state")]
fn test_disbursed_hold_cannot_be_revoked() {
    let (env, contract_id, admin, lender, borrower) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token = new_token(&env, &lender);

    let escrow_id = client.create_hold(&lender, &borrower, &token, &1, &5_000_000);
    env.ledger().set_timestamp(START_TIMESTAMP + WINDOW_SECONDS);
    client.confirm_disbursement(&admin, &escrow_id);
    client.revoke_hold(&lender, &escrow_id);
}
