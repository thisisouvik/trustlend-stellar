#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env};

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let insurance_token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let contract_id = env.register(DefaultManagementContract, (&admin, &insurance_token));
    token::StellarAssetClient::new(&env, &insurance_token).mint(&contract_id, &10_000_000);
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::InsuranceBalance, &10_000_000_i128);
    });

    (env, contract_id, admin)
}



fn setup_with_multisig() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let borrower = Address::generate(&env);

    let insurance_token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let contract_id = env.register(DefaultManagementContract, (&admin, &insurance_token));
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1.clone()];
    client.setup_multisig(&admin, &admins, &2);
    token::StellarAssetClient::new(&env, &insurance_token).mint(&admin, &100_000_000);
    client.add_to_insurance(&admin, &10_000_000);

    (env, contract_id, admin, signer1, borrower)
}

/// `setup()` plus a linked MultiSigAdmin contract (an address standing in for
/// the deployed `multisig_admin` contract). Returns (env, contract_id, admin, multisig).
fn setup_with_linked_multisig() -> (Env, Address, Address, Address) {
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let multisig = Address::generate(&env);
    client.set_multisig_admin(&admin, &multisig);

    (env, contract_id, admin, multisig)
}

// ─── Basic tests ─────────────────────────────────────────────────────────────

#[test]
fn test_basic_initialization() {
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_insurance_balance(), 10_000_000);
    assert_eq!(token::Client::new(&env, &client.get_insurance_token()).balance(&contract_id), 10_000_000);
}

#[test]
fn test_record_default() {
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let borrower = Address::generate(&env);
    let phase = client.record_default(&admin, &1, &borrower, &1_000_000, &5);
    assert_eq!(phase, DefaultPhase::Friendly);

    let record = client.get_default_record(&1);
    assert_eq!(record.loan_id, 1);
    assert_eq!(record.phase, DefaultPhase::Friendly);
}

#[test]
fn test_insurance_payout() {
    let (env, contract_id, _admin, multisig) = setup_with_linked_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&multisig, &1, &lender, &5_000_000);

    assert_eq!(client.get_insurance_balance(), 5_000_000);
    assert_eq!(token::Client::new(&env, &client.get_insurance_token()).balance(&lender), 5_000_000);
    assert_eq!(token::Client::new(&env, &client.get_insurance_token()).balance(&contract_id), 5_000_000);
    assert_eq!(client.get_insurance_event_count(), 1);
    let event = client.get_insurance_event(&1);
    assert_eq!(event.loan_id, 1);
    assert_eq!(event.lender, lender);
    assert_eq!(event.amount_paid, 5_000_000);
}

#[test]
#[should_panic(expected = "Insurance deposit must be positive")]
fn test_insurance_deposit_rejects_zero_amount() {
    let (env, contract_id, admin, _signer1, _borrower) = setup_with_multisig();
    DefaultManagementContractClient::new(&env, &contract_id).add_to_insurance(&admin, &0);
}

#[test]
#[should_panic(expected = "Insurance payout must be positive")]
fn test_insurance_payout_rejects_negative_amount() {
    let (env, contract_id, _admin, multisig) = setup_with_linked_multisig();
    let lender = Address::generate(&env);
    DefaultManagementContractClient::new(&env, &contract_id)
        .trigger_insurance_payout(&multisig, &1, &lender, &-1);
}

#[test]
#[should_panic(expected = "Insufficient insurance funds")]
fn test_insurance_payout_insufficient_funds() {
    let (env, contract_id, _admin, multisig) = setup_with_linked_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&multisig, &1, &lender, &20_000_000);
}

// ─── Insurance payout authorization (issue #353) ─────────────────────────────

#[test]
#[should_panic(expected = "Multisig not configured")]
fn test_single_admin_cannot_trigger_payout_without_multisig() {
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&admin, &1, &lender, &5_000_000);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not the linked multisig admin contract")]
fn test_single_admin_cannot_trigger_payout_after_multisig_linked() {
    let (env, contract_id, admin, _multisig) = setup_with_linked_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&admin, &1, &lender, &5_000_000);
}

#[test]
fn test_single_admin_payout_attempt_leaves_fund_untouched() {
    let (env, contract_id, admin, _multisig) = setup_with_linked_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    let res = client.try_trigger_insurance_payout(&admin, &1, &lender, &5_000_000);
    assert!(res.is_err());
    assert_eq!(client.get_insurance_balance(), 10_000_000);
    assert_eq!(client.get_insurance_event_count(), 0);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not the linked multisig admin contract")]
fn test_single_admin_cannot_regain_payout_rights_via_setup_multisig() {
    let (env, contract_id, admin, _multisig) = setup_with_linked_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    // setup_multisig always re-adds the admin to the multisig-admin list; it
    // must not reopen the insurance fund to the single admin key.
    client.setup_multisig(&admin, &soroban_sdk::vec![&env, admin.clone()], &1);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&admin, &1, &lender, &5_000_000);
}

