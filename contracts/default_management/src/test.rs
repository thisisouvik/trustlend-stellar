#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DefaultManagementContract, ());
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin, &10_000_000);

    (env, contract_id, admin)
}



fn setup_with_multisig() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DefaultManagementContract, ());
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin, &10_000_000);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1.clone()];
    client.setup_multisig(&admin, &admins, &2);

    (env, contract_id, admin, signer1, borrower)
}

// ─── Basic tests ─────────────────────────────────────────────────────────────

#[test]
fn test_basic_initialization() {
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_insurance_balance(), 10_000_000);
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
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&admin, &1, &lender, &5_000_000);

    assert_eq!(client.get_insurance_balance(), 5_000_000);
}

#[test]
#[should_panic(expected = "Insufficient insurance funds")]
fn test_insurance_payout_insufficient_funds() {
    let (env, contract_id, admin) = setup();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    client.trigger_insurance_payout(&admin, &1, &lender, &20_000_000);
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

#[test]
fn test_def_pause_unpause_multiple_cycles_clears_signers() {
    let (env, contract_id, admin, signer1, borrower) = setup_with_multisig();
    let client = DefaultManagementContractClient::new(&env, &contract_id);

    // Cycle 1: pause -> unpause
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    client.unpause(&admin);
    client.unpause(&signer1);
    assert!(!client.is_paused());

    // Cycle 2: same signers can pause and unpause again
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    client.unpause(&admin);
    client.unpause(&signer1);
    assert!(!client.is_paused());

    let phase = client.record_default(&admin, &1, &borrower, &1_000_000, &5);
    assert_eq!(phase, DefaultPhase::Friendly);
}

