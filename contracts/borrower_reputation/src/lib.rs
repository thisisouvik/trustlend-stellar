#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String, Vec, BytesN};

// ─── Types ────────────────────────────────────────────────────────────────────

/// Reputation tiers — determine loan limits and interest rates.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum ReputationTier {
    None,
    Beginner,
    Silver,
    Gold,
    Platinum,
}

/// Reputation events — each one carries a fixed point delta.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum ReputationEvent {
    TestLoanRepaid,    // +50 pts
    LoanRepaidOnTime,  // +20 pts
    LoanPaidEarly,     // +30 pts
    LoanLate1Day,      // -5  pts
    LoanLate7Days,     // -50 pts
    LoanDefaulted,     // -100 pts
    LateWarning,       // -50 pts (applied on Day 8 of overdue)
}

/// Bitmask flags for BorrowerProfile to pack multiple boolean flags into a single u32.
pub const FLAG_IS_FROZEN: u32 = 1 << 0;   // Bit 0: Account is frozen
pub const FLAG_IS_ACTIVE: u32 = 1 << 1;   // Bit 1: Account is active
pub const FLAG_IS_VERIFIED: u32 = 1 << 2; // Bit 2: KYC / identity verified
pub const FLAG_ZK_UPGRADED: u32 = 1 << 3; // Bit 3: Upgraded via ZK credit proof

/// Full on-chain borrower profile stored in persistent ledger storage.
#[contracttype]
#[derive(Clone)]
pub struct BorrowerProfile {
    pub address: Address,
    /// Raw score: 0..=1000+
    pub reputation_score: i128,
    pub reputation_tier: ReputationTier,
    /// Total XLM ever borrowed (stroops)
    pub total_borrowed: i128,
    /// Total XLM ever repaid (stroops)
    pub total_repaid: i128,
    pub default_count: u32,
    /// Successful loans repaid
    pub loan_count: u32,
    /// Ledger timestamp of profile creation
    pub created_at: u64,
    /// Packed bitmask flags (is_frozen, is_active, is_verified, zk_upgraded, etc.)
    pub flags: u32,
    pub freeze_reason: String,
}

impl BorrowerProfile {
    #[inline]
    pub fn is_frozen(&self) -> bool {
        (self.flags & FLAG_IS_FROZEN) != 0
    }

    #[inline]
    pub fn set_frozen(&mut self, frozen: bool) {
        if frozen {
            self.flags |= FLAG_IS_FROZEN;
            self.flags &= !FLAG_IS_ACTIVE;
        } else {
            self.flags &= !FLAG_IS_FROZEN;
            self.flags |= FLAG_IS_ACTIVE;
        }
    }

    #[inline]
    pub fn is_active(&self) -> bool {
        (self.flags & FLAG_IS_ACTIVE) != 0
    }

    #[inline]
    pub fn set_active(&mut self, active: bool) {
        if active {
            self.flags |= FLAG_IS_ACTIVE;
        } else {
            self.flags &= !FLAG_IS_ACTIVE;
        }
    }

    #[inline]
    pub fn is_verified(&self) -> bool {
        (self.flags & FLAG_IS_VERIFIED) != 0
    }

    #[inline]
    pub fn set_verified(&mut self, verified: bool) {
        if verified {
            self.flags |= FLAG_IS_VERIFIED;
        } else {
            self.flags &= !FLAG_IS_VERIFIED;
        }
    }

    #[inline]
    pub fn is_zk_upgraded(&self) -> bool {
        (self.flags & FLAG_ZK_UPGRADED) != 0
    }

    #[inline]
    pub fn set_zk_upgraded(&mut self, upgraded: bool) {
        if upgraded {
            self.flags |= FLAG_ZK_UPGRADED;
        } else {
            self.flags &= !FLAG_ZK_UPGRADED;
        }
    }
}

