#![no_std]
//! Referral rewards for TrustLend (Issue #266).
//!
//! A user who invites a friend earns a bonus once that friend actually takes
//! out a loan. The lending contract calls [`ReferralRewardsContract::claim_referral_bonus`]
//! when a referred borrower's loan activates, and the bonus is transferred
//! on-chain in the same transaction — no manual admin payout step.
//!
//! Design notes:
//!
//! * **Attribution is registered up front.** `register_referral` records
//!   referrer -> referee *before* any loan exists. The pair is immutable once
//!   set, so a referee cannot be re-attributed to a different referrer after
//!   the fact.
//! * **A referee pays out exactly once.** The `BonusPaid(referee)` flag is
//!   checked and set inside the payout path, so a borrower who takes five
//!   loans earns their referrer one bonus, not five.
//! * **Self-referral is rejected** at registration, and re-checked at payout
//!   in case a registration ever slipped through an older contract version.
//! * **Underfunding degrades safely.** Like `borrower_loyalty`, the contract
//!   pays `min(reward, balance)` and returns 0 rather than panicking, so a
//!   drained reward pool can never block a borrower's loan from activating.

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    Vec,
};

#[cfg(test)]
mod test;

/// Tunable economics for the referral programme.
#[contracttype]
#[derive(Clone)]
pub struct ReferralConfig {
    /// Flat bonus paid to the referrer, in reward-token stroops.
    pub base_bonus: i128,
    /// Loan principal at which the full `base_bonus` is earned.
    /// Smaller loans scale the bonus down pro-rata.
    pub reference_loan_amount: i128,
    /// Upper bound on the size multiplier, in bps. Caps the payout for a
    /// very large loan so one whale referral cannot drain the pool.
    pub max_size_multiplier_bps: u32,
    /// Minimum loan principal that qualifies for any bonus at all. Raises the
    /// cost of farming the programme with dust loans.
    pub min_qualifying_loan: i128,
    /// Maximum number of referees one referrer can ever be paid for.
    /// Zero means unlimited.
    pub max_referrals_per_referrer: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    MultiSigAdmin,
    MultisigAdmins,
    MultisigThreshold,
    IsPaused,
    PauseSigner(Address),
    PauseSignerCount,
    UnpauseSigner(Address),
    UnpauseSignerCount,
    RewardToken,
    LendingContract,
    Config,
    /// referee -> referrer. Set once at registration, never overwritten.
    ReferrerOf(Address),
    /// referee -> true once a bonus has been paid for them.
    BonusPaid(Address),
    /// referrer -> count of referees they have been paid for.
    PaidReferralCount(Address),
    /// referrer -> lifetime bonus earned.
    ReferrerEarnings(Address),
    TotalBonusesPaid,
    TotalReferralsRegistered,
}

const ONE_HUNDRED_PERCENT_BPS: u32 = 10_000;

#[contract]
pub struct ReferralRewardsContract;

/// Interface the lending contract invokes on loan activation.
#[contractclient(name = "ReferralRewardsClient")]
pub trait ReferralRewards {
    fn claim_referral_bonus(env: Env, caller: Address, referee: Address, loan_amount: i128)
        -> i128;
}

