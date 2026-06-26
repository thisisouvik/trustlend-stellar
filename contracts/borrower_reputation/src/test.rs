#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env};

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(BorrowerReputationContract, ());
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    client.init_borrower(&borrower);

    (env, contract_id, admin, borrower)
}

#[test]
fn test_initialization() {
    let env = Env::default();
    let contract_id = env.register(BorrowerReputationContract, ());
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_default_tier() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(BorrowerReputationContract, ());
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let borrower = Address::generate(&env);
    client.init_borrower(&borrower);

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 0);
    assert_eq!(profile.reputation_tier, ReputationTier::None);

    let max_loan = client.calculate_max_loan(&borrower);
    // Based on our None tier logic (score < 50 => max_loan = 10_000_000_000 stroops = 1000 XLM)
    assert_eq!(max_loan, 10_000_000_000); 

    let interest = client.calculate_interest_rate(&borrower);
    // Based on NO history logic => 1500 bps (15%)
    assert_eq!(interest, 1500);
}

#[test]
fn test_high_score_gets_better_rate_and_higher_limit() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    for _ in 0..10 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 500);
    assert_eq!(profile.reputation_tier, ReputationTier::Gold);

    assert_eq!(client.calculate_max_loan(&borrower), 100_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1000);
}

#[test]
fn test_low_score_stays_in_none_tier_with_base_terms() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::LoanLate1Day);
    client.add_reputation_event(&admin, &borrower, &ReputationEvent::LateWarning);

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 0);
    assert_eq!(profile.reputation_tier, ReputationTier::None);

    assert_eq!(client.calculate_max_loan(&borrower), 10_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1500);
}

#[test]
fn test_limits_scale_with_reputation_event_history() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 50);
    assert_eq!(profile.reputation_tier, ReputationTier::Beginner);
    assert_eq!(client.calculate_max_loan(&borrower), 20_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1300);

    for _ in 0..2 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 150);
    assert_eq!(profile.reputation_tier, ReputationTier::Silver);
    assert_eq!(client.calculate_max_loan(&borrower), 50_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1200);

    for _ in 0..7 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 500);
    assert_eq!(profile.reputation_tier, ReputationTier::Gold);
    assert_eq!(client.calculate_max_loan(&borrower), 100_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1000);

    for _ in 0..10 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 1000);
    assert_eq!(profile.reputation_tier, ReputationTier::Platinum);
    assert_eq!(client.calculate_max_loan(&borrower), 1_000_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 800);
}
