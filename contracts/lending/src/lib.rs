#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::token;
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, vec, Address, Bytes,
    BytesN, Env, IntoVal, Symbol, Val, Vec,
};

struct LoyaltyClient(Address);
impl LoyaltyClient {
    fn new(_env: &Env, address: &Address) -> Self {
        Self(address.clone())
    }
    fn distribute_reward(
        &self,
        env: &Env,
        caller: &Address,
        borrower: &Address,
        loan_amount: &i128,
        duration_days: &u32,
        reputation_tier: &u32,
    ) -> i128 {
        let args: Vec<Val> = vec![
            env,
            caller.into_val(env),
            borrower.into_val(env),
            (*loan_amount).into_val(env),
            (*duration_days).into_val(env),
            (*reputation_tier).into_val(env),
        ];
        let result = env.try_invoke_contract::<i128, Val>(
            &self.0,
            &Symbol::new(env, "distribute_reward"),
            args,
        );
        match result {
            Ok(Ok(amount)) => amount,
            _ => 0,
        }
    }
}

/// Thin client for the ReferralRewardsContract (Issue #266).
///
/// Uses `try_invoke_contract` with a `_ => 0` fallback for the same reason as
/// `LoyaltyClient`: a referral payout is a bonus, never a precondition. If the
/// referral contract is unset, misconfigured, out of funds or panicking, the
/// borrower's loan must still activate.
struct ReferralClient(Address);
impl ReferralClient {
    fn new(_env: &Env, address: &Address) -> Self {
        Self(address.clone())
    }
    fn claim_referral_bonus(
        &self,
        env: &Env,
        caller: &Address,
        referee: &Address,
        loan_amount: &i128,
    ) -> i128 {
        let args: Vec<Val> = vec![
            env,
            caller.into_val(env),
            referee.into_val(env),
            (*loan_amount).into_val(env),
        ];
        let result = env.try_invoke_contract::<i128, Val>(
            &self.0,
            &Symbol::new(env, "claim_referral_bonus"),
            args,
        );
        match result {
            Ok(Ok(amount)) => amount,
            _ => 0,
        }
    }
}

/// The subset of the BorrowerReputationContract the lending contract reads
/// (Issue #335). Unlike the loyalty/referral clients these calls are NOT
/// wrapped in `try_invoke_contract`: credit limits and tiers are security
/// critical, so if the reputation contract cannot vouch for the borrower
/// (no profile, misconfigured, panicking) the loan request must fail closed.
#[contractclient(name = "ReputationClient")]
pub trait ReputationInterface {
    fn calculate_max_loan(env: Env, borrower: Address) -> i128;
    fn get_reputation_tier(env: Env, borrower: Address) -> u32;
}

/// TreasuryContract entry point used to keep the treasury's per-token
/// balance in sync when the admin collects fees directly (Issue #338).
#[contractclient(name = "TreasuryFeeClient")]
pub trait TreasuryFeeReceiver {
    fn record_protocol_fees(env: Env, lending_contract: Address, asset_token: Address, amount: i128);
}

#[contractclient(name = "FlashLoanReceiverClient")]
pub trait FlashLoanReceiver {
    fn execute_operation(
        env: Env,
        token: Address,
        amount: i128,
        fee: i128,
        pool: Address,
        params: Bytes,
    );
}

// ─── Types ────────────────────────────────────────────────────────────────────

/// Full lifecycle status of a loan.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum LoanStatus {
    Pending,
    Approved,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

/// Interest rate model for a loan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InterestRateModel {
    Fixed,
    Floating,
}

/// A single collateral entry: asset address + amount in that asset's smallest unit.
#[contracttype]
#[derive(Clone)]
#[cfg_attr(test, derive(Debug))]
pub struct CollateralEntry {
    pub asset: Address,
    pub amount: i128,
}

/// Per-asset collateral configuration: LTV ratio (collateral factor) and
/// optional oracle price feed for value normalization.
#[contracttype]
#[derive(Clone)]
#[cfg_attr(test, derive(Debug))]
pub struct AssetCollateralConfig {
    /// Collateral factor / LTV ratio in basis-points (e.g. 8000 = 80% LTV).
    pub collateral_factor_bps: u32,
    /// Whether the asset has an oracle price feed configured for USD normalization.
    pub has_price_oracle: bool,
    /// Volatility basis-points used in liquidation threshold calculations
    /// (e.g. 500 = 5% expected volatility).
    pub volatility_bps: u32,
}