/// Verified off-chain credit data ingested from a Decentralized Credit Oracle.
///
/// An authorized off-chain oracle (a Node service — see `scripts/oracle-post-credit-score.mjs`)
/// aggregates Web2 signals (utility-bill history, mobile-money / telecom payments,
/// banking history, etc.), normalises them to a single `credit_score` and posts it
/// on-chain. The contract uses it to *increase* a borrower's maximum loan limit.
#[contracttype]
#[derive(Clone)]
pub struct OracleCreditData {
    /// Normalised off-chain credit score, 0..=`MAX_ORACLE_SCORE`.
    pub credit_score: u32,
    /// Number of distinct verified Web2 data sources backing this score
    /// (e.g. 3 = utility + telecom + banking).
    pub data_sources: u32,
    /// Resulting max-loan boost in basis-points (10_000 = +100 %), derived
    /// deterministically from `credit_score` and capped at `MAX_LIMIT_BOOST_BPS`.
    pub loan_limit_boost_bps: u32,
    /// Free-form provider tag, e.g. "plaid", "mobile-money", "experian".
    pub provider: String,
    /// Ledger timestamp when the oracle posted this record.
    pub updated_at: u64,
}

/// Ledger storage keys.
#[contracttype]
pub enum DataKey {
    BorrowerProfile(Address),
    /// Stores the contract admin Address
    Admin,
    /// Stores the authorized Credit Oracle Address (set by admin)
    Oracle,
    /// Stores the latest OracleCreditData for a borrower
    OracleData(Address),
    MultiSigAdmin,
    MultisigAdmins,
    MultisigThreshold,
    IsPaused,
    PauseSigner(Address),
    PauseSignerCount,
    UnpauseSigner(Address),
    UnpauseSignerCount,
    ZkVerifier,
}

// ─── Oracle constants ───────────────────────────────────────────────────────────

/// Maximum normalised credit score the oracle may post.
const MAX_ORACLE_SCORE: u32 = 1000;
/// Hard cap on the max-loan boost an oracle score can grant (10_000 bps = +100 %).
const MAX_LIMIT_BOOST_BPS: u32 = 10_000;
/// How long an oracle record is considered fresh (90 days, in seconds).
/// Stale records are ignored when computing the max loan.
const ORACLE_VALIDITY_SECONDS: u64 = 90 * 24 * 60 * 60;

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct BorrowerReputationContract;

