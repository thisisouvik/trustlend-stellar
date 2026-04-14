#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env};

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
