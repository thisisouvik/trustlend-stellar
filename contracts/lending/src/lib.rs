#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

// ─── Types ────────────────────────────────────────────────────────────────────

/// Full lifecycle status of a loan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoanStatus {
    Pending,
    Approved,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

/// A single loan record.
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
    /// Platform fee taken (1 % of interest, in stroops)
    pub platform_fee: i128,
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
    BorrowerLoans(Address),
    LenderLoans(Address),
    Payment(u32, u32), // (loan_id, payment_index)
    PaymentCount(u32), // per loan
    Admin,
    /// Platform fee as basis-points of interest (100 = 1.00 %). DAO-controlled.
    PlatformFeeBps,
    /// Address of the Governance contract authorised to change the fee.
    Governance,
}

/// Default platform fee = 1 % of interest (100 bps) until governance changes it.
const DEFAULT_PLATFORM_FEE_BPS: u32 = 100;
/// Safety ceiling: the fee can never exceed 10 % of interest (1000 bps),
/// even via a passed proposal.
const MAX_PLATFORM_FEE_BPS: u32 = 1000;

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct LendingContract;

#[contractimpl]
impl LendingContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::LoanCount, &0u32);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    // ── DAO governance of the platform fee ──────────────────────────────────────

    /// Link the Governance contract (admin only, one-time bootstrap).
    /// Once set, the platform fee can ONLY be changed by this contract — i.e.
    /// by a successful on-chain vote.
    pub fn set_governance(env: Env, admin: Address, governance: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Governance, &governance);
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

        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &new_fee_bps);
    }

    // ── Loan lifecycle ────────────────────────────────────────────────────────

    /// Borrower creates a loan request.
    /// `interest_rate_bps` and `max_loan` are fetched off-chain from the
    /// ReputationContract and passed in so we avoid a cross-contract call
    /// on the critical path (cheaper, simpler on testnet).
    pub fn create_loan_request(
        env: Env,
        borrower: Address,
        amount: i128,
        duration_days: u32,
        interest_rate_bps: u32,
        max_loan_amount: i128,
    ) -> u32 {
        borrower.require_auth();

        if amount <= 0 {
            panic!("Loan amount must be positive");
        }
        if amount > max_loan_amount {
            panic!("Amount exceeds reputation-based limit");
        }
        if duration_days == 0 || duration_days > 365 {
            panic!("Duration must be between 1 and 365 days");
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
        };

        env.storage().persistent().set(&DataKey::Loan(loan_id), &loan);
        env.storage().instance().set(&DataKey::LoanCount, &loan_id);

        // Track per-borrower list
        Self::push_loan_id_for_borrower(&env, &borrower, loan_id);

        loan_id
    }

    /// Lender approves a pending loan.
    pub fn approve_loan(
        env: Env,
        lender: Address,
        loan_id: u32,
        escrow_id: u32,
    ) {
        lender.require_auth();

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Pending {
            panic!("Loan is not in PENDING state");
        }

        loan.lender = lender.clone();
        loan.escrow_id = escrow_id;
        loan.status = LoanStatus::Approved;

        env.storage().persistent().set(&DataKey::Loan(loan_id), &loan);
        Self::push_loan_id_for_lender(&env, &lender, loan_id);
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
        env.storage().persistent().set(&DataKey::Loan(loan_id), &loan);
    }

    /// Admin/backend activates the loan once escrow disbursement is confirmed.
    pub fn activate_loan(env: Env, caller: Address, loan_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Approved {
            panic!("Loan must be APPROVED before activation");
        }
        loan.status = LoanStatus::Active;
        env.storage().persistent().set(&DataKey::Loan(loan_id), &loan);
    }

    /// Record a repayment (partial or full).
    /// Actual XLM moves via PAYMENT op; admin calls this after Horizon confirm.
    pub fn record_payment(
        env: Env,
        caller: Address,
        loan_id: u32,
        amount: i128,
    ) -> LoanStatus {
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
        } else {
            loan.remaining_due -= amount;
        }

        env.storage().persistent().set(&DataKey::Loan(loan_id), &loan);
        loan.status
    }

    /// Mark a loan as defaulted (called by DefaultManagementContract or admin).
    pub fn mark_defaulted(env: Env, caller: Address, loan_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Active {
            panic!("Only ACTIVE loans can be defaulted");
        }
        loan.status = LoanStatus::Defaulted;
        env.storage().persistent().set(&DataKey::Loan(loan_id), &loan);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    pub fn get_loan(env: Env, loan_id: u32) -> LoanRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Loan(loan_id))
            .expect("Loan not found")
    }

    pub fn get_loan_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::LoanCount)
            .unwrap_or(0)
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

    // ── Private helpers ───────────────────────────────────────────────────────

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

    fn push_loan_id_for_borrower(env: &Env, borrower: &Address, loan_id: u32) {
        let key = DataKey::BorrowerLoans(borrower.clone());
        let mut ids: Vec<u32> = env.storage().persistent().get(&key).unwrap_or(Vec::new(env));
        ids.push_back(loan_id);
        env.storage().persistent().set(&key, &ids);
    }

    fn push_loan_id_for_lender(env: &Env, lender: &Address, loan_id: u32) {
        let key = DataKey::LenderLoans(lender.clone());
        let mut ids: Vec<u32> = env.storage().persistent().get(&key).unwrap_or(Vec::new(env));
        ids.push_back(loan_id);
        env.storage().persistent().set(&key, &ids);
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

#[cfg(test)]
mod test;
