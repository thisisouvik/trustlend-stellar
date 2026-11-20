#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Env};

fn default_config() -> RewardConfig {
    RewardConfig {
        base_amount: 1_000_0000,               // 1 TLEND (7 decimals)
        reference_loan_amount: 10_000_0000000, // 10_000 XLM
        max_duration_multiplier_bps: 10_000,   // 1.0x cap (30 days = 1.0x)
        tier_none_multiplier_bps: 5_000,       // 0.5x
        tier_beginner_multiplier_bps: 10_000,  // 1x
        tier_silver_multiplier_bps: 15_000,    // 1.5x
        tier_gold_multiplier_bps: 20_000,      // 2x
        tier_platinum_multiplier_bps: 30_000,  // 3x
    }
}

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let lending = Address::generate(&env);
    let borrower = Address::generate(&env);

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(
        BorrowerLoyaltyContract,
        (&admin, &token_id, &lending, default_config()),
    );

    // Fund the loyalty contract with tokens
    let token_admin_client = token::StellarAssetClient::new(&env, &token_id);
    token_admin_client.mint(&contract_id, &1_000_000_0000000);

    (env, contract_id, admin, lending, borrower)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let lending = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(
        BorrowerLoyaltyContract,
        (&admin, &token_id, &lending, default_config()),
    );
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_reward_token(), token_id);
    assert_eq!(client.get_lending_contract(), lending);
    assert_eq!(client.get_total_rewards_distributed(), 0);
}

