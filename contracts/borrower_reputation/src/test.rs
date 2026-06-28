#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Env};

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

// ─── Oracle integration tests ─────────────────────────────────────────────────

/// Setup that also registers an authorized oracle.
fn setup_with_oracle() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(BorrowerReputationContract, ());
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    client.set_oracle(&admin, &oracle);
    client.init_borrower(&borrower);

    (env, contract_id, admin, oracle, borrower)
}

#[test]
fn test_set_and_get_oracle() {
    let (env, contract_id, _admin, oracle, _borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    assert_eq!(client.get_oracle(), oracle);
}

#[test]
fn test_oracle_score_boosts_max_loan() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Base (None tier) limit = 1,000 XLM.
    assert_eq!(client.calculate_max_loan(&borrower), 10_000_000_000);

    // Oracle posts a max score (1000) → +100 % boost → limit doubles.
    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "mobile-money"),
    );

    let data = client.get_oracle_data(&borrower);
    assert_eq!(data.credit_score, 1000);
    assert_eq!(data.loan_limit_boost_bps, 10_000);
    assert_eq!(data.data_sources, 3);

    assert_eq!(client.calculate_max_loan(&borrower), 20_000_000_000);
    // Interest rate is unaffected by oracle data.
    assert_eq!(client.calculate_interest_rate(&borrower), 1500);
}

#[test]
fn test_oracle_score_partial_boost() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // score 500 → +50 % boost on 1,000 XLM base → 1,500 XLM.
    client.submit_credit_score(
        &oracle,
        &borrower,
        &500,
        &2,
        &String::from_str(&env, "utility"),
    );
    assert_eq!(client.calculate_max_loan(&borrower), 15_000_000_000);
}

#[test]
fn test_stale_oracle_data_is_ignored() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "banking"),
    );
    assert_eq!(client.calculate_max_loan(&borrower), 20_000_000_000);

    // Advance ledger time beyond the 90-day validity window.
    env.ledger().set_timestamp(91 * 24 * 60 * 60);
    assert_eq!(client.calculate_max_loan(&borrower), 10_000_000_000);
}

#[test]
#[should_panic(expected = "not the registered oracle")]
fn test_non_oracle_cannot_submit() {
    let (env, contract_id, _admin, _oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let imposter = Address::generate(&env);
    client.submit_credit_score(
        &imposter,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "spoof"),
    );
}

#[test]
#[should_panic(expected = "exceeds MAX_ORACLE_SCORE")]
fn test_score_above_max_is_rejected() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.submit_credit_score(
        &oracle,
        &borrower,
        &1001,
        &3,
        &String::from_str(&env, "bad"),
    );
}

#[test]
#[should_panic(expected = "frozen account")]
fn test_cannot_submit_for_frozen_account() {
    let (env, contract_id, admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.freeze_account(&admin, &borrower, &String::from_str(&env, "fraud"));
    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "mobile-money"),
    );
}

#[test]
fn test_oracle_boost_stacks_on_tier_limit() {
    let (env, contract_id, admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Push borrower to Gold tier (base 10,000 XLM).
    for _ in 0..10 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    assert_eq!(client.calculate_max_loan(&borrower), 100_000_000_000);

    // +100 % oracle boost → 20,000 XLM.
    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "banking"),
    );
    assert_eq!(client.calculate_max_loan(&borrower), 200_000_000_000);
}
