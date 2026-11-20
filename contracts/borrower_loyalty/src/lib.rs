#![no_std]
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
};

#[cfg(test)]
mod test;

#[contracttype]
#[derive(Clone)]
pub struct RewardConfig {
    pub base_amount: i128,
    pub reference_loan_amount: i128,
    pub max_duration_multiplier_bps: u32,
    pub tier_none_multiplier_bps: u32,
    pub tier_beginner_multiplier_bps: u32,
    pub tier_silver_multiplier_bps: u32,
    pub tier_gold_multiplier_bps: u32,
    pub tier_platinum_multiplier_bps: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    RewardToken,
    LendingContract,
    RewardConfig,
    BorrowerRewards(Address),
    TotalRewardsDistributed,
}

const ONE_HUNDRED_PERCENT_BPS: u32 = 10_000;

#[contract]
pub struct BorrowerLoyaltyContract;

#[contractclient(name = "BorrowerLoyaltyClient")]
pub trait BorrowerLoyalty {
    fn distribute_reward(
        env: Env,
        caller: Address,
        borrower: Address,
        loan_amount: i128,
        duration_days: u32,
        reputation_tier: u32,
    ) -> i128;
}

#[contractimpl]
impl BorrowerLoyaltyContract {
    /// Soroban constructor: runs atomically as part of `stellar contract deploy`
    /// (`-- <constructor args>`), so the contract is never live in an
    /// uninitialised state that a third party could front-run to claim
    /// admin rights (issue #352). There is no public `initialize`.
    pub fn __constructor(
        env: Env,
        admin: Address,
        reward_token: Address,
        lending_contract: Address,
        config: RewardConfig,
    ) {
        Self::validate_config(&config);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        env.storage()
            .instance()
            .set(&DataKey::LendingContract, &lending_contract);
        env.storage()
            .instance()
            .set(&DataKey::RewardConfig, &config);
        env.storage()
            .instance()
            .set(&DataKey::TotalRewardsDistributed, &0i128);
    }

    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    pub fn get_reward_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("Contract not initialised")
    }

    pub fn get_lending_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::LendingContract)
            .expect("Contract not initialised")
    }

    pub fn get_config(env: Env) -> RewardConfig {
        env.storage()
            .instance()
            .get(&DataKey::RewardConfig)
            .expect("Contract not initialised")
    }

    pub fn get_borrower_rewards(env: Env, borrower: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::BorrowerRewards(borrower))
            .unwrap_or(0)
    }

    pub fn get_total_rewards_distributed(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalRewardsDistributed)
            .unwrap_or(0)
    }

    pub fn set_config(env: Env, admin: Address, config: RewardConfig) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::validate_config(&config);
        env.storage()
            .instance()
            .set(&DataKey::RewardConfig, &config);
        env.events()
            .publish((symbol_short!("loyalty"), symbol_short!("config")), ());
    }

    pub fn set_reward_token(env: Env, admin: Address, reward_token: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        env.events().publish(
            (symbol_short!("loyalty"), symbol_short!("token")),
            reward_token,
        );
    }

    pub fn distribute_reward(
        env: Env,
        caller: Address,
        borrower: Address,
        loan_amount: i128,
        duration_days: u32,
        reputation_tier: u32,
    ) -> i128 {
        caller.require_auth();

        let lending: Address = env
            .storage()
            .instance()
            .get(&DataKey::LendingContract)
            .expect("Contract not initialised");
        if caller != lending {
            return 0;
        }

        let config: RewardConfig = env
            .storage()
            .instance()
            .get(&DataKey::RewardConfig)
            .expect("Contract not initialised");

        let reward = Self::calculate_reward(&config, loan_amount, duration_days, reputation_tier);
        if reward <= 0 {
            return 0;
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("Contract not initialised");
        let contract_addr = env.current_contract_address();

        let token_client = token::Client::new(&env, &token_addr);
        let contract_balance = token_client.balance(&contract_addr);

        let actual_transferred = if contract_balance >= reward {
            reward
        } else {
            contract_balance
        };
        if actual_transferred <= 0 {
            return 0;
        }

        let prev_rewards: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::BorrowerRewards(borrower.clone()))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::BorrowerRewards(borrower.clone()),
            &(prev_rewards + actual_transferred),
        );

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalRewardsDistributed)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::TotalRewardsDistributed,
            &(total + actual_transferred),
        );

        env.events().publish(
            (symbol_short!("loyalty"), symbol_short!("reward")),
            (borrower.clone(), actual_transferred),
        );

        token_client.transfer(&contract_addr, &borrower, &actual_transferred);

        actual_transferred
    }

    pub fn calculate_reward_view(
        env: Env,
        loan_amount: i128,
        duration_days: u32,
        reputation_tier: u32,
    ) -> i128 {
        let config: RewardConfig = env
            .storage()
            .instance()
            .get(&DataKey::RewardConfig)
            .expect("Contract not initialised");
        Self::calculate_reward(&config, loan_amount, duration_days, reputation_tier)
    }

    fn calculate_reward(
        config: &RewardConfig,
        loan_amount: i128,
        duration_days: u32,
        reputation_tier: u32,
    ) -> i128 {
        if loan_amount <= 0 || duration_days == 0 {
            return 0;
        }

        let size_multiplier_bps = {
            let ratio = loan_amount
                .checked_mul(ONE_HUNDRED_PERCENT_BPS as i128)
                .expect("Overflow in size multiplier")
                .checked_div(config.reference_loan_amount)
                .expect("Division by zero");
            if ratio > (ONE_HUNDRED_PERCENT_BPS * 10) as i128 {
                ONE_HUNDRED_PERCENT_BPS * 10
            } else {
                ratio as u32
            }
        };

        let duration_multiplier_bps = {
            let days_bps = (duration_days as u64)
                .checked_mul(ONE_HUNDRED_PERCENT_BPS as u64)
                .expect("Overflow in duration multiplier")
                .checked_div(30)
                .expect("Division by zero");
            if days_bps > config.max_duration_multiplier_bps as u64 {
                config.max_duration_multiplier_bps as u64
            } else {
                days_bps
            }
        } as u32;

        let tier_multiplier_bps = match reputation_tier {
            0 => config.tier_none_multiplier_bps,
            1 => config.tier_beginner_multiplier_bps,
            2 => config.tier_silver_multiplier_bps,
            3 => config.tier_gold_multiplier_bps,
            4 => config.tier_platinum_multiplier_bps,
            _ => panic!("Invalid reputation tier"),
        };

        config
            .base_amount
            .checked_mul(size_multiplier_bps as i128)
            .expect("Overflow: base * size")
            .checked_mul(duration_multiplier_bps as i128)
            .expect("Overflow: * duration")
            .checked_mul(tier_multiplier_bps as i128)
            .expect("Overflow: * tier")
            .checked_div(ONE_HUNDRED_PERCENT_BPS as i128)
            .expect("Division by zero")
            .checked_div(ONE_HUNDRED_PERCENT_BPS as i128)
            .expect("Division by zero")
            .checked_div(ONE_HUNDRED_PERCENT_BPS as i128)
            .expect("Division by zero")
    }

    fn validate_config(config: &RewardConfig) {
        if config.base_amount < 0 {
            panic!("base_amount must be non-negative");
        }
        if config.reference_loan_amount <= 0 {
            panic!("reference_loan_amount must be positive");
        }
        if config.max_duration_multiplier_bps > ONE_HUNDRED_PERCENT_BPS * 10 {
            panic!("max_duration_multiplier_bps too high");
        }
        if config.tier_none_multiplier_bps > ONE_HUNDRED_PERCENT_BPS * 10 {
            panic!("tier_none_multiplier_bps too high");
        }
        if config.tier_beginner_multiplier_bps > ONE_HUNDRED_PERCENT_BPS * 10 {
            panic!("tier_beginner_multiplier_bps too high");
        }
        if config.tier_silver_multiplier_bps > ONE_HUNDRED_PERCENT_BPS * 10 {
            panic!("tier_silver_multiplier_bps too high");
        }
        if config.tier_gold_multiplier_bps > ONE_HUNDRED_PERCENT_BPS * 10 {
            panic!("tier_gold_multiplier_bps too high");
        }
        if config.tier_platinum_multiplier_bps > ONE_HUNDRED_PERCENT_BPS * 10 {
            panic!("tier_platinum_multiplier_bps too high");
        }
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised");
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }
}
