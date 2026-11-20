#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn default_config() -> PoolConfig {
    PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 5000,
        kink_bps: 8000,
        reserve_factor_bps: 1000,
    }
}

fn setup() -> (Env, Address, Address, u32) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let pool_id: u32 = 1;

    let contract_id = env.register(PooledLendingContract, (&admin, &pool_id, default_config()));

    (env, contract_id, admin, pool_id)
}

// ─── Initialization tests ──────────────────────────────────────────────────

#[test]
fn test_initialize_creates_pool() {
    let (env, contract_id, _admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    let config = client.get_pool_config(&pool_id);
    assert_eq!(config.base_rate_bps, 200);
    assert_eq!(config.kink_bps, 8000);
}

/// Issue #352: initialization runs in the Soroban constructor, atomically with
/// deployment. There is no `initialize` entrypoint left to front-run, and the
/// constructor cannot be re-invoked on the live contract to seize admin rights.
#[test]
fn test_constructor_initializes_and_cannot_be_reinvoked() {
    use soroban_sdk::{IntoVal, Symbol};
    let (env, contract_id, admin, pool_id) = setup();
    let attacker = Address::generate(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        attacker.into_val(&env),
        pool_id.into_val(&env),
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
fn test_get_pool_config_and_data() {
    let (env, contract_id, _admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    let config = client.get_pool_config(&pool_id);
    assert_eq!(config.base_rate_bps, 200);
    assert_eq!(config.multiplier_per_slope_bps, 1000);
    assert_eq!(config.jump_multiplier_bps, 5000);
    assert_eq!(config.kink_bps, 8000);
    assert_eq!(config.reserve_factor_bps, 1000);

    let data = client.get_pool_data(&pool_id);
    assert_eq!(data.total_supply, 0);
    assert_eq!(data.total_borrows, 0);
    assert_eq!(data.total_reserves, 0);
}

#[test]
fn test_get_interest_rate_model_returns_config() {
    let (env, contract_id, _admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    let config = client.get_interest_rate_model(&pool_id);
    assert_eq!(config.base_rate_bps, 200);
    assert_eq!(config.kink_bps, 8000);
}

// ─── Configuration update tests ───────────────────────────────────────────

#[test]
fn test_set_pool_config_updates_curve() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    let new_config = PoolConfig {
        base_rate_bps: 300,
        multiplier_per_slope_bps: 1500,
        jump_multiplier_bps: 6000,
        kink_bps: 7000,
        reserve_factor_bps: 500,
    };
    client.set_pool_config(&admin, &pool_id, &new_config);

    let config = client.get_pool_config(&pool_id);
    assert_eq!(config.base_rate_bps, 300);
    assert_eq!(config.kink_bps, 7000);
}

#[test]
fn test_update_pool_state() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &400_000_0000000i128,
    );

    let data = client.get_pool_data(&pool_id);
    assert_eq!(data.total_supply, 1_000_000_0000000i128);
    assert_eq!(data.total_borrows, 400_000_0000000i128);
}

#[test]
#[should_panic(expected = "total_borrows exceeds total_supply")]
fn test_update_pool_state_rejects_borrows_exceeding_supply() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(&admin, &pool_id, &1000i128, &2000i128);
}

#[test]
#[should_panic(expected = "total_supply must not be negative")]
fn test_update_pool_state_rejects_negative_supply() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(&admin, &pool_id, &(-1000i128), &0i128);
}

#[test]
#[should_panic(expected = "total_borrows must not be negative")]
fn test_update_pool_state_rejects_negative_borrows() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(&admin, &pool_id, &1000i128, &(-100i128));
}

#[test]
#[should_panic(expected = "unauthorized")]
fn test_unauthorized_set_pool_config_rejected() {
    let (env, contract_id, _admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    let attacker = Address::generate(&env);
    client.set_pool_config(&attacker, &pool_id, &default_config());
}

// ─── Invalid configuration rejection tests ─────────────────────────────────

#[test]
#[should_panic(expected = "base_rate_bps exceeds max")]
fn test_invalid_config_base_rate_over_max() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 10001,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 5000,
        kink_bps: 8000,
        reserve_factor_bps: 1000,
    };
    env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
}

#[test]
#[should_panic(expected = "multiplier_per_slope_bps exceeds max")]
fn test_invalid_config_multiplier_over_max() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 10001,
        jump_multiplier_bps: 5000,
        kink_bps: 8000,
        reserve_factor_bps: 1000,
    };
    env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
}

