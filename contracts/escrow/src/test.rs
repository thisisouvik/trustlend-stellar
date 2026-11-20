#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    symbol_short, token, vec, Address, Env, IntoVal, Val, Vec,
};

const WINDOW_SECONDS: u64 = 180;
const START_TIMESTAMP: u64 = 1_000;
/// Balance minted to the lender in the test setups.
const LENDER_FUNDS: i128 = 100_000_000;

/// Register a real Stellar Asset Contract, allowlist it for escrow and fund
/// the lender, so holds move actual tokens (Issue #417).
fn setup_token(env: &Env, client: &EscrowContractClient, admin: &Address, lender: &Address) -> Address {
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    client.set_allowed_token(admin, &token, &true);
    token::StellarAssetClient::new(env, &token).mint(lender, &LENDER_FUNDS);
    token
}

fn setup() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIMESTAMP);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    let token = setup_token(&env, &client, &admin, &lender);

    (env, contract_id, admin, lender, borrower, token)
}

#[test]
fn test_revocation_window_is_open_until_exact_expiry() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &7, &token, &5_000_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at - 1);
    assert!(client.is_within_revocation_window(&escrow_id));

    env.ledger().set_timestamp(hold.expires_at);
    assert!(!client.is_within_revocation_window(&escrow_id));
}

#[test]
fn test_revoke_hold_succeeds_before_expiry() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &12, &token, &8_000_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at - 1);
    client.revoke_hold(&lender, &escrow_id);

    let updated = client.get_hold(&escrow_id);
    assert_eq!(updated.status, EscrowStatus::Revoked);
}

#[test]
#[should_panic(expected = "Revocation window has expired")]
fn test_revoke_hold_fails_at_exact_expiry() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &13, &token, &8_000_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at);
    client.revoke_hold(&lender, &escrow_id);
}

#[test]
fn test_confirm_disbursement_succeeds_at_exact_expiry() {
    let (env, contract_id, admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &99, &token, &9_500_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at);
    client.confirm_disbursement(&admin, &escrow_id);

    let updated = client.get_hold(&escrow_id);
    assert_eq!(updated.status, EscrowStatus::Transferred);
}

#[test]
#[should_panic(expected = "Revocation window has not expired yet")]
fn test_confirm_disbursement_fails_before_expiry() {
    let (env, contract_id, admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &100, &token, &9_500_000);
    let hold = client.get_hold(&escrow_id);

    env.ledger().set_timestamp(hold.expires_at - 1);
    client.confirm_disbursement(&admin, &escrow_id);
}

#[test]
fn test_create_hold_sets_expected_expiry_window() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &5, &token, &1_000_000);
    let hold = client.get_hold(&escrow_id);

    assert_eq!(hold.held_at, START_TIMESTAMP);
    assert_eq!(hold.expires_at, START_TIMESTAMP + WINDOW_SECONDS);
    assert_eq!(hold.status, EscrowStatus::Held);
}

/// Events emitted by the escrow contract itself in the last invocation,
/// leaving out the token contract's own `transfer` events.
fn escrow_events(env: &Env, contract_id: &Address) -> Vec<(Address, Vec<Val>, Val)> {
    let mut out = Vec::new(env);
    for event in env.events().all().iter() {
        if event.0 == *contract_id {
            out.push_back(event);
        }
    }
    out
}

#[test]
fn test_deposit_and_withdraw_emit_events() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let pool_id = 42u32;
    let amount = 5_000_000i128;

    let escrow_id = client.create_hold(&lender, &borrower, &pool_id, &token, &amount);

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

fn setup_with_multisig() -> (Env, Address, Address, Address, Address, Address, Address) {
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
    let token = setup_token(&env, &client, &admin, &lender);

    (env, contract_id, admin, lender, borrower, signer1, token)
}