#[contractimpl]
impl BorrowerReputationContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn __constructor(env: Env, admin: Address) {
        Self::init_internal(&env, admin);
    }

    /// One-time init — must be called right after deployment.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        Self::init_internal(&env, admin);
    }

    fn init_internal(env: &Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Configure multi-sig admin set for pause/unpause.
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
        if !final_admins.iter().any(|a| a == admin) {
            final_admins.push_back(admin);
        }

        env.storage().instance().set(&DataKey::MultisigThreshold, &threshold);
        env.storage().instance().set(&DataKey::MultisigAdmins, &final_admins);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage().instance().set(&DataKey::PauseSignerCount, &0u32);
        env.storage().instance().set(&DataKey::UnpauseSignerCount, &0u32);
    }

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
            env.storage().instance().set(&DataKey::PauseSignerCount, &0u32);
            env.events().publish(
                (symbol_short!("rep"), symbol_short!("paused")),
                (),
            );
        }
    }

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
            env.storage().instance().set(&DataKey::UnpauseSignerCount, &0u32);
            env.events().publish(
                (symbol_short!("rep"), symbol_short!("unpaused")),
                (),
            );
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

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    // ── Borrower profile ──────────────────────────────────────────────────────

    /// Called by borrower after KYC is approved (borrower signs the tx).
    pub fn init_borrower(env: Env, borrower: Address) {
        borrower.require_auth();
        let key = DataKey::BorrowerProfile(borrower.clone());
        if env.storage().persistent().has(&key) {
            panic!("Profile already exists");
        }
        let profile = BorrowerProfile {
            address: borrower,
            reputation_score: 0,
            reputation_tier: ReputationTier::None,
            total_borrowed: 0,
            total_repaid: 0,
            default_count: 0,
            loan_count: 0,
            created_at: env.ledger().timestamp(),
            flags: FLAG_IS_ACTIVE,
            freeze_reason: String::from_str(&env, ""),
        };
        env.storage().persistent().set(&key, &profile);
    }

    pub fn has_profile(env: Env, borrower: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::BorrowerProfile(borrower))
    }

    pub fn get_profile(env: Env, borrower: Address) -> BorrowerProfile {
        env.storage()
            .persistent()
            .get(&DataKey::BorrowerProfile(borrower))
            .expect("Profile not found")
    }

    /// Raw reputation score, or 0 if the borrower has no profile.
    /// Used by the Governance contract as reputation-weighted voting power.
    pub fn get_reputation_score(env: Env, borrower: Address) -> i128 {
        env.storage()
            .persistent()
            .get::<DataKey, BorrowerProfile>(&DataKey::BorrowerProfile(borrower))
            .map(|p| p.reputation_score)
            .unwrap_or(0)
    }

    // ── Loan eligibility ──────────────────────────────────────────────────────

    /// Max loan in stroops (1 XLM = 10_000_000 stroops).
    ///
    /// Base limit comes from the borrower's reputation tier. If the borrower has
    /// *fresh* oracle credit data, the limit is boosted by
    /// `base * loan_limit_boost_bps / 10_000`. Stale records are ignored.
    pub fn calculate_max_loan(env: Env, borrower: Address) -> i128 {
        let profile = Self::get_profile(env.clone(), borrower.clone());
        let base = Self::tier_max_loan(&profile.reputation_tier);
        if profile.is_frozen() {
            return base; // frozen accounts get no oracle boost
        }
        Self::apply_oracle_boost(&env, &borrower, base)
    }

    /// Interest rate in basis-points (1500 = 15.00 % APY).
    pub fn calculate_interest_rate(env: Env, borrower: Address) -> u32 {
        let profile = Self::get_profile(env, borrower);
        Self::tier_interest_rate(&profile.reputation_tier)
    }

    /// Reputation tier as a numeric index
    /// (0=None, 1=Beginner, 2=Silver, 3=Gold, 4=Platinum).
    ///
    /// Used by the LendingContract to snapshot a borrower's verified tier at
    /// loan creation, so it never has to trust a client-supplied value.
    pub fn get_reputation_tier(env: Env, borrower: Address) -> u32 {
        let profile = Self::get_profile(env, borrower);
        Self::tier_index(&profile.reputation_tier)
    }

    /// One-time bootstrap linking the MultiSigAdmin contract (admin only).
    /// Once set, `set_oracle` can ONLY be called by this address — a
    /// compromised single admin key can no longer redirect who is trusted to
    /// write credit-score data.
    pub fn set_multisig_admin(env: Env, admin: Address, multisig: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if env.storage().instance().has(&DataKey::MultiSigAdmin) {
            panic!("Multisig admin already configured");
        }
        env.storage().instance().set(&DataKey::MultiSigAdmin, &multisig);
        let mut msig_admins = Vec::new(&env);
        msig_admins.push_back(multisig);
        env.storage().instance().set(&DataKey::MultisigAdmins, &msig_admins);
    }

    pub fn get_multisig_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::MultiSigAdmin)
            .expect("Multisig admin not configured")
    }

    // ── Decentralized Credit Oracle ────────────────────────────────────────────

    /// Register / rotate the authorized Credit Oracle address. Multisig-gated
    /// — see `set_multisig_admin`. Only this oracle address may call
    /// `submit_credit_score`.
    pub fn set_oracle(env: Env, caller: Address, oracle: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.events()
            .publish((symbol_short!("oracle"), symbol_short!("set")), oracle);
    }

    /// Read the currently authorized oracle address.
    pub fn get_oracle(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Oracle)
            .expect("Oracle not configured")
    }

    /// Ingest verified off-chain credit data for a borrower.
    ///
    /// Must be signed by the authorized oracle (see `set_oracle`). The off-chain
    /// service is responsible for verifying the Web2 sources and normalising them
    /// to `credit_score` (0..=`MAX_ORACLE_SCORE`). The resulting boost is derived
    /// deterministically on-chain so the mapping is auditable.
    pub fn submit_credit_score(
        env: Env,
        oracle: Address,
        borrower: Address,
        credit_score: u32,
        data_sources: u32,
        provider: String,
    ) {
        oracle.require_auth();
        Self::assert_oracle(&env, &oracle);

        if credit_score > MAX_ORACLE_SCORE {
            panic!("credit_score exceeds MAX_ORACLE_SCORE");
        }

        // Borrower must have an on-chain profile, and must not be frozen.
        let profile = Self::get_profile(env.clone(), borrower.clone());
        if profile.is_frozen() {
            panic!("Cannot post oracle data for a frozen account");
        }

        let boost_bps = Self::score_to_boost_bps(credit_score);
        let data = OracleCreditData {
            credit_score,
            data_sources,
            loan_limit_boost_bps: boost_bps,
            provider,
            updated_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::OracleData(borrower.clone()), &data);

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("score")),
            (borrower, credit_score, boost_bps),
        );
    }

    pub fn has_oracle_data(env: Env, borrower: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::OracleData(borrower))
    }

    pub fn get_oracle_data(env: Env, borrower: Address) -> OracleCreditData {
        env.storage()
            .persistent()
            .get(&DataKey::OracleData(borrower))
            .expect("No oracle data for borrower")
    }

    // ── ZK Credit Tier Upgrade ──────────────────────────────────────────────────

    pub fn set_zk_verifier(env: Env, admin: Address, verifier: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::ZkVerifier, &verifier);
        env.events()
            .publish((symbol_short!("zk_verif"), symbol_short!("set")), verifier);
    }

    pub fn get_zk_verifier(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::ZkVerifier)
            .expect("ZK verifier not configured")
    }

    pub fn apply_zk_tier_upgrade(
        env: Env,
        caller: Address,
        borrower: Address,
        target_tier: u32,
        nullifier: BytesN<32>,
    ) {
        caller.require_auth();
        let is_admin = env.storage().instance().get::<DataKey, Address>(&DataKey::Admin).map(|a| a == caller).unwrap_or(false);
        let is_zk_verifier = env.storage().instance().get::<DataKey, Address>(&DataKey::ZkVerifier).map(|v| v == caller).unwrap_or(false);
        if !is_admin && !is_zk_verifier {
            panic!("Unauthorised: caller is neither admin nor registered ZK verifier");
        }

        Self::assert_not_paused(&env);

        let key = DataKey::BorrowerProfile(borrower.clone());
        let mut profile: BorrowerProfile = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Profile not found");

        if profile.is_frozen() {
            panic!("Cannot upgrade frozen account");
        }

        let new_tier = match target_tier {
            1 => ReputationTier::Beginner,
            2 => ReputationTier::Silver,
            3 => ReputationTier::Gold,
            4 => ReputationTier::Platinum,
            _ => panic!("Invalid target tier"),
        };

        let min_score = match target_tier {
            1 => 50,
            2 => 150,
            3 => 500,
            4 => 1000,
            _ => 0,
        };

        if profile.reputation_score < min_score {
            profile.reputation_score = min_score;
        }
        profile.reputation_tier = new_tier;
        profile.set_zk_upgraded(true);

        env.storage().persistent().set(&key, &profile);

        env.events().publish(
            (symbol_short!("zk_tier"), symbol_short!("upgrade")),
            (borrower, target_tier, nullifier),
        );
    }

    // ── Mutations (admin-only for MVP) ────────────────────────────────────────

    /// Apply a reputation event.
    /// `caller` must be the admin (or an authorised lending contract in future).
    pub fn add_reputation_event(
        env: Env,
        caller: Address,
        borrower: Address,
        event: ReputationEvent,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::assert_not_paused(&env);

        let key = DataKey::BorrowerProfile(borrower.clone());
        let mut profile: BorrowerProfile = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Profile not found");

        if profile.is_frozen() {
            panic!("Cannot modify frozen account");
        }

        let (delta, flag_default, flag_repaid) = Self::event_info(&event);
        let new_score = (profile.reputation_score as i32 + delta).max(0) as i128;
        profile.reputation_score = new_score;
        profile.reputation_tier = Self::score_to_tier(new_score);

        if flag_default {
            profile.default_count += 1;
        }
        if flag_repaid {
            profile.loan_count += 1;
        }

        env.storage().persistent().set(&key, &profile);

        env.events().publish(
            (symbol_short!("rep"), symbol_short!("event")),
            (borrower, event, delta, new_score),
        );
    }

    /// Update cumulative borrowed/repaid amounts.
    pub fn update_loan_totals(
        env: Env,
        caller: Address,
        borrower: Address,
        borrowed_delta: i128,
        repaid_delta: i128,
    ) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let key = DataKey::BorrowerProfile(borrower.clone());
        let mut profile: BorrowerProfile = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Profile not found");

        profile.total_borrowed += borrowed_delta;
        profile.total_repaid += repaid_delta;
        env.storage().persistent().set(&key, &profile);

        env.events().publish(
            (symbol_short!("rep"), symbol_short!("totals")),
            (borrower, borrowed_delta, repaid_delta),
        );
    }

    /// Freeze an account (admin only).
    pub fn freeze_account(env: Env, admin: Address, borrower: Address, reason: String) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_not_paused(&env);

        let key = DataKey::BorrowerProfile(borrower.clone());
        let mut profile: BorrowerProfile = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Profile not found");

        profile.set_frozen(true);
        profile.freeze_reason = reason;
        profile.reputation_score = 0;
        profile.reputation_tier = ReputationTier::None;
        env.storage().persistent().set(&key, &profile);

        env.events().publish(
            (symbol_short!("rep"), symbol_short!("freeze")),
            (borrower, true),
        );
    }

    /// Unfreeze an account (admin only).
    pub fn unfreeze_account(env: Env, admin: Address, borrower: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let key = DataKey::BorrowerProfile(borrower.clone());
        let mut profile: BorrowerProfile = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Profile not found");

        profile.set_frozen(false);
        profile.freeze_reason = String::from_str(&env, "");
        env.storage().persistent().set(&key, &profile);

        env.events().publish(
            (symbol_short!("rep"), symbol_short!("freeze")),
            (borrower, false),
        );
    }

    pub fn is_frozen(env: Env, borrower: Address) -> bool {
        Self::get_profile(env, borrower).is_frozen()
    }

    pub fn is_active(env: Env, borrower: Address) -> bool {
        Self::get_profile(env, borrower).is_active()
    }

    pub fn is_verified(env: Env, borrower: Address) -> bool {
        Self::get_profile(env, borrower).is_verified()
    }

    pub fn get_profile_flags(env: Env, borrower: Address) -> u32 {
        Self::get_profile(env, borrower).flags
    }

    pub fn set_verified(env: Env, admin: Address, borrower: Address, verified: bool) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let key = DataKey::BorrowerProfile(borrower.clone());
        let mut profile: BorrowerProfile = env
            .storage()
            .persistent()
            .get(&key)
            .expect("Profile not found");

        profile.set_verified(verified);
        env.storage().persistent().set(&key, &profile);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// Returns (points_delta, is_default_event, is_repaid_event).
    fn event_info(event: &ReputationEvent) -> (i32, bool, bool) {
        match event {
            ReputationEvent::TestLoanRepaid   => (50,  false, true),
            ReputationEvent::LoanRepaidOnTime => (20,  false, true),
            ReputationEvent::LoanPaidEarly    => (30,  false, true),
            ReputationEvent::LoanLate1Day     => (-5,  false, false),
            ReputationEvent::LoanLate7Days    => (-50, false, false),
            ReputationEvent::LoanDefaulted    => (-100, true, false),
            ReputationEvent::LateWarning      => (-50, false, false),
        }
    }

    fn score_to_tier(score: i128) -> ReputationTier {
        if score < 50 {
            ReputationTier::None
        } else if score < 150 {
            ReputationTier::Beginner
        } else if score < 500 {
            ReputationTier::Silver
        } else if score < 1000 {
            ReputationTier::Gold
        } else {
            ReputationTier::Platinum
        }
    }

    fn tier_max_loan(tier: &ReputationTier) -> i128 {
        match tier {
            ReputationTier::None     => 1_000_0000000,    // 1,000 XLM
            ReputationTier::Beginner => 2_000_0000000,    // 2,000 XLM
            ReputationTier::Silver   => 5_000_0000000,    // 5,000 XLM
            ReputationTier::Gold     => 10_000_0000000,   // 10,000 XLM
            ReputationTier::Platinum => 100_000_0000000,  // 100,000 XLM
        }
    }

    fn tier_index(tier: &ReputationTier) -> u32 {
        match tier {
            ReputationTier::None     => 0,
            ReputationTier::Beginner => 1,
            ReputationTier::Silver   => 2,
            ReputationTier::Gold     => 3,
            ReputationTier::Platinum => 4,
        }
    }

    fn tier_interest_rate(tier: &ReputationTier) -> u32 {
        match tier {
            ReputationTier::None     => 1500, // 15.00 %
            ReputationTier::Beginner => 1300, // 13.00 %
            ReputationTier::Silver   => 1200, // 12.00 %
            ReputationTier::Gold     => 1000, // 10.00 %
            ReputationTier::Platinum =>  800, //  8.00 %
        }
    }

    /// Map a normalised credit score (0..=MAX_ORACLE_SCORE) to a max-loan boost
    /// in basis-points, linearly, capped at `MAX_LIMIT_BOOST_BPS`.
    /// e.g. score 1000 -> +100 %, score 500 -> +50 %, score 0 -> +0 %.
    fn score_to_boost_bps(credit_score: u32) -> u32 {
        let score = credit_score.min(MAX_ORACLE_SCORE);
        // score * MAX_LIMIT_BOOST_BPS / MAX_ORACLE_SCORE — both ≤ 10_000 so no u32 overflow.
        (score * MAX_LIMIT_BOOST_BPS) / MAX_ORACLE_SCORE
    }

    /// Apply a fresh oracle boost to a base limit. Returns `base` unchanged when
    /// there is no oracle record or the record is stale.
    fn apply_oracle_boost(env: &Env, borrower: &Address, base: i128) -> i128 {
        let key = DataKey::OracleData(borrower.clone());
        let data: OracleCreditData = match env.storage().persistent().get(&key) {
            Some(d) => d,
            None => return base,
        };
        if env.ledger().timestamp() > data.updated_at + ORACLE_VALIDITY_SECONDS {
            return base; // stale — ignore
        }
        // base ≤ 1e12, boost_bps ≤ 10_000 → product ≤ 1e16, well within i128.
        let boost = base * (data.loan_limit_boost_bps as i128) / 10_000;
        base + boost
    }

    fn assert_oracle(env: &Env, caller: &Address) {
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::Oracle)
            .expect("Oracle not configured");
        if *caller != oracle {
            panic!("Unauthorised: caller is not the registered oracle");
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

#[cfg(test)]
mod test;