#[test]
#[should_panic(expected = "jump_multiplier_bps exceeds max")]
fn test_invalid_config_jump_multiplier_over_max() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 10001,
        kink_bps: 8000,
        reserve_factor_bps: 1000,
    };
    env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
}

#[test]
#[should_panic(expected = "kink_bps exceeds max")]
fn test_invalid_config_kink_over_max() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 5000,
        kink_bps: 10001,
        reserve_factor_bps: 1000,
    };
    env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
}

#[test]
#[should_panic(expected = "kink_bps must be > 0")]
fn test_invalid_config_kink_zero_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 5000,
        kink_bps: 0,
        reserve_factor_bps: 1000,
    };
    env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
}

#[test]
#[should_panic(expected = "kink_bps must be < 10000")]
fn test_invalid_config_kink_10000_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 5000,
        kink_bps: 10000,
        reserve_factor_bps: 1000,
    };
    env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
}

#[test]
#[should_panic(expected = "reserve_factor_bps exceeds max")]
fn test_invalid_config_reserve_factor_over_max() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 5000,
        kink_bps: 8000,
        reserve_factor_bps: 10001,
    };
    env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
}

// ─── Utilization tests ─────────────────────────────────────────────────────

#[test]
fn test_utilization_zero_when_zero_supply() {
    let (env, contract_id, _admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);
    let util = client.get_pool_utilization(&pool_id);
    assert_eq!(util, 0);
}

#[test]
fn test_utilization_zero_when_zero_borrows() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(&admin, &pool_id, &1_000_000_0000000i128, &0i128);
    let util = client.get_pool_utilization(&pool_id);
    assert_eq!(util, 0);
}

#[test]
fn test_utilization_half() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &500_000_0000000i128,
    );
    let util = client.get_pool_utilization(&pool_id);
    assert_eq!(util, 5000);
}

#[test]
fn test_utilization_full() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &1_000_000_0000000i128,
    );
    let util = client.get_pool_utilization(&pool_id);
    assert_eq!(util, 10000);
}

#[test]
fn test_utilization_at_max_is_10000() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &1_000_000_0000000i128,
    );
    let util = client.get_pool_utilization(&pool_id);
    assert_eq!(util, 10000);
}

// ─── Borrow APY curve tests ────────────────────────────────────────────────

#[test]
fn test_borrow_apy_at_zero_utilization_equals_base_rate() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(&admin, &pool_id, &1_000_000_0000000i128, &0i128);
    let rate = client.get_borrow_apy(&pool_id);
    assert_eq!(rate, 200);
}

#[test]
fn test_borrow_apy_at_50_percent_utilization() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &500_000_0000000i128,
    );
    let rate = client.get_borrow_apy(&pool_id);

    // At 50% util with kink=80%:
    // rate = 200 + (5000 * 1000 / 8000) = 200 + 625 = 825 bps
    assert_eq!(rate, 825);
}

#[test]
fn test_borrow_apy_at_kink_point() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &800_000_0000000i128,
    );
    let rate = client.get_borrow_apy(&pool_id);

    // At 80% util (kink=8000):
    // rate = 200 + (8000 * 1000 / 8000) = 200 + 1000 = 1200 bps
    assert_eq!(rate, 1200);
}

#[test]
fn test_borrow_apy_at_100_percent_utilization() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &1_000_000_0000000i128,
    );
    let rate = client.get_borrow_apy(&pool_id);

    // At 100% util (above kink=8000):
    // excess = 10000 - 8000 = 2000
    // jump = 2000 * 5000 / (10000 - 8000) = 2000 * 5000 / 2000 = 5000
    // rate = 200 + 1000 + 5000 = 6200 bps
    assert_eq!(rate, 6200);
}

// ─── Supply APY tests ──────────────────────────────────────────────────────

#[test]
fn test_supply_apy_zero_at_zero_utilization() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(&admin, &pool_id, &1_000_000_0000000i128, &0i128);
    let rate = client.get_supply_apy(&pool_id);
    assert_eq!(rate, 0);
}

#[test]
fn test_supply_apy_at_50_percent() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &500_000_0000000i128,
    );
    let rate = client.get_supply_apy(&pool_id);

    // borrow_rate = 825 bps, utilization = 5000 bps, reserve_factor = 1000 bps
    // supply = 825 * 5000 * 9000 / 10000 / 10000 = 371.25 -> 371 bps
    let expected: u64 = 825u64 * 5000u64 * 9000u64 / 10_000u64 / 10_000u64;
    assert_eq!(rate, expected as u32);
}

