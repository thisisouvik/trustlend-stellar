#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

const MAX_BPS: u32 = 10_000;

#[contracttype]
#[derive(Clone)]
pub struct PoolConfig {
    pub base_rate_bps: u32,
    pub multiplier_per_slope_bps: u32,
    pub jump_multiplier_bps: u32,
    pub kink_bps: u32,
    pub reserve_factor_bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct PoolData {
    pub total_supply: i128,
    pub total_borrows: i128,
    pub total_reserves: i128,
}

#[contracttype]
pub enum DataKey {
    PoolConfig(u32),
    PoolData(u32),
    Admin,
}

#[contract]
pub struct PooledLendingContract;

#[contractimpl]
impl PooledLendingContract {
    /// Soroban constructor: runs atomically as part of `stellar contract deploy`
    /// (`-- <constructor args>`), so the contract is never live in an
    /// uninitialised state that a third party could front-run to claim
    /// admin rights (issue #352). There is no public `initialize`.
    pub fn __constructor(env: Env, admin: Address, pool_id: u32, config: PoolConfig) {
        Self::validate_config(&config);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PoolConfig(pool_id), &config);
        env.storage().instance().set(
            &DataKey::PoolData(pool_id),
            &PoolData {
                total_supply: 0,
                total_borrows: 0,
                total_reserves: 0,
            },
        );
    }

    pub fn set_pool_config(env: Env, caller: Address, pool_id: u32, config: PoolConfig) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::validate_config(&config);
        env.storage()
            .instance()
            .set(&DataKey::PoolConfig(pool_id), &config);
    }

    pub fn update_pool_state(
        env: Env,
        caller: Address,
        pool_id: u32,
        total_supply: i128,
        total_borrows: i128,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        if total_supply < 0 {
            panic!("total_supply must not be negative");
        }
        if total_borrows < 0 {
            panic!("total_borrows must not be negative");
        }
        if total_borrows > total_supply {
            panic!("total_borrows exceeds total_supply");
        }
        let data = PoolData {
            total_supply,
            total_borrows,
            total_reserves: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::PoolData(pool_id), &data);
    }

    pub fn get_pool_config(env: Env, pool_id: u32) -> PoolConfig {
        env.storage()
            .instance()
            .get(&DataKey::PoolConfig(pool_id))
            .expect("pool config not found")
    }

    pub fn get_pool_data(env: Env, pool_id: u32) -> PoolData {
        env.storage()
            .instance()
            .get(&DataKey::PoolData(pool_id))
            .expect("pool data not found")
    }

    pub fn get_pool_utilization(env: Env, pool_id: u32) -> u32 {
        let data = Self::get_pool_data(env, pool_id);
        Self::compute_utilization_bps(data.total_supply, data.total_borrows)
    }

    pub fn get_borrow_apy(env: Env, pool_id: u32) -> u32 {
        let config = Self::get_pool_config(env.clone(), pool_id);
        let data = Self::get_pool_data(env, pool_id);
        let utilization_bps = Self::compute_utilization_bps(data.total_supply, data.total_borrows);
        Self::compute_borrow_rate_bps(&config, utilization_bps)
    }

    pub fn get_supply_apy(env: Env, pool_id: u32) -> u32 {
        let config = Self::get_pool_config(env.clone(), pool_id);
        let data = Self::get_pool_data(env, pool_id);
        let utilization_bps = Self::compute_utilization_bps(data.total_supply, data.total_borrows);
        let borrow_rate_bps = Self::compute_borrow_rate_bps(&config, utilization_bps);
        Self::compute_supply_rate_bps(&config, utilization_bps, borrow_rate_bps)
    }

    pub fn get_interest_rate_model(env: Env, pool_id: u32) -> PoolConfig {
        Self::get_pool_config(env, pool_id)
    }

    fn compute_utilization_bps(total_supply: i128, total_borrows: i128) -> u32 {
        if total_supply <= 0 || total_borrows <= 0 {
            return 0;
        }
        let util = total_borrows
            .checked_mul(MAX_BPS as i128)
            .expect("overflow computing utilization")
            .checked_div(total_supply)
            .expect("division by zero");
        if util > MAX_BPS as i128 {
            MAX_BPS
        } else {
            util as u32
        }
    }

    fn compute_borrow_rate_bps(config: &PoolConfig, utilization_bps: u32) -> u32 {
        if utilization_bps == 0 {
            return config.base_rate_bps;
        }
        if utilization_bps <= config.kink_bps {
            let numerator = (utilization_bps as u64)
                .checked_mul(config.multiplier_per_slope_bps as u64)
                .expect("overflow in borrow rate numerator");
            let slope_component = numerator
                .checked_div(config.kink_bps as u64)
                .expect("division by zero") as u32;
            (config.base_rate_bps as u64)
                .checked_add(slope_component as u64)
                .expect("overflow in borrow rate") as u32
        } else {
            let excess = utilization_bps - config.kink_bps;
            let numerator = (excess as u64)
                .checked_mul(config.jump_multiplier_bps as u64)
                .expect("overflow in jump numerator");
            let jump_component = numerator
                .checked_div((MAX_BPS - config.kink_bps) as u64)
                .expect("division by zero") as u32;
            (config.base_rate_bps as u64)
                .checked_add(config.multiplier_per_slope_bps as u64)
                .expect("overflow in base+slope")
                .checked_add(jump_component as u64)
                .expect("overflow in jump rate") as u32
        }
    }

    fn compute_supply_rate_bps(
        config: &PoolConfig,
        utilization_bps: u32,
        borrow_rate_bps: u32,
    ) -> u32 {
        if utilization_bps == 0 || borrow_rate_bps == 0 {
            return 0;
        }
        let numerator = (borrow_rate_bps as u64)
            .checked_mul(utilization_bps as u64)
            .expect("overflow in supply numerator")
            .checked_mul((MAX_BPS - config.reserve_factor_bps) as u64)
            .expect("overflow in supply rf adjustment");
        (numerator
            .checked_div(MAX_BPS as u64)
            .expect("division by zero")
            .checked_div(MAX_BPS as u64)
            .expect("division by zero")) as u32
    }

    fn validate_config(config: &PoolConfig) {
        if config.base_rate_bps > MAX_BPS {
            panic!("base_rate_bps exceeds max");
        }
        if config.multiplier_per_slope_bps > MAX_BPS {
            panic!("multiplier_per_slope_bps exceeds max");
        }
        if config.jump_multiplier_bps > MAX_BPS {
            panic!("jump_multiplier_bps exceeds max");
        }
        if config.kink_bps > MAX_BPS {
            panic!("kink_bps exceeds max");
        }
        if config.reserve_factor_bps > MAX_BPS {
            panic!("reserve_factor_bps exceeds max");
        }
        if config.kink_bps == 0 {
            panic!("kink_bps must be > 0");
        }
        if config.kink_bps >= MAX_BPS {
            panic!("kink_bps must be < 10000");
        }
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");
        if *caller != admin {
            panic!("unauthorized");
        }
    }
}

#[cfg(test)]
mod test;