#[test]
fn test_linked_multisig_keeps_payout_rights_after_setup_multisig() {
    let (env, contract_id, admin, multisig) = setup_with_linked_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    client.setup_multisig(&admin, &soroban_sdk::vec![&env, admin.clone()], &1);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&multisig, &1, &lender, &5_000_000);
    assert_eq!(client.get_insurance_balance(), 5_000_000);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not the linked multisig admin contract")]
fn test_single_admin_cannot_add_to_insurance_after_multisig_linked() {
    let (env, contract_id, admin, _multisig) = setup_with_linked_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    client.add_to_insurance(&admin, &1_000_000);
}

// ─── Pausable / Multi-sig tests ──────────────────────────────────────────────

#[test]
fn test_def_setup_multisig() {
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let admins = client.get_multisig_admins();
    assert_eq!(admins.len(), 2);
    assert!(admins.iter().any(|a| a == admin));
    assert!(admins.iter().any(|a| a == signer1));
    assert_eq!(client.get_multisig_threshold(), 2);
    assert!(!client.is_paused());
}

#[test]
fn test_def_pause_activates_with_threshold() {
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    assert!(!client.is_paused());

    client.pause(&admin);
    assert!(!client.is_paused());

    client.pause(&signer1);
    assert!(client.is_paused());
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_def_record_default_blocked_when_paused() {
    let (env, contract_id, admin, signer1, borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.record_default(&admin, &1, &borrower, &1_000_000, &5);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_def_insurance_payout_blocked_when_paused() {
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&admin, &1, &lender, &5_000_000);
}

#[test]
fn test_def_add_to_insurance_allowed_when_paused() {
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // Admin should still be able to add to insurance (emergency funding)
    client.add_to_insurance(&admin, &2_000_000);
    assert_eq!(client.get_insurance_balance(), 12_000_000);
}

#[test]
fn test_def_unpause_restores_operations() {
    let (env, contract_id, admin, signer1, borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    // Unpause
    client.unpause(&admin);
    client.unpause(&signer1);
    assert!(!client.is_paused());

    // record_default should work again
    let phase = client.record_default(&admin, &1, &borrower, &1_000_000, &5);
    assert_eq!(phase, DefaultPhase::Friendly);
}

#[test]
#[should_panic(expected = "Contract is not paused")]
fn test_def_unpause_when_not_paused_rejected() {
    let (env, contract_id, admin, _signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    client.unpause(&admin);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_def_non_admin_cannot_pause() {
    let (env, contract_id, _admin, _signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.pause(&random);
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_def_duplicate_pause_signer_rejected() {
    let (env, contract_id, admin, _signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&admin);
}

#[test]
#[should_panic(expected = "Signer has already authorised unpause")]
fn test_def_duplicate_unpause_signer_rejected() {
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    // Pause first
    client.pause(&admin);
    client.pause(&signer1);

    // Unpause duplicate
    client.unpause(&admin);
    client.unpause(&admin);
}

#[test]
fn test_def_pause_threshold_count_tracking() {
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    assert_eq!(client.get_pause_signer_count(), 0);

    client.pause(&admin);
    assert_eq!(client.get_pause_signer_count(), 1);

    client.pause(&signer1);
    assert_eq!(client.get_pause_signer_count(), 0); // reset after activation
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
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

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
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

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
    let (env, contract_id, admin, signer1, _borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

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

/// Issue #352: initialization runs in the Soroban constructor, atomically with
/// deployment. There is no `initialize` entrypoint left to front-run, and the
/// constructor cannot be re-invoked on the live contract to seize admin rights.
#[test]
fn test_constructor_initializes_and_cannot_be_reinvoked() {
    use soroban_sdk::{IntoVal, Symbol};
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);
    assert_eq!(client.get_admin(), admin);
    let attacker = Address::generate(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        attacker.into_val(&env),
        client.get_insurance_token().into_val(&env),
    ];
    for name in ["initialize", "__constructor"] {
        let res = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &contract_id,
            &Symbol::new(&env, name),
            args.clone(),
        );
        assert!(res.is_err(), "{name} must not be callable after deployment");
    }
    let stored: Address = env.as_contract(&contract_id, || {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    });
    assert_eq!(stored, admin);
}