#[contractimpl]
impl ReferralRewardsContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        reward_token: Address,
        lending_contract: Address,
        config: ReferralConfig,
    ) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        Self::validate_config(&config);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        env.storage()
            .instance()
            .set(&DataKey::LendingContract, &lending_contract);
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::TotalBonusesPaid, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalReferralsRegistered, &0u32);
    }

    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ── Views ───────────────────────────────────────────────────────────────

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

    pub fn get_config(env: Env) -> ReferralConfig {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("Contract not initialised")
    }

    /// Who referred `referee`, if anyone.
    pub fn get_referrer_of(env: Env, referee: Address) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::ReferrerOf(referee))
    }

    /// Whether a bonus has already been paid for `referee`.
    pub fn is_bonus_paid(env: Env, referee: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::BonusPaid(referee))
            .unwrap_or(false)
    }

    /// Number of referees this referrer has been paid for.
    pub fn get_paid_referral_count(env: Env, referrer: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::PaidReferralCount(referrer))
            .unwrap_or(0)
    }

    /// Lifetime bonus earned by this referrer.
    pub fn get_referrer_earnings(env: Env, referrer: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ReferrerEarnings(referrer))
            .unwrap_or(0)
    }

    pub fn get_total_bonuses_paid(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalBonusesPaid)
            .unwrap_or(0)
    }

    pub fn get_total_referrals_registered(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TotalReferralsRegistered)
            .unwrap_or(0)
    }

    // ── Multi-sig & Pause Controls (Issue #425) ────────────────────────────

    /// Configure multi-sig admins and signing threshold (admin only).
    /// `threshold` must be >= 1 and <= admins.len().
    pub fn setup_multisig(env: Env, admin: Address, admins: Vec<Address>, threshold: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if threshold == 0 {
            panic!("Threshold must be at least 1");
        }
        if threshold > admins.len() {
            panic!("Threshold exceeds number of admins");
        }

        let mut final_admins = admins;
        let has_admin = final_admins.iter().any(|a| a == admin);
        if !has_admin {
            final_admins.push_back(admin);
        }

        env.storage()
            .instance()
            .set(&DataKey::MultisigThreshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::MultisigAdmins, &final_admins);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage()
            .instance()
            .set(&DataKey::PauseSignerCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::UnpauseSignerCount, &0u32);
    }

    /// One-time bootstrap linking the MultiSigAdmin contract (admin only).
    pub fn set_multisig_admin(env: Env, admin: Address, multisig: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if env.storage().instance().has(&DataKey::MultiSigAdmin) {
            panic!("Multisig admin already configured");
        }
        env.storage()
            .instance()
            .set(&DataKey::MultiSigAdmin, &multisig);
        let mut msig_admins = Vec::new(&env);
        msig_admins.push_back(multisig);
        env.storage()
            .instance()
            .set(&DataKey::MultisigAdmins, &msig_admins);
    }

    pub fn get_multisig_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::MultiSigAdmin)
            .expect("Multisig admin not configured")
    }

    /// Multi-sig pause: requires `threshold` unique admin signatures.
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            panic!("Contract is already paused");
        }

        let signer_key = DataKey::PauseSigner(caller.clone());
        if env.storage().instance().has(&signer_key) {
            panic!("Signer has already authorised pause");
        }
        env.storage().instance().set(&signer_key, &true);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PauseSignerCount)
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::PauseSignerCount, &new_count);

        let threshold: u32 = Self::get_multisig_threshold(env.clone());
        if new_count >= threshold {
            env.storage().instance().set(&DataKey::IsPaused, &true);
            env.storage()
                .instance()
                .set(&DataKey::PauseSignerCount, &0u32);
            for a in Self::get_multisig_admins(env.clone()).iter() {
                env.storage().instance().remove(&DataKey::PauseSigner(a));
            }
            env.events()
                .publish((symbol_short!("referral"), symbol_short!("paused")), ());
        }
    }

    /// Multi-sig unpause: requires `threshold` unique admin signatures.
    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if !is_paused {
            panic!("Contract is not paused");
        }

        let signer_key = DataKey::UnpauseSigner(caller.clone());
        if env.storage().instance().has(&signer_key) {
            panic!("Signer has already authorised unpause");
        }
        env.storage().instance().set(&signer_key, &true);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UnpauseSignerCount)
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::UnpauseSignerCount, &new_count);

        let threshold: u32 = Self::get_multisig_threshold(env.clone());
        if new_count >= threshold {
            env.storage().instance().set(&DataKey::IsPaused, &false);
            env.storage()
                .instance()
                .set(&DataKey::UnpauseSignerCount, &0u32);
            for a in Self::get_multisig_admins(env.clone()).iter() {
                env.storage().instance().remove(&DataKey::UnpauseSigner(a));
            }
            env.events()
                .publish((symbol_short!("referral"), symbol_short!("unpaused")), ());
        }
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    pub fn get_multisig_admins(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_multisig_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MultisigThreshold)
            .unwrap_or(1)
    }

    pub fn get_pause_signer_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PauseSignerCount)
            .unwrap_or(0)
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    pub fn set_config(env: Env, admin: Address, config: ReferralConfig) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::validate_config(&config);
        env.storage().instance().set(&DataKey::Config, &config);
        env.events()
            .publish((symbol_short!("referral"), symbol_short!("config")), ());
    }

    pub fn set_reward_token(env: Env, admin: Address, reward_token: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        env.events().publish(
            (symbol_short!("referral"), symbol_short!("token")),
            reward_token,
        );
    }

    pub fn set_lending_contract(env: Env, admin: Address, lending_contract: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::LendingContract, &lending_contract);
        env.events().publish(
            (symbol_short!("referral"), symbol_short!("lending")),
            lending_contract,
        );
    }

    /// Withdraw unspent reward tokens (e.g. when winding the programme down).
    /// Multisig-gated and blocked while paused (Issue #425).
    pub fn withdraw_unspent(env: Env, admin: Address, to: Address, amount: i128) {
        admin.require_auth();
        Self::assert_multisig_admin(&env, &admin);
        Self::assert_not_paused(&env);
        if amount <= 0 {
            panic!("Withdrawal amount must be positive");
        }
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("Contract not initialised");
        let contract_addr = env.current_contract_address();
        let token_client = token::Client::new(&env, &token_addr);
        if token_client.balance(&contract_addr) < amount {
            panic!("Insufficient reward balance");
        }
        token_client.transfer(&contract_addr, &to, &amount);
        env.events().publish(
            (symbol_short!("referral"), symbol_short!("withdraw")),
            (to, amount),
        );
    }

    // ── Registration ────────────────────────────────────────────────────────

    /// Record that `referrer` invited `referee`.
    ///
    /// Authorised by the referee: the invited user is the one who acts on the
    /// link, and requiring their auth stops anyone from claiming strangers as
    /// their referees. The pair is immutable once written.
    pub fn register_referral(env: Env, referee: Address, referrer: Address) {
        referee.require_auth();
        Self::assert_not_paused(&env);

        if referee == referrer {
            panic!("Cannot refer yourself");
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::ReferrerOf(referee.clone()))
        {
            panic!("Referee already has a referrer");
        }
        // A referee who has already borrowed is not a new user; attributing
        // them now would pay for a customer the referrer did not bring in.
        if Self::is_bonus_paid(env.clone(), referee.clone()) {
            panic!("Referee has already generated a bonus");
        }

        env.storage()
            .persistent()
            .set(&DataKey::ReferrerOf(referee.clone()), &referrer);

        let total: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalReferralsRegistered)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalReferralsRegistered, &(total + 1));

        env.events().publish(
            (symbol_short!("referral"), symbol_short!("register")),
            (referee, referrer),
        );
    }

    // ── Payout ──────────────────────────────────────────────────────────────

    /// Pay the referrer of `referee`, if one is registered and unpaid.
    ///
    /// Invoked by the lending contract when a referred borrower's loan
    /// activates. Returns the amount actually transferred, or 0 when no bonus
    /// is due for any reason. **This function never panics on a business-rule
    /// miss** — a referral problem must not prevent a loan from activating.
    pub fn claim_referral_bonus(
        env: Env,
        caller: Address,
        referee: Address,
        loan_amount: i128,
    ) -> i128 {
        caller.require_auth();

        if Self::is_paused(env.clone()) {
            return 0;
        }

        let lending: Address = env
            .storage()
            .instance()
            .get(&DataKey::LendingContract)
            .expect("Contract not initialised");
        if caller != lending {
            return 0;
        }

        // Already paid for this referee — a second loan earns nothing more.
        if Self::is_bonus_paid(env.clone(), referee.clone()) {
            return 0;
        }

        let referrer: Address = match env
            .storage()
            .persistent()
            .get(&DataKey::ReferrerOf(referee.clone()))
        {
            Some(addr) => addr,
            None => return 0,
        };

        // Defence in depth: reject a self-referral even if one was somehow
        // registered by an earlier contract version.
        if referrer == referee {
            return 0;
        }

        let config: ReferralConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("Contract not initialised");

        if loan_amount < config.min_qualifying_loan {
            return 0;
        }

        // Enforce the per-referrer cap.
        let paid_count: u32 = Self::get_paid_referral_count(env.clone(), referrer.clone());
        if config.max_referrals_per_referrer > 0
            && paid_count >= config.max_referrals_per_referrer
        {
            return 0;
        }

        let bonus = Self::calculate_bonus(&config, loan_amount);
        if bonus <= 0 {
            return 0;
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("Contract not initialised");
        let contract_addr = env.current_contract_address();
        let token_client = token::Client::new(&env, &token_addr);
        let balance = token_client.balance(&contract_addr);

        // Pay what we can. An empty pool yields 0 rather than a panic.
        let payout = if balance >= bonus { bonus } else { balance };
        if payout <= 0 {
            return 0;
        }

        // Mark paid *before* transferring, so a re-entrant token hook cannot
        // observe an unpaid flag and claim the bonus twice.
        env.storage()
            .persistent()
            .set(&DataKey::BonusPaid(referee.clone()), &true);
        env.storage().persistent().set(
            &DataKey::PaidReferralCount(referrer.clone()),
            &(paid_count + 1),
        );

        let prev_earnings: i128 = Self::get_referrer_earnings(env.clone(), referrer.clone());
        env.storage().persistent().set(
            &DataKey::ReferrerEarnings(referrer.clone()),
            &(prev_earnings + payout),
        );

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalBonusesPaid)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalBonusesPaid, &(total + payout));

        env.events().publish(
            (symbol_short!("referral"), symbol_short!("bonus")),
            (referrer.clone(), referee, payout),
        );

        token_client.transfer(&contract_addr, &referrer, &payout);

        payout
    }

    /// Preview the bonus a given loan size would earn, without paying it.
    pub fn calculate_bonus_view(env: Env, loan_amount: i128) -> i128 {
        let config: ReferralConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("Contract not initialised");
        if loan_amount < config.min_qualifying_loan {
            return 0;
        }
        Self::calculate_bonus(&config, loan_amount)
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /// Bonus scales linearly with loan size up to `max_size_multiplier_bps`.
    fn calculate_bonus(config: &ReferralConfig, loan_amount: i128) -> i128 {
        if loan_amount <= 0 || config.base_bonus <= 0 {
            return 0;
        }

        let ratio_bps = loan_amount
            .checked_mul(ONE_HUNDRED_PERCENT_BPS as i128)
            .expect("Overflow computing size ratio")
            .checked_div(config.reference_loan_amount)
            .expect("Division by zero");

        let capped_bps = if ratio_bps > config.max_size_multiplier_bps as i128 {
            config.max_size_multiplier_bps as i128
        } else {
            ratio_bps
        };

        config
            .base_bonus
            .checked_mul(capped_bps)
            .expect("Overflow computing bonus")
            .checked_div(ONE_HUNDRED_PERCENT_BPS as i128)
            .expect("Division by zero")
    }

    fn validate_config(config: &ReferralConfig) {
        if config.base_bonus < 0 {
            panic!("base_bonus must be non-negative");
        }
        if config.reference_loan_amount <= 0 {
            panic!("reference_loan_amount must be positive");
        }
        if config.min_qualifying_loan < 0 {
            panic!("min_qualifying_loan must be non-negative");
        }
        if config.max_size_multiplier_bps > ONE_HUNDRED_PERCENT_BPS * 10 {
            panic!("max_size_multiplier_bps too high");
        }
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let multisig_admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(env));
        if !multisig_admins.is_empty() && multisig_admins.iter().any(|a| a == *caller) {
            return;
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised");
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }

    fn assert_multisig_admin(env: &Env, caller: &Address) {
        let multisig_admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(env));
        if multisig_admins.is_empty() {
            panic!("Multisig not configured");
        }
        if !multisig_admins.iter().any(|a| a == *caller) {
            panic!("Unauthorised: caller is not a multisig admin");
        }
    }

    fn assert_not_paused(env: &Env) {
        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            panic!("Contract is paused");
        }
    }
}