/// A single loan record.
#[contracttype]
#[derive(Clone)]
pub struct LoanRequestInput {
    pub amount: i128,
    pub duration_days: u32,
    pub interest_rate_bps: u32,
    /// DEPRECATED — ignored (Issue #335). The credit limit is read on-chain
    /// from the registered BorrowerReputationContract (`calculate_max_loan`).
    /// Kept only so existing clients encoding this struct stay compatible.
    pub max_loan_amount: i128,
    /// Collateral entries supporting this loan (multi-asset).
    pub collateral_entries: Vec<CollateralEntry>,
    /// Interest rate model: Fixed or Floating
    pub rate_model: InterestRateModel,
    /// DEPRECATED — ignored (Issue #335). The tier is read on-chain from the
    /// registered BorrowerReputationContract (`get_reputation_tier`).
    /// Kept only so existing clients encoding this struct stay compatible.
    pub reputation_tier: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct LoanRecord {
    pub id: u32,
    pub borrower: Address,
    pub lender: Address,
    /// Principal in stroops
    pub amount: i128,
    pub duration_days: u32,
    /// Interest rate in basis-points (1500 = 15.00 %)
    pub interest_rate_bps: u32,
    /// Principal + full interest in stroops
    pub total_due: i128,
    /// Remaining balance the borrower still owes
    pub remaining_due: i128,
    /// Ledger timestamp of loan creation
    pub created_at: u64,
    /// Ledger timestamp of repayment deadline
    pub due_at: u64,
    pub status: LoanStatus,
    /// Escrow ID from the EscrowContract
    pub escrow_id: u32,
    /// Platform fee taken (1% of interest, in stroops)
    pub platform_fee: i128,
    /// Interest rate model: Fixed or Floating
    pub rate_model: InterestRateModel,
    /// Baseline rate at loan creation in bps (anchors floating calculations)
    pub base_rate_bps: u32,
    /// Timestamp of the last floating rate adjustment
    pub last_rate_update: u64,
}

/// A partial/full payment record.
#[contracttype]
#[derive(Clone)]
pub struct PaymentRecord {
    pub loan_id: u32,
    pub amount: i128,
    pub paid_at: u64,
}

/// Ledger storage keys.
#[contracttype]
pub enum DataKey {
    Loan(u32),
    LoanCount,
    BorrowerLoanCount(Address),
    BorrowerLoanAt(Address, u32),
    LenderLoanCount(Address),
    LenderLoanAt(Address, u32),
    Payment(u32, u32),
    PaymentCount(u32),
    Admin,
    PlatformFeeBps,
    Governance,
    WhitelistedAsset(Address),
    /// Link to MultiSigAdmin contract
    MultiSigAdmin,
    /// List of multisig admin addresses
    MultisigAdmins,
    /// Number of admin signatures required to pause/unpause
    MultisigThreshold,
    /// Whether the contract is paused
    IsPaused,
    /// Whether a given signer has already called pause (dedup)
    PauseSigner(Address),
    /// Number of unique signers who have called pause
    PauseSignerCount,
    /// Whether a given signer has already called unpause (dedup)
    UnpauseSigner(Address),
    /// Number of unique signers who have called unpause
    UnpauseSignerCount,
    /// Flash loan fee bps
    FlashLoanFeeBps,
    /// Cooldown timestamp for rate switches
    RateSwitchCooldown(u32),
    /// Uncollected accrued platform fees for Treasury collection
    UncollectedFees,
    // ── Multi-asset collateral vault ──────────────────────────────────────
    /// Per-asset collateral configuration (stored in instance).
    CollateralConfig(Address),
    /// User's deposited collateral positions: map user -> Vec<CollateralEntry>.
    UserCollateral(Address),
    /// Price oracle address that can post price feeds for collateral assets.
    PriceOracle,
    /// Aggregated oracle price samples for a collateral asset.
    OraclePriceSamples(Address),
    /// Ledger timestamp at which the asset's current oracle price was posted.
    OraclePriceUpdatedAt(Address),
    /// TWAP fallback price for a collateral asset.
    OracleTwapPrice(Address),
    /// Borrower Loyalty Rewards contract address
    LoyaltyContract,
    /// Reputation tier per loan (0=None, 1=Beginner, ..., 4=Platinum)
    LoanReputationTier(u32),
    /// Referral Rewards contract address (Issue #266)
    ReferralContract,
    /// Grace period start timestamp for undercollateralized loans (Issue #157)
    GracePeriodStart(u32),
    /// BorrowerReputationContract address — source of truth for tiers and
    /// credit limits (Issue #335)
    ReputationContract,
    /// TreasuryContract that receives collected platform fees (Issue #338)
    Treasury,
    /// SEP-41 token platform fees are denominated in (Issue #338)
    FeeToken,
}

/// Default platform fee = 1 % of interest (100 bps) until governance changes it.
const DEFAULT_PLATFORM_FEE_BPS: u32 = 100;
/// Safety ceiling: the fee can never exceed 10 % of interest (1000 bps),
/// even via a passed proposal.
const MAX_PLATFORM_FEE_BPS: u32 = 1000;

/// Default flash-loan fee = 0.09 % of the borrowed amount (9 bps) — in line
/// with common DeFi flash-loan pricing.
const DEFAULT_FLASH_LOAN_FEE_BPS: u32 = 9;
/// Safety ceiling on the flash-loan fee (500 bps = 5 %).
const MAX_FLASH_LOAN_FEE_BPS: u32 = 500;
/// Oracle prices older than this are not safe for collateral valuation.
const ORACLE_PRICE_MAX_AGE_SECONDS: u64 = 300;

/// Fee for switching rate models: 0.5% of remaining debt (50 bps).
const RATE_SWITCH_FEE_BPS: u32 = 50;

/// Cooldown between rate switches: 24 hours in seconds.
const RATE_SWITCH_COOLDOWN_SECS: u64 = 86_400;
/// Oracle collateral prices older than this cannot be used for borrowing.
pub const MAX_COLLATERAL_PRICE_AGE_SECS: u64 = 3_600;

/// Default collateral factor for assets without explicit config: 75% LTV.
const DEFAULT_COLLATERAL_FACTOR_BPS: u32 = 7500;

/// Price precision: 7 decimal places (matching XLM stroops convention).
const PRICE_PRECISION: i128 = 10_000_000;

/// Maximum allowed collateral factor (95% LTV).
const MAX_COLLATERAL_FACTOR_BPS: u32 = 9500;

/// Minimum allowed collateral factor (10% LTV).
const MIN_COLLATERAL_FACTOR_BPS: u32 = 1000;

/// Minimum borrow amount constraint to prevent spam/dust loans (1 XLM = 10_000_000 stroops).
pub const MIN_BORROW_AMOUNT: i128 = 10_000_000;
/// Loan requests must charge a non-zero, bounded protocol APR.
pub const MIN_INTEREST_RATE_BPS: u32 = 100;
pub const MAX_INTEREST_RATE_BPS: u32 = 5_000;

/// Grace period before liquidation: 12 hours = 43,200 seconds (Issue #157)
const GRACE_PERIOD_SECONDS: u64 = 43_200;

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct LendingContract;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl LendingContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::LoanCount, &0u32);
        // Whitelist XLM as default collateral asset (using dummy address for now)
        // In real implementation, we'd use the native asset identifier
        env.storage()
            .instance()
            .set(&DataKey::WhitelistedAsset(admin.clone()), &true);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Configure multi-sig admin set for pause/unpause.
    /// The original single admin is automatically included.
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

        // Ensure the single admin is included in the multisig list
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

    /// Multi-sig pause: requires `threshold` unique admin signatures.
    /// Each admin calls this once; the contract tracks unique signers.
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

        // Dedup: only count each signer once
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
            // Reset signer tracking for next pause cycle
            env.storage()
                .instance()
                .set(&DataKey::PauseSignerCount, &0u32);
            env.events()
                .publish((symbol_short!("lending"), symbol_short!("paused")), ());
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
            env.events()
                .publish((symbol_short!("lending"), symbol_short!("unpaused")), ());
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

    /// Set the Borrower Loyalty Rewards contract address (admin only).
    pub fn set_loyalty_contract(env: Env, admin: Address, loyalty: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::LoyaltyContract, &loyalty);
        env.events().publish(
            (symbol_short!("lending"), symbol_short!("loyalty")),
            loyalty,
        );
    }

    pub fn get_loyalty_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::LoyaltyContract)
    }

    /// Set the Referral Rewards contract address (admin only, Issue #266).
    /// Leaving it unset simply disables referral payouts.
    pub fn set_referral_contract(env: Env, admin: Address, referral: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ReferralContract, &referral);
        env.events().publish(
            (symbol_short!("lending"), symbol_short!("referral")),
            referral,
        );
    }

    pub fn get_referral_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::ReferralContract)
    }

    /// Set the BorrowerReputationContract address (admin only, Issue #335).
    /// Loan requests read each borrower's tier and credit limit from it, so
    /// `create_loan_request` is rejected until this is configured.
    pub fn set_reputation_contract(env: Env, admin: Address, reputation: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ReputationContract, &reputation);
        env.events().publish(
            (symbol_short!("lending"), symbol_short!("rep")),
            reputation,
        );
    }

    pub fn get_reputation_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::ReputationContract)
    }

    /// Whitelist a new collateral asset ("adding pools"). Multisig-gated —
    /// see `set_multisig_admin`.
    pub fn whitelist_asset(env: Env, caller: Address, asset: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        env.storage()
            .instance()
            .set(&DataKey::WhitelistedAsset(asset), &true);
    }

    /// Check if an asset is whitelisted
    pub fn is_asset_whitelisted(env: Env, asset: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::WhitelistedAsset(asset))
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    /// Sweep accidentally sent unsupported tokens out of the contract (admin only).
    /// Prevents sweeping whitelisted collateral/lending assets to protect contract liquidity and collateral.
    pub fn sweep_tokens(
        env: Env,
        caller: Address,
        token: Address,
        recipient: Address,
        amount: i128,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if amount <= 0 {
            panic!("Sweep amount must be positive");
        }

        if Self::is_asset_whitelisted(env.clone(), token.clone()) {
            panic!("Cannot sweep supported whitelisted asset");
        }

        let token_client = token::Client::new(&env, &token);
        let contract_address = env.current_contract_address();
        let balance = token_client.balance(&contract_address);

        if amount > balance {
            panic!("Insufficient balance to sweep");
        }
        // Uncollected platform fees belong to the treasury (Issue #338).
        if Self::get_fee_token(env.clone()) == Some(token.clone())
            && amount > balance - Self::get_uncollected_fees(env.clone())
        {
            panic!("Cannot sweep uncollected protocol fees");
        }

        token_client.transfer(&contract_address, &recipient, &amount);

        env.events().publish(
            (symbol_short!("lending"), symbol_short!("sweep")),
            (token, recipient, amount),
        );
    }

    // ── DAO governance of the platform fee ──────────────────────────────────────

    /// Link the Governance contract (multisig-gated, one-time bootstrap).
    /// Once set, the platform fee can ONLY be changed by this contract — i.e.
    /// by a successful on-chain vote.
    pub fn set_governance(env: Env, caller: Address, governance: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
    }

    pub fn get_governance(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governance)
            .expect("Governance not configured")
    }

    /// Current platform fee in basis-points of interest (default 100 = 1 %).
    pub fn get_platform_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(DEFAULT_PLATFORM_FEE_BPS)
    }

    /// Update the platform fee. Callable ONLY by the linked Governance contract,
    /// which invokes this after a proposal passes. This is the single on-chain
    /// path to changing the fee — there is intentionally no admin override.
    pub fn set_platform_fee_bps(env: Env, caller: Address, new_fee_bps: u32) {
        caller.require_auth();

        let governance: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governance)
            .expect("Governance not configured");
        if caller != governance {
            panic!("Unauthorised: only Governance can change the platform fee");
        }
        if new_fee_bps > MAX_PLATFORM_FEE_BPS {
            panic!("Fee exceeds MAX_PLATFORM_FEE_BPS");
        }

        let old_fee_bps = Self::get_platform_fee_bps(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &new_fee_bps);

        // Emit event for indexers
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("fee_upd")),
            (symbol_short!("platform"), old_fee_bps, new_fee_bps),
        );
    }

    pub fn get_uncollected_fees(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::UncollectedFees)
            .unwrap_or(0)
    }

    /// Link the TreasuryContract that receives platform fees (admin only,
    /// Issue #338). It is the only destination `collect_fees` pays.
    pub fn set_treasury(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.events()
            .publish((symbol_short!("lending"), symbol_short!("treasury")), treasury);
    }

    pub fn get_treasury(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Treasury)
    }

    /// Set the SEP-41 token platform fees are denominated in, e.g. the
    /// native XLM asset contract (admin only, Issue #338).
    pub fn set_fee_token(env: Env, admin: Address, fee_token: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::FeeToken, &fee_token);
        env.events()
            .publish((symbol_short!("lending"), symbol_short!("fee_tkn")), fee_token);
    }

    pub fn get_fee_token(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::FeeToken)
    }

    /// Transfer all uncollected platform fees to the configured treasury.
    ///
    /// Callable only by the configured treasury contract or an admin
    /// (Issue #338), and `treasury_address` must be the configured treasury —
    /// fees can never be redirected elsewhere. The fee-token transfer and
    /// the reset of `UncollectedFees` happen together, so accounting can no
    /// longer be cleared without the tokens moving. When an admin collects
    /// directly, the treasury is notified so its token balance stays in sync;
    /// when the treasury itself collects, it does that bookkeeping itself.
    pub fn collect_fees(env: Env, caller: Address, treasury_address: Address) -> i128 {
        caller.require_auth();
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .expect("Treasury not configured");
        let caller_is_treasury = caller == treasury;
        if !caller_is_treasury {
            Self::assert_admin(&env, &caller);
        }
        if treasury_address != treasury {
            panic!("Fees can only be collected to the configured treasury");
        }

        let uncollected: i128 = Self::get_uncollected_fees(env.clone());
        if uncollected <= 0 {
            return 0;
        }

        let fee_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::FeeToken)
            .expect("Fee token not configured");
        let token_client = token::Client::new(&env, &fee_token);
        let contract_address = env.current_contract_address();
        if token_client.balance(&contract_address) < uncollected {
            panic!("Insufficient fee token balance to collect fees");
        }

        env.storage()
            .instance()
            .set(&DataKey::UncollectedFees, &0i128);
        token_client.transfer(&contract_address, &treasury, &uncollected);

        if !caller_is_treasury {
            TreasuryFeeClient::new(&env, &treasury).record_protocol_fees(
                &contract_address,
                &fee_token,
                &uncollected,
            );
        }

        env.events().publish(
            (symbol_short!("fees"), symbol_short!("collected")),
            (treasury, fee_token, uncollected),
        );
        uncollected
    }

    // ── Flash loans ──────────────────────────────────────────────────────────

    /// Current flash-loan fee in basis-points of the borrowed amount
    /// (default 9 = 0.09 %).
    pub fn get_flash_loan_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::FlashLoanFeeBps)
            .unwrap_or(DEFAULT_FLASH_LOAN_FEE_BPS)
    }

    /// Update the flash-loan fee ("interest rate table"), multisig-gated.
    /// Capped at `MAX_FLASH_LOAN_FEE_BPS`.
    pub fn set_flash_loan_fee_bps(env: Env, caller: Address, new_fee_bps: u32) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        if new_fee_bps > MAX_FLASH_LOAN_FEE_BPS {
            panic!("Fee exceeds MAX_FLASH_LOAN_FEE_BPS");
        }
        env.storage()
            .instance()
            .set(&DataKey::FlashLoanFeeBps, &new_fee_bps);
    }

    /// Uncollateralized, single-transaction flash loan against the pool's own
    /// balance of `token`.
    pub fn flash_loan(env: Env, receiver: Address, token: Address, amount: i128, params: Bytes) {
        if amount <= 0 {
            panic!("Flash loan amount must be positive");
        }

        let token_client = token::Client::new(&env, &token);
        let pool = env.current_contract_address();
        let balance_before = token_client.balance(&pool);

        if balance_before < amount {
            panic!("Insufficient pool liquidity for flash loan");
        }

        let fee_bps = Self::get_flash_loan_fee_bps(env.clone());
        let fee = amount
            .checked_mul(fee_bps as i128)
            .expect("Overflow computing flash loan fee")
            / 10_000;
        let required_after = balance_before
            .checked_add(fee)
            .expect("Overflow computing required post-loan balance");

        // 2. Disburse the borrowed amount to the receiver.
        token_client.transfer(&pool, &receiver, &amount);

        // 3. Hand control to the receiver's callback.
        let receiver_client = FlashLoanReceiverClient::new(&env, &receiver);
        receiver_client.execute_operation(&token, &amount, &fee, &pool, &params);

        // 4. Enforce full repayment (principal + fee) — or roll back everything.
        let balance_after = token_client.balance(&pool);
        if balance_after < required_after {
            panic!("Flash loan not repaid: insufficient funds returned");
        }

        env.events().publish(
            (symbol_short!("flash"), symbol_short!("loan")),
            (receiver, token, amount, fee),
        );
    }

    // ── Multi-asset collateral vault ──────────────────────────────────────────

    // ── Price Oracle (multisig-gated) ─────────────────────────────────────────

    /// Register or rotate the authorized price oracle address (multisig-gated).
    /// The price oracle can post per-asset USD price feeds used for
    /// normalizing collateral values.
    pub fn set_price_oracle(env: Env, caller: Address, oracle: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        env.storage().instance().set(&DataKey::PriceOracle, &oracle);
        env.events()
            .publish((symbol_short!("oracle"), symbol_short!("set")), oracle);
    }

    /// Get the authorized price oracle address.
    pub fn get_price_oracle(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::PriceOracle)
            .expect("Price oracle not configured")
    }

    /// Store multiple oracle price samples for an asset.
    ///
    /// Each sample represents a provider quote. The price helper takes the
    /// median so a single manipulated provider cannot skew valuation.
    pub fn set_asset_oracle_prices(env: Env, caller: Address, asset: Address, prices: Vec<i128>) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        if prices.is_empty() {
            panic!("At least one oracle price sample is required");
        }
        for price in prices.iter() {
            if price <= 0 {
                panic!("Oracle price samples must be positive");
            }
        }

        if !env
            .storage()
            .instance()
            .has(&DataKey::WhitelistedAsset(asset.clone()))
        {
            panic!("Asset is not whitelisted");
        }

        env.storage()
            .instance()
            .set(&DataKey::OraclePriceSamples(asset.clone()), &prices);
        env.storage()
            .instance()
            .set(&DataKey::OraclePriceUpdatedAt(asset), &env.ledger().timestamp());
    }

    /// Store a TWAP fallback price for an asset.
    pub fn set_asset_twap_price(env: Env, caller: Address, asset: Address, price: i128) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        if price <= 0 {
            panic!("TWAP price must be positive");
        }

        if !env
            .storage()
            .instance()
            .has(&DataKey::WhitelistedAsset(asset.clone()))
        {
            panic!("Asset is not whitelisted");
        }

        env.storage()
            .instance()
            .set(&DataKey::OracleTwapPrice(asset.clone()), &price);
        env.storage()
            .instance()
            .set(&DataKey::OraclePriceUpdatedAt(asset), &env.ledger().timestamp());
    }

    // ── Asset collateral configuration (multisig-gated) ───────────────────────

    /// Configure the collateral parameters for an asset (multisig-gated).
    /// Sets the LTV ratio and volatility used for borrowing power and
    /// liquidation threshold calculations.
    ///
    /// `collateral_factor_bps` — maximum percentage of the asset's value that
    /// can be borrowed, in basis-points (e.g. 8000 = 80% LTV).
    /// Clamped to [MIN_COLLATERAL_FACTOR_BPS, MAX_COLLATERAL_FACTOR_BPS].
    ///
    /// `has_price_oracle` — must be true to use this asset as collateral.
    ///
    /// `volatility_bps` — estimated annualized volatility in bps, used in
    /// dynamic liquidation threshold calculations.
    pub fn set_asset_collateral_config(
        env: Env,
        caller: Address,
        asset: Address,
        config: AssetCollateralConfig,
    ) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        // Validate — must be a whitelisted asset
        if !env
            .storage()
            .instance()
            .has(&DataKey::WhitelistedAsset(asset.clone()))
        {
            panic!("Asset is not whitelisted");
        }

        // Clamp collateral factor to safe bounds
        let clamped_factor = config
            .collateral_factor_bps
            .clamp(MIN_COLLATERAL_FACTOR_BPS, MAX_COLLATERAL_FACTOR_BPS);

        let clamped_volatility = config.volatility_bps.min(10_000); // max 100%

        let safe_config = AssetCollateralConfig {
            collateral_factor_bps: clamped_factor,
            has_price_oracle: config.has_price_oracle,
            volatility_bps: clamped_volatility,
        };

        env.storage()
            .instance()
            .set(&DataKey::CollateralConfig(asset.clone()), &safe_config);

        env.events().publish(
            (symbol_short!("colconf"), symbol_short!("set")),
            (asset, clamped_factor, clamped_volatility),
        );
    }

    /// Get the collateral configuration for an asset.
    /// Returns default config (75% LTV, no oracle, 0 volatility) if not set.
    pub fn get_asset_collateral_config(env: Env, asset: Address) -> AssetCollateralConfig {
        env.storage()
            .instance()
            .get(&DataKey::CollateralConfig(asset.clone()))
            .unwrap_or(AssetCollateralConfig {
                collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
                has_price_oracle: false,
                volatility_bps: 0,
            })
    }

    // ── Collateral deposit / withdraw (borrower-facing) ─────────────────────

    /// Deposit additional collateral to the borrower's vault position.
    /// The caller must be the borrower.
    /// `asset` must be whitelisted.
    /// `amount` must be positive.
    ///
    /// Tokens are pulled from the borrower into contract custody before the
    /// collateral position is updated.
    pub fn deposit_collateral(env: Env, borrower: Address, asset: Address, amount: i128) {
        borrower.require_auth();
        Self::assert_not_paused(&env);

        if amount <= 0 {
            panic!("Collateral amount must be positive");
        }

        // Asset must be whitelisted
        if !env
            .storage()
            .instance()
            .has(&DataKey::WhitelistedAsset(asset.clone()))
        {
            panic!("Asset is not whitelisted");
        }

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&borrower, &env.current_contract_address(), &amount);

        // Get or create user's collateral entries
        let key = DataKey::UserCollateral(borrower.clone());
        let entries: Vec<CollateralEntry> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(&env));

        // Find existing entry or append new one
        let mut found = false;
        let mut new_entries = Vec::new(&env);
        for entry in entries.iter() {
            if entry.asset == asset {
                // Update existing entry
                let new_amount = entry
                    .amount
                    .checked_add(amount)
                    .expect("Overflow adding collateral");
                new_entries.push_back(CollateralEntry {
                    asset: entry.asset.clone(),
                    amount: new_amount,
                });
                found = true;
            } else {
                new_entries.push_back(entry);
            }
        }
        if !found {
            new_entries.push_back(CollateralEntry {
                asset: asset.clone(),
                amount,
            });
        }

        env.storage().persistent().set(&key, &new_entries);

        // Check if health factor improved after deposit (Issue #157)
        // If health factor is now >= 1.0, clear grace periods for all borrower's loans
        let health_factor = Self::get_health_factor(env.clone(), borrower.clone());
        if health_factor >= 10_000 {
            // Health factor is healthy, clear any active grace periods
            let loan_count = Self::get_borrower_loan_count(env.clone(), borrower.clone());
            for i in 0..loan_count {
                let loan_id = Self::get_borrower_loan_at(env.clone(), borrower.clone(), i);
                let grace_key = DataKey::GracePeriodStart(loan_id);
                if env.storage().persistent().has(&grace_key) {
                    env.storage().persistent().remove(&grace_key);
                    
                    // Emit grace period cleared event
                    env.events().publish(
                        (symbol_short!("grace"), symbol_short!("cleared")),
                        (loan_id, borrower.clone(), health_factor),
                    );
                }
            }
        }

        env.events().publish(
            (symbol_short!("collat"), symbol_short!("deposit")),
            (borrower, asset, amount),
        );
    }

    /// Withdraw collateral from the borrower's vault position.
    /// The caller must be the borrower.
    /// `amount` must be positive and not exceed the current balance for that asset.
    ///
    /// After withdrawal, checks that the borrower's remaining collateral
    /// still covers their active loan positions. If not, the withdrawal panics.
    /// This prevents borrowers from withdrawing collateral that would
    /// leave their loans under-collateralized.
    pub fn withdraw_collateral(env: Env, borrower: Address, asset: Address, amount: i128) {
        borrower.require_auth();
        Self::assert_not_paused(&env);

        if amount <= 0 {
            panic!("Withdrawal amount must be positive");
        }

        let key = DataKey::UserCollateral(borrower.clone());
        let entries: Vec<CollateralEntry> = env
            .storage()
            .persistent()
            .get(&key)
            .expect("No collateral entries found for borrower");

        // Find the asset and verify sufficient balance
        let mut found = false;
        let mut remaining_amount = 0i128;
        let mut new_entries = Vec::new(&env);
        for entry in entries.iter() {
            if entry.asset == asset {
                if entry.amount < amount {
                    panic!("Insufficient collateral balance for withdrawal");
                }
                remaining_amount = entry
                    .amount
                    .checked_sub(amount)
                    .expect("Underflow subtracting collateral");
                found = true;
                if remaining_amount > 0 {
                    new_entries.push_back(CollateralEntry {
                        asset: entry.asset.clone(),
                        amount: remaining_amount,
                    });
                }
                // If remaining_amount == 0, we skip — removing the entry entirely
            } else {
                new_entries.push_back(entry);
            }
        }

        if !found {
            panic!("No collateral of the specified asset found");
        }

        // Check borrowing power constraint: after withdrawal, borrowing power
        // must still cover every loan that encumbers collateral (pending,
        // approved and active), so a borrower cannot drain the vault between
        // creating a request and the loan being activated.
        let borrowing_power = Self::compute_borrowing_power_from_entries(&env, &new_entries);
        let total_encumbered_debt: i128 =
            Self::get_total_encumbered_debt_of_borrower(&env, &borrower);

        if borrowing_power < total_encumbered_debt {
            panic!(
                "Withdrawal would leave pending or active loans under-collateralized: borrowing power {} < debt {}",
                borrowing_power, total_encumbered_debt,
            );
        }

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &borrower, &amount);

        // Update storage
        if new_entries.is_empty() {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &new_entries);
        }

        env.events().publish(
            (symbol_short!("collat"), symbol_short!("withdraw")),
            (borrower, asset, amount, remaining_amount),
        );
    }

    // ── Query functions for collateral vault ─────────────────────────────────

    /// Get all collateral entries for a borrower.
    pub fn get_user_collateral_entries(env: Env, borrower: Address) -> Vec<CollateralEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::UserCollateral(borrower))
            .unwrap_or(Vec::new(&env))
    }

    /// Get the total borrowing power for a borrower in the base asset's
    /// smallest unit (stroops for XLM).
    ///
    /// Borrowing power = sum over all collateral positions of:
    ///   amount * price * collateral_factor_bps / 10_000
    ///
    /// Where price is either:
    ///   - The oracle price (if configured), normalized to the base asset
    ///   - Or 1.0 (face value) if no oracle is configured
    pub fn get_borrowing_power(env: Env, borrower: Address) -> i128 {
        let entries = Self::get_user_collateral_entries(env.clone(), borrower);
        Self::compute_borrowing_power_from_entries(&env, &entries)
    }

    /// Get the total collateral value for display purposes (not LTV-adjusted).
    /// Returns the sum of each asset's amount * price, normalized to the
    /// base asset unit.
    pub fn get_total_collateral_value(env: Env, borrower: Address) -> i128 {
        let entries = Self::get_user_collateral_entries(env.clone(), borrower);
        let mut total_value: i128 = 0;
        for entry in entries.iter() {
            let config = Self::get_asset_collateral_config(env.clone(), entry.asset.clone());
            let price = Self::get_asset_price(&env, &entry.asset, &config);
            let value = entry
                .amount
                .checked_mul(price)
                .expect("Overflow computing collateral value")
                / PRICE_PRECISION;
            total_value = total_value
                .checked_add(value)
                .expect("Overflow summing collateral values");
        }
        total_value
    }

    // ── Loan lifecycle ────────────────────────────────────────────────────────

    /// Borrower creates a loan request.
    ///
    /// The borrower's credit limit and reputation tier are read on-chain from
    /// the registered BorrowerReputationContract (Issue #335). The
    /// `max_loan_amount` and `reputation_tier` fields of `request` are
    /// deprecated and ignored — trusting them let a borrower bypass their
    /// limit and claim unearned loyalty rewards.
    ///
    /// The function also checks that the borrower has sufficient borrowing
    /// power (from multi-asset collateral) to cover the requested loan amount.
    pub fn create_loan_request(env: Env, borrower: Address, request: LoanRequestInput) -> u32 {
        borrower.require_auth();
        Self::assert_not_paused(&env);

        let LoanRequestInput {
            amount,
            duration_days,
            interest_rate_bps,
            max_loan_amount: _,
            collateral_entries,
            rate_model,
            reputation_tier: _,
        } = request;

        if amount <= 0 {
            panic!("Loan amount must be positive");
        }
        if amount < MIN_BORROW_AMOUNT {
            panic!("Loan amount below minimum borrow threshold");
        }
        if interest_rate_bps < MIN_INTEREST_RATE_BPS {
            panic!("Interest rate is below the protocol minimum");
        }
        if interest_rate_bps > MAX_INTEREST_RATE_BPS {
            panic!("Interest rate is outside protocol bounds");
        }

        let reputation: Address = env
            .storage()
            .instance()
            .get(&DataKey::ReputationContract)
            .expect("Reputation contract not configured");
        let reputation_client = ReputationClient::new(&env, &reputation);
        let max_loan_amount = reputation_client.calculate_max_loan(&borrower);
        let reputation_tier = reputation_client.get_reputation_tier(&borrower);

        if amount > max_loan_amount {
            panic!("Amount exceeds reputation-based limit");
        }
        if interest_rate_bps < MIN_INTEREST_RATE_BPS {
            panic!("Interest rate is below the protocol minimum");
        }
        if duration_days == 0 || duration_days > 365 {
            panic!("Duration must be between 1 and 365 days");
        }
        if reputation_tier > 4 {
            panic!("Invalid reputation tier");
        }
        if collateral_entries.is_empty() {
            panic!("At least one collateral entry is required");
        }

        // Validate that all collateral assets are whitelisted
        for entry in collateral_entries.iter() {
            if !env
                .storage()
                .instance()
                .has(&DataKey::WhitelistedAsset(entry.asset.clone()))
            {
                panic!("Collateral asset is not whitelisted");
            }
            if entry.amount <= 0 {
                panic!("Each collateral amount must be positive");
            }
        }

        // Check borrowing power: total borrowing power must be >= loan amount
        let borrowing_power = Self::compute_borrowing_power_from_entries(&env, &collateral_entries);

        if borrowing_power < amount {
            panic!(
                "Insufficient borrowing power: {} < {}",
                borrowing_power, amount
            );
        }

        // interest = principal × rate_bps × days / (10_000 × 365)
        let interest = Self::calculate_interest(amount, interest_rate_bps, duration_days);
        // Platform fee = (governance-controlled) fee_bps of interest.
        let fee_bps = Self::get_platform_fee_bps(env.clone());
        let platform_fee = interest
            .checked_mul(fee_bps as i128)
            .expect("Overflow: interest × fee_bps")
            / 10_000;
        let total_due = amount
            .checked_add(interest)
            .expect("Overflow computing total_due");

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LoanCount)
            .unwrap_or(0);
        let loan_id = count + 1;

        let now = env.ledger().timestamp();
        // Compute due_at with overflow protection: days * 86_400 seconds
        let duration_secs: u64 = (duration_days as u64)
            .checked_mul(86_400)
            .expect("Overflow computing loan duration in seconds");
        let due_at = now
            .checked_add(duration_secs)
            .expect("Overflow computing due_at timestamp");

        let loan = LoanRecord {
            id: loan_id,
            borrower: borrower.clone(),
            lender: env.current_contract_address(), // placeholder until approved
            amount,
            duration_days,
            interest_rate_bps,
            total_due,
            remaining_due: total_due,
            created_at: now,
            due_at,
            status: LoanStatus::Pending,
            escrow_id: 0,
            platform_fee,
            rate_model,
            base_rate_bps: interest_rate_bps,
            last_rate_update: now,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        env.storage().instance().set(&DataKey::LoanCount, &loan_id);
        env.storage()
            .persistent()
            .set(&DataKey::LoanReputationTier(loan_id), &reputation_tier);

        let current_fees: i128 = env
            .storage()
            .instance()
            .get(&DataKey::UncollectedFees)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::UncollectedFees, &(current_fees + platform_fee));

        // Track per-borrower list
        Self::store_borrower_loan_id(&env, &borrower, loan_id);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("request")),
            (
                loan_id,
                borrower,
                amount,
                duration_days,
                interest_rate_bps,
                total_due,
                due_at,
            ),
        );

        loan_id
    }

    /// Lender approves a pending loan.
    pub fn approve_loan(env: Env, lender: Address, loan_id: u32, escrow_id: u32) {
        lender.require_auth();
        Self::assert_not_paused(&env);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Pending {
            panic!("Loan is not in PENDING state");
        }

        loan.lender = lender.clone();
        loan.escrow_id = escrow_id;
        loan.status = LoanStatus::Approved;

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        Self::push_loan_id_for_lender(&env, &lender, loan_id);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("approved")),
            (loan_id, lender, escrow_id),
        );
    }

    /// Lender revokes an approved loan (within the 1-hour escrow window).
    /// The EscrowContract's `revoke_hold` must be called separately.
    pub fn revoke_approval(env: Env, lender: Address, loan_id: u32) {
        lender.require_auth();

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.lender != lender {
            panic!("Caller is not the lender");
        }
        if loan.status != LoanStatus::Approved {
            panic!("Loan is not in APPROVED state");
        }

        loan.status = LoanStatus::Pending;
        loan.lender = env.current_contract_address();
        loan.escrow_id = 0;
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        env.events()
            .publish((symbol_short!("loan"), symbol_short!("revoked")), loan_id);
    }

    /// Admin/backend activates the loan once escrow disbursement is confirmed.
    pub fn activate_loan(env: Env, caller: Address, loan_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::assert_not_paused(&env);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Approved {
            panic!("Loan must be APPROVED before activation");
        }
        loan.status = LoanStatus::Active;
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        env.events()
            .publish((symbol_short!("loan"), symbol_short!("active")), loan_id);

        // Pay the borrower's referrer, if they were invited by someone
        // (Issue #266). The referral contract itself decides whether a bonus
        // is due; it returns 0 for an unregistered or already-paid borrower.
        // Any failure is swallowed by ReferralClient — a referral must never
        // stop a loan from activating.
        if let Some(referral) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::ReferralContract)
        {
            let client = ReferralClient::new(&env, &referral);
            let _bonus = client.claim_referral_bonus(
                &env,
                &env.current_contract_address(),
                &loan.borrower,
                &loan.amount,
            );
        }
    }

    /// Record a repayment (partial or full).
    /// Actual XLM moves via PAYMENT op; admin calls this after Horizon confirm.
    pub fn record_payment(env: Env, caller: Address, loan_id: u32, amount: i128) -> LoanStatus {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Active {
            panic!("Loan is not ACTIVE");
        }
        if amount <= 0 {
            panic!("Payment amount must be positive");
        }

        // Store payment record
        let payment_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PaymentCount(loan_id))
            .unwrap_or(0);
        let new_count = payment_count + 1;
        let payment = PaymentRecord {
            loan_id,
            amount,
            paid_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Payment(loan_id, new_count), &payment);
        env.storage()
            .persistent()
            .set(&DataKey::PaymentCount(loan_id), &new_count);

        // Reduce remaining balance (clamped to 0)
        if amount >= loan.remaining_due {
            loan.remaining_due = 0;
            loan.status = LoanStatus::Repaid;

            // Distribute loyalty rewards if repaid on time
            let now = env.ledger().timestamp();
            if now <= loan.due_at {
                if let Some(loyalty) = env
                    .storage()
                    .instance()
                    .get::<DataKey, Address>(&DataKey::LoyaltyContract)
                {
                    let tier: u32 = env
                        .storage()
                        .persistent()
                        .get(&DataKey::LoanReputationTier(loan_id))
                        .unwrap_or(0);
                    let duration_days = loan.duration_days;
                    let loan_amount = loan.amount;
                    let caller = env.current_contract_address();

                    let client = LoyaltyClient::new(&env, &loyalty);
                    let _reward = client.distribute_reward(
                        &env,
                        &caller,
                        &loan.borrower,
                        &loan_amount,
                        &duration_days,
                        &tier,
                    );
                }
            }
        } else {
            loan.remaining_due -= amount;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        env.events().publish(
            (symbol_short!("loan"), symbol_short!("payment")),
            (loan_id, amount, loan.remaining_due, loan.status.clone()),
        );
        loan.status
    }

    /// Mark a loan as defaulted (called by DefaultManagementContract or admin).
    /// Now includes grace period check (Issue #157) - borrowers get 12 hours
    /// to top up collateral before liquidation can proceed.
    pub fn mark_defaulted(env: Env, caller: Address, loan_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::assert_not_paused(&env);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Active {
            panic!("Only ACTIVE loans can be defaulted");
        }

        // Check if loan is eligible for liquidation (respects 12-hour grace period)
        if !Self::check_liquidation_eligibility(env.clone(), loan_id) {
            panic!("Loan is not eligible for liquidation yet - grace period active or health factor is healthy");
        }

        loan.status = LoanStatus::Defaulted;
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        // Clean up grace period tracking since loan is now defaulted
        env.storage().persistent().remove(&DataKey::GracePeriodStart(loan_id));

        // Emit liquidation event with health factor context
        let health_factor = Self::get_health_factor(env.clone(), loan.borrower.clone());
        env.events().publish(
            (symbol_short!("loan"), symbol_short!("default")),
            (loan_id, health_factor),
        );
    }

    // ── Rate model switching ─────────────────────────────────────────────────

    /// Borrower switches their loan between Fixed and Floating rate models.
    /// Charges a 0.5% fee on remaining debt and enforces a 24h cooldown.
    pub fn switch_rate_model(env: Env, borrower: Address, loan_id: u32) {
        borrower.require_auth();

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.borrower != borrower {
            panic!("Caller is not the borrower");
        }
        if loan.status != LoanStatus::Active {
            panic!("Can only switch rate model on ACTIVE loans");
        }

        // Enforce cooldown
        let now = env.ledger().timestamp();
        let last_switch: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RateSwitchCooldown(loan_id))
            .unwrap_or(0);
        if last_switch > 0 && (now - last_switch) < RATE_SWITCH_COOLDOWN_SECS {
            panic!("Rate switch cooldown not elapsed (24h required)");
        }

        // Charge switch fee: 0.5% of remaining debt
        let fee = loan
            .remaining_due
            .checked_mul(RATE_SWITCH_FEE_BPS as i128)
            .expect("Overflow computing switch fee")
            / 10_000;
        loan.remaining_due = loan
            .remaining_due
            .checked_add(fee)
            .expect("Overflow adding switch fee");
        loan.total_due = loan
            .total_due
            .checked_add(fee)
            .expect("Overflow adding switch fee to total");

        // Toggle model
        loan.rate_model = match loan.rate_model {
            InterestRateModel::Fixed => InterestRateModel::Floating,
            InterestRateModel::Floating => InterestRateModel::Fixed,
        };
        loan.last_rate_update = now;

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        env.storage()
            .persistent()
            .set(&DataKey::RateSwitchCooldown(loan_id), &now);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("rswitch")),
            (loan_id, loan.rate_model, fee),
        );
    }

    /// Admin updates the floating rate for a loan (called on state-changing interactions).
    /// Only applies to Floating-rate loans. Recalculates remaining interest.
    pub fn update_floating_rate(env: Env, caller: Address, loan_id: u32, new_rate_bps: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.rate_model != InterestRateModel::Floating {
            panic!("Loan is not using floating rate model");
        }
        if loan.status != LoanStatus::Active {
            panic!("Can only update rate on ACTIVE loans");
        }

        let now = env.ledger().timestamp();

        // Compute remaining days
        let remaining_secs = loan.due_at.saturating_sub(now);
        let remaining_days = (remaining_secs / 86_400) as u32;

        // Recalculate: amount already paid stays, recompute interest on remaining principal
        let paid_so_far = loan.total_due - loan.remaining_due;
        let remaining_principal = if loan.remaining_due > 0 {
            // Approximate remaining principal from remaining_due and old rate
            loan.amount
        } else {
            0
        };

        let new_interest =
            Self::calculate_interest(remaining_principal, new_rate_bps, remaining_days);
        let new_total_due = loan
            .amount
            .checked_add(new_interest)
            .expect("Overflow recomputing total_due");
        loan.total_due = new_total_due;
        loan.remaining_due = new_total_due
            .checked_sub(paid_so_far)
            .expect("Underflow computing new remaining_due");
        loan.interest_rate_bps = new_rate_bps;
        loan.last_rate_update = now;

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("ratechg")),
            (loan_id, new_rate_bps, loan.remaining_due),
        );
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    pub fn get_loan(env: Env, loan_id: u32) -> LoanRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Loan(loan_id))
            .expect("Loan not found")
    }

    /// Reputation tier snapshotted from the BorrowerReputationContract when
    /// the loan was created (0=None … 4=Platinum). Used for loyalty rewards.
    pub fn get_loan_reputation_tier(env: Env, loan_id: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LoanReputationTier(loan_id))
            .unwrap_or(0)
    }

    pub fn get_loan_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::LoanCount)
            .unwrap_or(0)
    }

    /// Get the minimum allowed borrow amount in stroops (1 XLM = 10_000_000 stroops).
    pub fn get_min_borrow_amount(_env: Env) -> i128 {
        MIN_BORROW_AMOUNT
    }

    /// Check whether a loan is overdue.
    pub fn is_overdue(env: Env, loan_id: u32) -> bool {
        let loan = Self::get_loan(env.clone(), loan_id);
        loan.status == LoanStatus::Active && env.ledger().timestamp() > loan.due_at
    }

    /// Days overdue (0 if not overdue yet).
    pub fn days_overdue(env: Env, loan_id: u32) -> u64 {
        let loan = Self::get_loan(env.clone(), loan_id);
        let now = env.ledger().timestamp();
        if loan.status == LoanStatus::Active && now > loan.due_at {
            (now - loan.due_at) / 86_400
        } else {
            0
        }
    }

    pub fn get_payment_count(env: Env, loan_id: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::PaymentCount(loan_id))
            .unwrap_or(0)
    }

    pub fn get_payment(env: Env, loan_id: u32, payment_index: u32) -> PaymentRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Payment(loan_id, payment_index))
            .expect("Payment not found")
    }

    /// Calculate dynamic liquidation threshold based on borrower reputation score
    /// and asset volatility.
    ///
    /// - Base threshold: 7500 basis points (75.00%).
    /// - Reputation bonus: adds `reputation_score * 1.5` basis points (max 1500 bps).
    /// - Volatility penalty: subtracts `50%` of asset volatility bps.
    /// - Clamped between 5000 bps (50.00%) and 9000 bps (90.00%).
    /// - Uses checked arithmetic to prevent overflow.
    pub fn calculate_liquidation_threshold(
        _env: Env,
        borrower_reputation_score: u32,
        asset_volatility_bps: u32,
    ) -> u32 {
        let base_threshold: u32 = 7500;

        // reputation_bonus = borrower_reputation_score * 1.5
        let reputation_bonus = (borrower_reputation_score as u64)
            .checked_mul(15)
            .and_then(|v| v.checked_div(10))
            .expect("Overflow calculating reputation bonus");

        // volatility_penalty = asset_volatility_bps / 2
        let volatility_penalty = (asset_volatility_bps as u64)
            .checked_div(2)
            .expect("Overflow calculating volatility penalty");

        let threshold = (base_threshold as u64)
            .checked_add(reputation_bonus)
            .expect("Overflow adding reputation bonus")
            .saturating_sub(volatility_penalty);

        threshold.clamp(5000, 9000) as u32
    }

    /// Number of loans a borrower has created.
    pub fn get_borrower_loan_count(env: Env, borrower: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::BorrowerLoanCount(borrower))
            .unwrap_or(0)
    }

    /// Loan ID at a given index for a borrower (0-based).
    pub fn get_borrower_loan_at(env: Env, borrower: Address, index: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::BorrowerLoanAt(borrower, index))
            .expect("Index out of bounds")
    }

    /// Number of loans a lender has approved.
    pub fn get_lender_loan_count(env: Env, lender: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LenderLoanCount(lender))
            .unwrap_or(0)
    }

    /// Loan ID at a given index for a lender (0-based).
    pub fn get_lender_loan_at(env: Env, lender: Address, index: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LenderLoanAt(lender, index))
            .expect("Index out of bounds")
    }

    /// Get the total active debt for a borrower across all their active loans.
    /// Used to enforce collateralization on withdrawal.
    fn get_total_active_debt_of_borrower(env: &Env, borrower: &Address) -> i128 {
        let loan_count = Self::get_borrower_loan_count(env.clone(), borrower.clone());
        let mut total_debt: i128 = 0;
        for i in 0..loan_count {
            let loan_id = Self::get_borrower_loan_at(env.clone(), borrower.clone(), i);
            let loan = Self::get_loan(env.clone(), loan_id);
            if loan.status == LoanStatus::Active || loan.status == LoanStatus::Approved {
                total_debt = total_debt
                    .checked_add(loan.remaining_due)
                    .expect("Overflow summing active debt");
            }
        }
        total_debt
    }

    /// Get the total debt that encumbers a borrower's collateral: loans in
    /// `Pending`, `Approved` or `Active` status. Loans that are repaid,
    /// defaulted or cancelled release their collateral lock.
    /// Used to enforce collateralization on withdrawal.
    fn get_total_encumbered_debt_of_borrower(env: &Env, borrower: &Address) -> i128 {
        let loan_count = Self::get_borrower_loan_count(env.clone(), borrower.clone());
        let mut total_debt: i128 = 0;
        for i in 0..loan_count {
            let loan_id = Self::get_borrower_loan_at(env.clone(), borrower.clone(), i);
            let loan = Self::get_loan(env.clone(), loan_id);
            if loan.status == LoanStatus::Pending
                || loan.status == LoanStatus::Approved
                || loan.status == LoanStatus::Active
            {
                total_debt = total_debt
                    .checked_add(loan.remaining_due)
                    .expect("Overflow summing encumbered debt");
            }
        }
        total_debt
    }

    /// Calculate the health factor for a borrower.
    /// 
    /// Health Factor = (borrowing_power * 10_000) / total_active_debt
    /// 
    /// - Health Factor >= 10_000 means the position is healthy (>= 1.0)
    /// - Health Factor < 10_000 means undercollateralized (< 1.0)
    /// - Returns u32::MAX if total_debt is 0 (no debt = infinitely healthy)
    /// 
    /// Example: If borrowing_power = 100 XLM and debt = 80 XLM,
    /// health_factor = (100 * 10_000) / 80 = 12_500 (1.25x)
    pub fn get_health_factor(env: Env, borrower: Address) -> u32 {
        let total_debt = Self::get_total_active_debt_of_borrower(&env, &borrower);
        
        // No debt means infinitely healthy
        if total_debt <= 0 {
            return u32::MAX;
        }
        
        let entries = Self::get_user_collateral_entries(env.clone(), borrower);
        let borrowing_power = Self::compute_borrowing_power_from_entries(&env, &entries);
        
        // If no borrowing power but has debt, health factor is 0
        if borrowing_power <= 0 {
            return 0;
        }
        
        // Calculate: (borrowing_power * 10_000) / total_debt
        let numerator = borrowing_power
            .checked_mul(10_000)
            .expect("Overflow calculating health factor numerator");
        
        let health_factor = numerator
            .checked_div(total_debt)
            .expect("Division by zero in health factor");
        
        // Cap at u32::MAX for very healthy positions
        if health_factor > u32::MAX as i128 {
            u32::MAX
        } else {
            health_factor as u32
        }
    }

    /// Check if a loan is eligible for liquidation (Issue #157).
    /// 
    /// Returns true if the loan can be liquidated, false otherwise.
    /// 
    /// Liquidation eligibility requirements:
    /// 1. The loan must have an active borrower with health factor < 1.0 (< 10_000 bps)
    /// 2. If this is the first time undercollateralized, grace period starts
    /// 3. After 12-hour grace period expires, liquidation is allowed
    /// 
    /// This gives borrowers time to top up collateral before liquidation.
    pub fn check_liquidation_eligibility(env: Env, loan_id: u32) -> bool {
        let loan = Self::get_loan(env.clone(), loan_id);
        
        // Only active loans can be liquidated
        if loan.status != LoanStatus::Active {
            return false;
        }
        
        let health_factor = Self::get_health_factor(env.clone(), loan.borrower.clone());
        
        // If health factor >= 1.0 (10_000 bps), position is healthy
        if health_factor >= 10_000 {
            // Clear any existing grace period since position is now healthy
            if env.storage().persistent().has(&DataKey::GracePeriodStart(loan_id)) {
                env.storage().persistent().remove(&DataKey::GracePeriodStart(loan_id));
            }
            return false;
        }
        
        // Health factor < 1.0, check grace period
        let now = env.ledger().timestamp();
        let grace_start: Option<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::GracePeriodStart(loan_id));
        
        match grace_start {
            None => {
                // First time undercollateralized - start grace period
                env.storage()
                    .persistent()
                    .set(&DataKey::GracePeriodStart(loan_id), &now);
                
                // Emit grace period start event
                env.events().publish(
                    (symbol_short!("grace"), symbol_short!("start")),
                    (loan_id, loan.borrower.clone(), health_factor, now),
                );
                
                false // Not eligible yet, grace period just started
            }
            Some(start_time) => {
                let elapsed = now.saturating_sub(start_time);
                
                if elapsed >= GRACE_PERIOD_SECONDS {
                    // Grace period expired, loan is eligible for liquidation
                    true
                } else {
                    // Still within grace period
                    false
                }
            }
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// Compute borrowing power from a set of collateral entries.
    ///
    /// Borrowing power = sum over entries of:
    ///   (amount * price * collateral_factor_bps) / (PRICE_PRECISION * 10_000)
    ///
    /// Where `price` is a fresh oracle price.
    fn compute_borrowing_power_from_entries(env: &Env, entries: &Vec<CollateralEntry>) -> i128 {
        let mut total_power: i128 = 0;
        for entry in entries.iter() {
            let config = Self::get_asset_collateral_config(env.clone(), entry.asset.clone());
            let price = Self::get_asset_price(env, &entry.asset, &config);
            // Adjusted value = amount * price / PRICE_PRECISION (gives value in base units)
            let value = entry
                .amount
                .checked_mul(price)
                .expect("Overflow computing entry value")
                / PRICE_PRECISION; // normalize price
                                   // Apply collateral factor
            let adjusted = value
                .checked_mul(config.collateral_factor_bps as i128)
                .expect("Overflow applying collateral factor")
                / 10_000;
            total_power = total_power
                .checked_add(adjusted)
                .expect("Overflow summing borrowing power");
        }
        total_power
    }

    /// Get the price of an asset in base asset units (stroops-equivalent).
    ///
    /// The price is stored as:
    ///   price = (amount of base asset) * PRICE_PRECISION / (amount of collateral asset)
    ///
    /// For example, if 1 XLM = $0.10 USD, the price would be:
    ///   (1 XLM in stroops = 10_000_000) * PRICE_PRECISION / 1 = 10_000_000 * 10_000_000 / 1
    ///
    fn get_asset_price(env: &Env, asset: &Address, config: &AssetCollateralConfig) -> i128 {
        if !config.has_price_oracle {
            panic!("Collateral asset has no active price oracle: Collateral asset requires a configured price oracle");
        }

        let updated_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OraclePriceUpdatedAt(asset.clone()))
            .expect("No oracle price registered for collateral asset");
        if env.ledger().timestamp() > updated_at + ORACLE_PRICE_MAX_AGE_SECONDS {
            panic!("Collateral oracle price is stale: Oracle price for collateral asset is stale");
        }

        let samples: Vec<i128> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePriceSamples(asset.clone()))
            .unwrap_or(Vec::new(env));
        if !samples.is_empty() {
            return Self::median_price(env, &samples);
        }

        if let Some(twap_price) = env
            .storage()
            .instance()
            .get::<DataKey, i128>(&DataKey::OracleTwapPrice(asset.clone()))
        {
            return twap_price;
        }

        panic!("No oracle price registered for collateral asset");
    }

    fn median_price(env: &Env, prices: &Vec<i128>) -> i128 {
        let len = prices.len();
        if len == 0 {
            panic!("No oracle price samples available");
        }

        let mut remaining = Vec::new(env);
        for price in prices.iter() {
            remaining.push_back(price);
        }

        let midpoint = len / 2;
        let even = len.is_multiple_of(2);
        let mut lower = 0i128;

        for step in 0..=midpoint {
            let mut min_idx: u32 = 0;
            let mut min_value = remaining.get(0).expect("No oracle price samples available");

            let mut idx: u32 = 1;
            while idx < remaining.len() {
                let value = remaining
                    .get(idx)
                    .expect("No oracle price samples available");
                if value < min_value {
                    min_value = value;
                    min_idx = idx;
                }
                idx += 1;
            }

            remaining.remove(min_idx);

            if !even && step == midpoint {
                return min_value;
            }

            if even {
                if step == midpoint - 1 {
                    lower = min_value;
                }
                if step == midpoint {
                    return lower
                        .checked_add(min_value)
                        .expect("Overflow computing median price")
                        / 2;
                }
            }
        }

        panic!("Unable to compute median oracle price")
    }

    /// interest = principal × rate_bps × days / (10_000 × 365)
    ///
    /// Uses checked arithmetic so that absurdly large principals or rates
    /// cause an explicit panic instead of silent integer wrap-around.
    fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> i128 {
        let numerator = principal
            .checked_mul(rate_bps as i128)
            .expect("Overflow: principal × rate_bps")
            .checked_mul(days as i128)
            .expect("Overflow: (principal × rate_bps) × days");
        numerator / (10_000_i128 * 365)
    }

    fn store_borrower_loan_id(env: &Env, borrower: &Address, loan_id: u32) {
        let count_key = DataKey::BorrowerLoanCount(borrower.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::BorrowerLoanAt(borrower.clone(), count), &loan_id);
        env.storage().persistent().set(&count_key, &(count + 1));
    }

    fn push_loan_id_for_lender(env: &Env, lender: &Address, loan_id: u32) {
        let count_key = DataKey::LenderLoanCount(lender.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::LenderLoanAt(lender.clone(), count), &loan_id);
        env.storage().persistent().set(&count_key, &(count + 1));
    }

    fn assert_admin(env: &Env, caller: &Address) {
        // Check multisig admins first, then fall back to single admin
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

#[cfg(test)]
mod test;