#[test]
fn test_supply_apy_at_kink() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &800_000_0000000i128,
    );
    let rate = client.get_supply_apy(&pool_id);

    // borrow_rate = 1200 bps, utilization = 8000 bps, reserve_factor = 1000 bps
    // supply = 1200 * 8000 * 9000 / 10000 / 10000 = 864 bps
    let expected: u64 = 1200u64 * 8000u64 * 9000u64 / 10_000u64 / 10_000u64;
    assert_eq!(rate, expected as u32);
}

#[test]
fn test_supply_apy_at_100_percent() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &1_000_000_0000000i128,
    );
    let rate = client.get_supply_apy(&pool_id);

    // borrow_rate = 6200 bps, utilization = 10000 bps, reserve_factor = 1000 bps
    // supply = 6200 * 10000 * 9000 / 10000 / 10000 = 5580 bps
    let expected: u64 = 6200u64 * 10000u64 * 9000u64 / 10_000u64 / 10_000u64;
    assert_eq!(rate, expected as u32);
}

#[test]
fn test_supply_apy_zero_with_reserve_factor_100_percent() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let config = PoolConfig {
        base_rate_bps: 200,
        multiplier_per_slope_bps: 1000,
        jump_multiplier_bps: 5000,
        kink_bps: 8000,
        reserve_factor_bps: 10000,
    };
    let contract_id = env.register(PooledLendingContract, (&admin, 1_u32, config.clone()));
    let client = PooledLendingContractClient::new(&env, &contract_id);
    client.update_pool_state(&admin, &1, &1_000_000_0000000i128, &500_000_0000000i128);

    let rate = client.get_supply_apy(&1);
    assert_eq!(rate, 0);
}

// ─── View function return value integrity tests ────────────────────────────

#[test]
fn test_all_view_functions_return_expected_types() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.update_pool_state(
        &admin,
        &pool_id,
        &1_000_000_0000000i128,
        &500_000_0000000i128,
    );

    let util = client.get_pool_utilization(&pool_id);
    assert!(util <= 10000);

    let borrow_apy = client.get_borrow_apy(&pool_id);
    assert!(borrow_apy >= 200);

    let supply_apy = client.get_supply_apy(&pool_id);
    assert!(supply_apy <= borrow_apy);

    let config = client.get_interest_rate_model(&pool_id);
    assert_eq!(config.base_rate_bps, 200);

    let data = client.get_pool_data(&pool_id);
    assert_eq!(data.total_supply, 1_000_000_0000000i128);
}

#[test]
fn test_supply_rate_never_exceeds_borrow_rate() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    for util_pct in [0, 10, 25, 50, 75, 80, 85, 90, 95, 100] {
        let total_supply: i128 = 1_000_000_0000000;
        let total_borrows: i128 = total_supply * util_pct / 100;
        client.update_pool_state(&admin, &pool_id, &total_supply, &total_borrows);

        let borrow_apy = client.get_borrow_apy(&pool_id);
        let supply_apy = client.get_supply_apy(&pool_id);
        assert!(
            supply_apy <= borrow_apy,
            "supply_apy {} > borrow_apy {} at {}% utilization",
            supply_apy,
            borrow_apy,
            util_pct
        );
    }
}

#[test]
fn test_borrow_rate_monotonically_increasing() {
    let (env, contract_id, admin, pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    let mut prev_rate = 0u32;
    for util_pct in 0..=100 {
        let total_supply: i128 = 1_000_000_0000000;
        let total_borrows: i128 = total_supply * util_pct / 100;
        client.update_pool_state(&admin, &pool_id, &total_supply, &total_borrows);

        let rate = client.get_borrow_apy(&pool_id);
        assert!(
            rate >= prev_rate,
            "borrow rate decreased from {} to {} at {}% utilization",
            prev_rate,
            rate,
            util_pct
        );
        prev_rate = rate;
    }
}

#[test]
#[should_panic(expected = "pool config not found")]
fn test_pool_not_found_panics_on_config() {
    let (env, contract_id, _admin, _pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.get_pool_config(&999);
}

#[test]
#[should_panic(expected = "pool data not found")]
fn test_pool_not_found_panics_on_data() {
    let (env, contract_id, _admin, _pool_id) = setup();
    let client = PooledLendingContractClient::new(&env, &contract_id);

    client.get_pool_data(&999);
}