#[test]
fn test_escrow_setup_multisig() {
    let (env, contract_id, admin, _lender, _borrower, signer1, _token) = setup_with_multisig();
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
    let (env, contract_id, admin, _lender, _borrower, signer1, _token) = setup_with_multisig();
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
    let (env, contract_id, admin, lender, borrower, signer1, token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.create_hold(&lender, &borrower, &1, &token, &5_000_000);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_escrow_confirm_disbursement_blocked_when_paused() {
    let (env, contract_id, admin, lender, borrower, signer1, token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    // Create a hold while unpaused
    let escrow_id = client.create_hold(&lender, &borrower, &7, &token, &5_000_000);
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
    let (env, contract_id, admin, lender, borrower, signer1, token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    // Create a hold while unpaused
    let escrow_id = client.create_hold(&lender, &borrower, &7, &token, &5_000_000);
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
    let (env, contract_id, admin, lender, borrower, signer1, token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    // Unpause
    client.unpause(&admin);
    client.unpause(&signer1);
    assert!(!client.is_paused());

    // Create hold should work again
    let escrow_id = client.create_hold(&lender, &borrower, &7, &token, &5_000_000);
    let hold = client.get_hold(&escrow_id);
    assert_eq!(hold.status, EscrowStatus::Held);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_escrow_non_admin_cannot_pause() {
    let (env, contract_id, _admin, _lender, _borrower, _signer1, _token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.pause(&random);
}

// ─── On-chain token custody (Issue #417) ─────────────────────────────────────

/// Asserts the escrow's token balance equals its recorded commitments.
fn assert_custody_matches(env: &Env, client: &EscrowContractClient, contract_id: &Address, token: &Address, expected: i128) {
    assert_eq!(client.get_total_held(token), expected);
    assert_eq!(token::Client::new(env, token).balance(contract_id), expected);
}

#[test]
fn test_create_hold_takes_custody_of_lender_tokens() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token);

    let escrow_id = client.create_hold(&lender, &borrower, &1, &token, &5_000_000);

    assert_eq!(token_client.balance(&lender), LENDER_FUNDS - 5_000_000);
    assert_eq!(token_client.balance(&borrower), 0);
    assert_custody_matches(&env, &client, &contract_id, &token, 5_000_000);
    assert_eq!(client.get_hold(&escrow_id).token, token);
}

#[test]
fn test_revoke_hold_returns_tokens_to_lender() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token);

    let escrow_id = client.create_hold(&lender, &borrower, &1, &token, &5_000_000);
    client.revoke_hold(&lender, &escrow_id);

    assert_eq!(token_client.balance(&lender), LENDER_FUNDS);
    assert_eq!(token_client.balance(&borrower), 0);
    assert_custody_matches(&env, &client, &contract_id, &token, 0);
}

#[test]
fn test_confirm_disbursement_transfers_tokens_to_borrower() {
    let (env, contract_id, admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token);

    let escrow_id = client.create_hold(&lender, &borrower, &1, &token, &5_000_000);
    env.ledger().set_timestamp(client.get_hold(&escrow_id).expires_at);
    client.confirm_disbursement(&admin, &escrow_id);

    assert_eq!(token_client.balance(&borrower), 5_000_000);
    assert_eq!(token_client.balance(&lender), LENDER_FUNDS - 5_000_000);
    assert_custody_matches(&env, &client, &contract_id, &token, 0);
}

/// A hold cannot be fabricated: a lender without the funds cannot create
/// one, and nothing is recorded.
#[test]
fn test_create_hold_without_funds_fails() {
    let (env, contract_id, _admin, _lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let broke_lender = Address::generate(&env);

    let result = client.try_create_hold(&broke_lender, &borrower, &1, &token, &5_000_000);

    assert!(result.is_err());
    assert_eq!(client.get_escrow_count(), 0);
    assert_custody_matches(&env, &client, &contract_id, &token, 0);
}

/// A lender cannot escrow more than they hold.
#[test]
fn test_create_hold_above_lender_balance_fails() {
    let (env, contract_id, _admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_hold(&lender, &borrower, &1, &token, &(LENDER_FUNDS + 1));

    assert!(result.is_err());
    assert_eq!(client.get_escrow_count(), 0);
    assert_eq!(token::Client::new(&env, &token).balance(&lender), LENDER_FUNDS);
}

/// Holds can only be backed by allowlisted tokens, not any self-minted one.
#[test]
#[should_panic(expected = "Token is not allowed for escrow")]
fn test_create_hold_rejects_token_not_allowed() {
    let (env, contract_id, _admin, lender, borrower, _token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let junk = env
        .register_stellar_asset_contract_v2(lender.clone())
        .address();
    token::StellarAssetClient::new(&env, &junk).mint(&lender, &5_000_000);

    client.create_hold(&lender, &borrower, &1, &junk, &5_000_000);
}

#[test]
fn test_set_allowed_token_non_admin_rejected() {
    let (env, contract_id, _admin, lender, _borrower, _token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);
    let other = Address::generate(&env);

    assert!(client.try_set_allowed_token(&lender, &other, &true).is_err());
    assert!(!client.is_token_allowed(&other));
}

/// Removing a token from the allowlist never strands funds already held.
#[test]
fn test_disallowing_token_keeps_existing_holds_releasable() {
    let (env, contract_id, admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &1, &token, &5_000_000);
    client.set_allowed_token(&admin, &token, &false);
    assert!(!client.is_token_allowed(&token));

    client.revoke_hold(&lender, &escrow_id);
    assert_eq!(token::Client::new(&env, &token).balance(&lender), LENDER_FUNDS);
}

/// A revoked (refunded) hold can never also be disbursed.
#[test]
#[should_panic(expected = "Hold is not in HELD state")]
fn test_revoked_hold_cannot_be_disbursed() {
    let (env, contract_id, admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_hold(&lender, &borrower, &1, &token, &5_000_000);
    client.revoke_hold(&lender, &escrow_id);

    env.ledger().set_timestamp(client.get_hold(&escrow_id).expires_at);
    client.confirm_disbursement(&admin, &escrow_id);
}

/// Across many holds, the contract's balance always equals the sum of the
/// commitments still in the `Held` state.
#[test]
fn test_custody_balance_matches_active_commitments() {
    let (env, contract_id, admin, lender, borrower, token) = setup();
    let client = EscrowContractClient::new(&env, &contract_id);

    let a = client.create_hold(&lender, &borrower, &1, &token, &1_000_000);
    let b = client.create_hold(&lender, &borrower, &2, &token, &2_000_000);
    let c = client.create_hold(&lender, &borrower, &3, &token, &4_000_000);
    assert_custody_matches(&env, &client, &contract_id, &token, 7_000_000);

    client.revoke_hold(&lender, &a);
    assert_custody_matches(&env, &client, &contract_id, &token, 6_000_000);

    env.ledger().set_timestamp(client.get_hold(&b).expires_at);
    client.confirm_disbursement(&admin, &b);
    assert_custody_matches(&env, &client, &contract_id, &token, 4_000_000);

    assert_eq!(client.get_hold(&c).status, EscrowStatus::Held);
    let token_client = token::Client::new(&env, &token);
    assert_eq!(token_client.balance(&borrower), 2_000_000);
    assert_eq!(token_client.balance(&lender), LENDER_FUNDS - 6_000_000);
}

// ─── Repeated pause / unpause cycles (issue #354) ────────────────────────────

fn pause_cycle_unpause_count(env: &Env, contract_id: &Address) -> u32 {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::UnpauseSignerCount)
            .unwrap_or(0)
    })
}

fn pause_cycle_has_entry(env: &Env, contract_id: &Address, key: DataKey) -> bool {
    env.as_contract(contract_id, || env.storage().instance().has(&key))
}

#[test]
fn test_pause_cycles_repeat_with_same_signers() {
    let (env, contract_id, admin, _lender, _borrower, signer1, _token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    for cycle in 0..3u32 {
        client.pause(&admin);
        assert!(!client.is_paused(), "cycle {cycle}: one approval must not pause");
        client.pause(&signer1);
        assert!(client.is_paused(), "cycle {cycle}: threshold reached");
        assert_eq!(client.get_pause_signer_count(), 0);

        client.unpause(&signer1);
        assert!(client.is_paused(), "cycle {cycle}: one approval must not unpause");
        client.unpause(&admin);
        assert!(!client.is_paused(), "cycle {cycle}: threshold reached");
        assert_eq!(pause_cycle_unpause_count(&env, &contract_id), 0);
    }

    // Completed rounds leave no per-signer approvals behind in storage.
    for round in 0..3u32 {
        for signer in [&admin, &signer1] {
            let pause_key = DataKey::PauseSigner(signer.clone(), round);
            let unpause_key = DataKey::UnpauseSigner(signer.clone(), round);
            assert!(!pause_cycle_has_entry(&env, &contract_id, pause_key));
            assert!(!pause_cycle_has_entry(&env, &contract_id, unpause_key));
        }
    }
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_pause_cycles_dedup_still_enforced_within_a_round() {
    let (env, contract_id, admin, _lender, _borrower, signer1, _token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    // One full cycle, then a signer tries to approve the next pause twice.
    client.pause(&admin);
    client.pause(&signer1);
    client.unpause(&admin);
    client.unpause(&signer1);

    client.pause(&admin);
    client.pause(&admin);
}

#[test]
fn test_pause_cycles_setup_multisig_clears_partial_approvals() {
    let (env, contract_id, admin, _lender, _borrower, signer1, _token) = setup_with_multisig();
    let client = EscrowContractClient::new(&env, &contract_id);

    client.pause(&admin);
    assert_eq!(client.get_pause_signer_count(), 1);

    // Reconfiguring the signer set starts a fresh round: the stale approval
    // neither blocks `admin` nor counts toward the new threshold.
    client.setup_multisig(&admin, &soroban_sdk::vec![&env, admin.clone(), signer1.clone()], &2);
    assert_eq!(client.get_pause_signer_count(), 0);

    client.pause(&admin);
    assert!(!client.is_paused());
    client.pause(&signer1);
    assert!(client.is_paused());
}