/// Issue #352: initialization runs in the Soroban constructor, atomically with
/// deployment. There is no `initialize` entrypoint left to front-run, and the
/// constructor cannot be re-invoked on the live contract to seize admin rights.
#[test]
fn test_constructor_initializes_and_cannot_be_reinvoked() {
    use soroban_sdk::{IntoVal, Symbol};
    let (env, contract_id, admin, lending, _borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);
    assert_eq!(client.get_admin(), admin);
    let token = client.get_reward_token();
    let attacker = Address::generate(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        attacker.into_val(&env),
        token.into_val(&env),
        lending.into_val(&env),
        default_config().into_val(&env),
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

#[test]
fn test_eligible_borrower_receives_rewards() {
    let (env, contract_id, _admin, lending, borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    let reward = client.distribute_reward(
        &lending,
        &borrower,
        &10_000_0000000i128, // 10_000 XLM
        &30,                 // 30 days
        &4,                  // Platinum tier
    );

    assert!(reward > 0, "Reward should be positive");

    let cumulative = client.get_borrower_rewards(&borrower);
    assert_eq!(cumulative, reward);

    let total = client.get_total_rewards_distributed();
    assert_eq!(total, reward);
}

#[test]
fn test_reward_calculation_correctness() {
    let (env, contract_id, _admin, lending, borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    // Platinum tier (4), 10_000 XLM, 30 days
    // base_amount = 1 TLEND
    // size_multiplier = 10_000 / 10_000 = 1.0x = 10_000 bps
    // duration_multiplier = 30/30 = 1.0x = 10_000 bps
    // tier_multiplier = 3.0x = 30_000 bps
    // reward = 1 * 10000/10000 * 10000/10000 * 30000/10000 = 3 TLEND
    let reward = client.distribute_reward(
        &lending,
        &borrower,
        &10_000_0000000i128, // 10_000 XLM
        &30,                 // 30 days
        &4,                  // Platinum
    );

    // 1_000_0000 * (10_000/10_000) * (10_000/10_000) * (30_000/10_000) = 3_000_0000
    assert_eq!(reward, 3_000_0000, "Platinum reward should be 3 TLEND");

    let view_reward = client.calculate_reward_view(&10_000_0000000i128, &30, &4);
    assert_eq!(view_reward, 3_000_0000);
}

#[test]
fn test_different_tiers_receive_different_rewards() {
    let (env, contract_id, _admin, lending, _borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    let borrower_none = Address::generate(&env);
    let borrower_beginner = Address::generate(&env);
    let borrower_silver = Address::generate(&env);
    let borrower_gold = Address::generate(&env);
    let borrower_platinum = Address::generate(&env);

    let none_reward = client.distribute_reward(&lending, &borrower_none, &10_000_0000000, &30, &0);
    let beginner_reward =
        client.distribute_reward(&lending, &borrower_beginner, &10_000_0000000, &30, &1);
    let silver_reward =
        client.distribute_reward(&lending, &borrower_silver, &10_000_0000000, &30, &2);
    let gold_reward = client.distribute_reward(&lending, &borrower_gold, &10_000_0000000, &30, &3);
    let platinum_reward =
        client.distribute_reward(&lending, &borrower_platinum, &10_000_0000000, &30, &4);

    // Tier multipliers: None=0.5x, Beginner=1x, Silver=1.5x, Gold=2x, Platinum=3x
    // Base=1 TLEND, same size/time → rewards scale by tier
    assert!(none_reward < beginner_reward, "None < Beginner");
    assert!(beginner_reward < silver_reward, "Beginner < Silver");
    assert!(silver_reward < gold_reward, "Silver < Gold");
    assert!(gold_reward < platinum_reward, "Gold < Platinum");

    // None: 1 * 1.0 * 1.0 * 0.5 = 0.5 TLEND
    assert_eq!(none_reward, 5_000_000);
    // Beginner: 1 * 1.0 * 1.0 * 1.0 = 1 TLEND
    assert_eq!(beginner_reward, 1_000_0000);
    // Silver: 1 * 1.0 * 1.0 * 1.5 = 1.5 TLEND
    assert_eq!(silver_reward, 1_500_0000);
    // Gold: 1 * 1.0 * 1.0 * 2.0 = 2 TLEND
    assert_eq!(gold_reward, 2_000_0000);
    // Platinum: 1 * 1.0 * 1.0 * 3.0 = 3 TLEND
    assert_eq!(platinum_reward, 3_000_0000);
}

#[test]
fn test_unauthorized_caller_gets_zero() {
    let (env, contract_id, _admin, _lending, borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    let attacker = Address::generate(&env);

    let reward = client.distribute_reward(&attacker, &borrower, &10_000_0000000, &30, &4);

    assert_eq!(reward, 0, "Unauthorized caller should return 0");
    assert_eq!(
        client.get_borrower_rewards(&borrower),
        0,
        "No reward recorded"
    );
    assert_eq!(
        client.get_total_rewards_distributed(),
        0,
        "Total should remain 0"
    );
}

#[test]
fn test_admin_can_update_config() {
    let (env, contract_id, admin, _lending, _borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    let new_config = RewardConfig {
        base_amount: 2_000_0000,
        reference_loan_amount: 10_000_0000000,
        max_duration_multiplier_bps: 10_000,
        tier_none_multiplier_bps: 5_000,
        tier_beginner_multiplier_bps: 10_000,
        tier_silver_multiplier_bps: 10_000,
        tier_gold_multiplier_bps: 10_000,
        tier_platinum_multiplier_bps: 10_000,
    };

    client.set_config(&admin, &new_config);

    let stored = client.get_config();
    assert_eq!(stored.base_amount, 2_000_0000);
    assert_eq!(stored.max_duration_multiplier_bps, 10_000);
}

#[test]
fn test_reward_scales_with_loan_size() {
    let (env, contract_id, _admin, lending, borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    let small = client.distribute_reward(&lending, &borrower, &5_000_0000000, &30, &4);
    let borrower2 = Address::generate(&env);
    let large = client.distribute_reward(&lending, &borrower2, &20_000_0000000, &30, &4);

    // Platinum, 30 days:
    // 5_000 XLM: 1 * (5000/10000) * 1.0 * 3.0 = 1.5 TLEND
    // 20_000 XLM: 1 * (20000/10000) * 1.0 * 3.0 = 6.0 TLEND
    assert!(small < large, "Larger loan should get more rewards");
    assert_eq!(small, 1_500_0000);
    assert_eq!(large, 6_000_0000);
}

#[test]
fn test_reward_scales_with_duration() {
    let (env, contract_id, _admin, lending, borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    let short = client.distribute_reward(&lending, &borrower, &10_000_0000000, &15, &4);
    let borrower2 = Address::generate(&env);
    let long = client.distribute_reward(&lending, &borrower2, &10_000_0000000, &60, &4);

    // Platinum, 10_000 XLM, max_duration_multiplier=10_000 bps:
    // 15 days: 1 * 1.0 * (15/30=0.5) * 3.0 = 1.5 TLEND
    // 60 days: 1 * 1.0 * (60/30=2.0) * 3.0 = 6.0 TLEND (capped at 10_000 bps = 1.0x)
    // 1 * 1.0 * 1.0 * 3.0 = 3.0 TLEND
    assert!(short < long, "Longer duration should get more rewards");
    assert_eq!(short, 1_500_0000, "15-day reward should be 1.5 TLEND");
    assert_eq!(
        long, 3_000_0000,
        "60-day reward should be 3.0 TLEND (capped at 1.0x)"
    );
}

#[test]
fn test_zero_loan_amount_returns_zero() {
    let (env, contract_id, _admin, lending, borrower) = setup();
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    let result = client.distribute_reward(&lending, &borrower, &0, &30, &4);
    assert_eq!(result, 0, "Zero loan amount should return 0");
}

#[test]
fn test_fund_and_drain_scenario() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let lending = Address::generate(&env);
    let borrower = Address::generate(&env);

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(
        BorrowerLoyaltyContract,
        (&admin, &token_id, &lending, default_config()),
    );
    let client = BorrowerLoyaltyContractClient::new(&env, &contract_id);

    // Fund with only 1 TLEND
    let token_admin_client = token::StellarAssetClient::new(&env, &token_id);
    token_admin_client.mint(&contract_id, &1_000_0000);

    // First reward should work
    let r1 = client.distribute_reward(&lending, &borrower, &10_000_0000000, &30, &4);
    assert_eq!(r1, 1_000_0000, "Should distribute available balance");

    // Second reward should return 0 (no tokens left)
    let r2 = client.distribute_reward(&lending, &borrower, &10_000_0000000, &30, &4);
    assert_eq!(r2, 0, "No tokens left to distribute");
}
