#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Vec};

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
}

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
        // Platform fee = 1 % of interest
        let platform_fee = interest / 100;
        let total_due = amount + interest;

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LoanCount)
            .unwrap_or(0);
        let loan_id = count + 1;

        let now = env.ledger().timestamp();
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
            due_at: now + (duration_days as u64) * 86_400,
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

    // ── Private helpers ───────────────────────────────────────────────────────

    /// interest = principal × rate_bps × days / (10_000 × 365)
    fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> i128 {
        (principal * rate_bps as i128 * days as i128) / (10_000 * 365)
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
