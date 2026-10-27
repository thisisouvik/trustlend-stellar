//! Property-based tests for TrustLend arithmetic and standalone reference models.
//! The conservation model does not invoke LendingContract production code.
//!
//! These tests use the `proptest` crate to fuzz-test mathematical and
//! accounting invariants with randomly generated inputs. Unlike Kani
//! proofs (which exhaustively check bounded input spaces), proptest
//! explores the input space stochastically and can discover edge cases
//! that manual test cases miss.
//!
//! # Running
//!
//! ```bash
//! cargo test -p lending --test proptest_tests
//! ```

use proptest::prelude::*;

/// Mirrors `LendingContract::calculate_interest`.
/// `interest = principal × rate_bps × days / (10_000 × 365)`
fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> Option<i128> {
    let numerator = principal
        .checked_mul(rate_bps as i128)?
        .checked_mul(days as i128)?;
    Some(numerator / (10_000_i128 * 365))
}

/// Mirrors `LendingContract::calculate_liquidation_threshold`.
fn calculate_liquidation_threshold(score: u32, volatility: u32) -> u32 {
    let base: u32 = 7500;
    let bonus = (score as u64 * 15 / 10) as u32;
    let penalty = volatility / 2;
    base.saturating_add(bonus)
        .saturating_sub(penalty)
        .clamp(5000, 9000)
}

/// Platform fee: `interest × fee_bps / 10_000`.
fn calculate_platform_fee(interest: i128, fee_bps: u32) -> Option<i128> {
    interest.checked_mul(fee_bps as i128)?.checked_div(10_000)
}

/// Flash loan fee: `amount × fee_bps / 10_000`.
fn calculate_flash_loan_fee(amount: i128, fee_bps: u32) -> Option<i128> {
    amount.checked_mul(fee_bps as i128)?.checked_div(10_000)
}

/// Rate switch fee: `remaining_due × 50 / 10_000`.
fn calculate_rate_switch_fee(remaining_due: i128) -> Option<i128> {
    remaining_due.checked_mul(50_i128)?.checked_div(10_000)
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/// Valid principal: 1 to 100_000 XLM in stroops.
fn arb_principal() -> impl Strategy<Value = i128> {
    1i128..=100_000_000_000i128
}

/// Valid interest rate in basis points: 1 to 1500 (0.01% to 15%).
fn arb_rate_bps() -> impl Strategy<Value = u32> {
    1u32..=1500u32
}

/// Valid duration in days: 1 to 365.
fn arb_days() -> impl Strategy<Value = u32> {
    1u32..=365u32
}

/// Valid platform fee in basis points: 0 to 1000.
fn arb_platform_fee_bps() -> impl Strategy<Value = u32> {
    0u32..=1000u32
}

/// Valid flash loan fee in basis points: 0 to 500.
fn arb_flash_loan_fee_bps() -> impl Strategy<Value = u32> {
    0u32..=500u32
}

// ─── Interest Calculation Tests ──────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_interest_non_negative(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        prop_assert!(interest >= 0, "interest={} must be >= 0", interest);
    }

    #[test]
    fn prop_interest_positive(
        principal in 3_650_000i128..=100_000_000_000i128,
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        // Constrained so that principal * rate_bps * days >= 3_650_000,
        // guaranteeing interest > 0 under integer division.
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        prop_assert!(interest > 0, "interest must be > 0 for sufficiently large inputs");
    }

    #[test]
    fn prop_interest_monotonic_principal(
        p1 in arb_principal(),
        p2 in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let (lo, hi) = if p1 <= p2 { (p1, p2) } else { (p2, p1) };
        let i1 = calculate_interest(lo, rate_bps, days).unwrap();
        let i2 = calculate_interest(hi, rate_bps, days).unwrap();
        prop_assert!(i1 <= i2, "interest({})={} > interest({})={}", lo, i1, hi, i2);
    }

    #[test]
    fn prop_interest_monotonic_rate(
        principal in arb_principal(),
        r1 in arb_rate_bps(),
        r2 in arb_rate_bps(),
        days in arb_days(),
    ) {
        let (lo, hi) = if r1 <= r2 { (r1, r2) } else { (r2, r1) };
        let i1 = calculate_interest(principal, lo, days).unwrap();
        let i2 = calculate_interest(principal, hi, days).unwrap();
        prop_assert!(i1 <= i2, "interest(r={})={} > interest(r={})={}", lo, i1, hi, i2);
    }

    #[test]
    fn prop_interest_monotonic_days(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        d1 in arb_days(),
        d2 in arb_days(),
    ) {
        let (lo, hi) = if d1 <= d2 { (d1, d2) } else { (d2, d1) };
        let i1 = calculate_interest(principal, rate_bps, lo).unwrap();
        let i2 = calculate_interest(principal, rate_bps, hi).unwrap();
        prop_assert!(i1 <= i2, "interest(d={})={} > interest(d={})={}", lo, i1, hi, i2);
    }

    #[test]
    fn prop_annual_interest_identity(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
    ) {
        let interest_365 = calculate_interest(principal, rate_bps, 365).unwrap();
        let expected = principal * (rate_bps as i128) / 10_000;
        prop_assert_eq!(interest_365, expected);
    }

    #[test]
    fn prop_interest_no_overflow(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let _ = calculate_interest(principal, rate_bps, days).unwrap();
    }
}

// ─── Accounting Tests ────────────────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_total_due_ge_principal(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        let total_due = principal + interest;
        prop_assert!(total_due >= principal, "total_due={} < principal={}", total_due, principal);
    }

    #[test]
    fn prop_platform_fee_le_interest(
        interest in 0i128..=100_000_000_000i128,
        fee_bps in arb_platform_fee_bps(),
    ) {
        if let Some(fee) = calculate_platform_fee(interest, fee_bps) {
            prop_assert!(fee <= interest, "fee={} > interest={}", fee, interest);
        }
    }

    #[test]
    fn prop_payment_never_negative(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
        payment in 1i128..=100_000_000_000i128,
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        let total_due = principal + interest;
        let remaining = if payment >= total_due { 0 } else { total_due - payment };
        prop_assert!(remaining >= 0, "remaining={} is negative", remaining);
    }

    #[test]
    fn prop_full_payment_zeroes(
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
    ) {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        let total_due = principal + interest;
        let payment = total_due + 1;
        let remaining = if payment >= total_due { 0 } else { total_due - payment };
        prop_assert_eq!(remaining, 0i128);
    }
}

// ─── Liquidation Threshold Tests ─────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_liquidation_threshold_bounds(
        score in 0u32..=2000u32,
        volatility in 0u32..=10000u32,
    ) {
        let threshold = calculate_liquidation_threshold(score, volatility);
        prop_assert!(threshold >= 5000, "threshold={} < 5000", threshold);
        prop_assert!(threshold <= 9000, "threshold={} > 9000", threshold);
    }

    #[test]
    fn prop_liquidation_threshold_monotonic_score(
        s1 in 0u32..=1000u32,
        s2 in 0u32..=1000u32,
        volatility in 0u32..=5000u32,
    ) {
        let (lo, hi) = if s1 <= s2 { (s1, s2) } else { (s2, s1) };
        let t1 = calculate_liquidation_threshold(lo, volatility);
        let t2 = calculate_liquidation_threshold(hi, volatility);
        prop_assert!(t1 <= t2, "t(low_score)={} > t(high_score)={}", t1, t2);
    }
}

// ─── Flash Loan Fee Tests ────────────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_flash_fee_le_amount(
        amount in 1i128..=100_000_000_000i128,
        fee_bps in arb_flash_loan_fee_bps(),
    ) {
        if let Some(fee) = calculate_flash_loan_fee(amount, fee_bps) {
            prop_assert!(fee <= amount, "fee={} > amount={}", fee, amount);
        }
    }

    #[test]
    fn prop_flash_fee_monotonic_amount(
        a1 in 1i128..=100_000_000_000i128,
        a2 in 1i128..=100_000_000_000i128,
        fee_bps in arb_flash_loan_fee_bps(),
    ) {
        let (lo, hi) = if a1 <= a2 { (a1, a2) } else { (a2, a1) };
        let f1 = calculate_flash_loan_fee(lo, fee_bps);
        let f2 = calculate_flash_loan_fee(hi, fee_bps);
        if let (Some(fee1), Some(fee2)) = (f1, f2) {
            prop_assert!(fee1 <= fee2, "fee(a={})={} > fee(a={})={}", lo, fee1, hi, fee2);
        }
    }

    #[test]
    fn prop_flash_fee_formula(
        amount in 1i128..=100_000_000_000i128,
        fee_bps in arb_flash_loan_fee_bps(),
    ) {
        let fee = calculate_flash_loan_fee(amount, fee_bps).unwrap();
        let expected = amount * (fee_bps as i128) / 10_000;
        prop_assert_eq!(fee, expected);
    }
}

// ─── Rate Switch Fee Tests ───────────────────────────────────────────────────

proptest! {
    #[test]
    fn prop_rate_switch_fee_nonnegative(
        remaining in 0i128..=100_000_000_000i128,
    ) {
        let fee = calculate_rate_switch_fee(remaining).unwrap();
        prop_assert!(fee >= 0, "rate switch fee={} is negative", fee);
    }

    #[test]
    fn prop_rate_switch_fee_at_most_half_percent(
        remaining in 0i128..=100_000_000_000i128,
    ) {
        let fee = calculate_rate_switch_fee(remaining).unwrap();
        prop_assert!(
            fee <= remaining / 200 + 1,
            "rate switch fee={} exceeds ~0.5% of remaining={}",
            fee,
            remaining
        );
    }

    #[test]
    fn prop_rate_switch_increases_debt(
        remaining in 1i128..=100_000_000_000i128,
    ) {
        let fee = calculate_rate_switch_fee(remaining).unwrap();
        let new_remaining = remaining + fee;
        prop_assert!(
            new_remaining >= remaining,
            "new_remaining={} < old_remaining={}",
            new_remaining,
            remaining
        );
    }
}

// ─── Collateral Conservation & Backed Fee Accrual Invariants (Issue #458) ────

/// Lifecycle status of a loan in the formal accounting model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LifecycleStatus {
    Pending,
    Approved,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

/// Simulated loan state tracking principal, total due, remaining due,
/// scheduled platform fee, and already-accrued platform fee.
#[derive(Debug, Clone)]
struct SimulatedLoan {
    principal: i128,
    total_due: i128,
    remaining_due: i128,
    platform_fee: i128,
    accrued_fee: i128,
    status: LifecycleStatus,
}

/// Formal ledger state mirroring `LendingContract` when `FeeToken` is also a
/// whitelisted collateral asset (e.g. native XLM).
#[derive(Debug, Clone)]
struct ConservationVault {
    /// Total SEP-41 token balance held by `LendingContract`.
    contract_balance: i128,
    /// Per-borrower collateral positions (`DataKey::UserCollateral`).
    user_collateral: Vec<i128>,
    /// Aggregate collateral accumulator (`DataKey::TotalCollateral`).
    total_collateral: i128,
    /// Accrued uncollected protocol fees (`DataKey::UncollectedFees`).
    uncollected_fees: i128,
    /// Loans created in the protocol.
    loans: Vec<SimulatedLoan>,
}

impl ConservationVault {
    /// Construct a new empty conservation vault with `num_borrowers` accounts.
    fn new(num_borrowers: usize) -> Self {
        Self {
            contract_balance: 0,
            user_collateral: vec![0; num_borrowers],
            total_collateral: 0,
            uncollected_fees: 0,
            loans: Vec::new(),
        }
    }

    /// Sum of all individual borrower collateral positions.
    fn sum_user_collateral(&self) -> i128 {
        self.user_collateral.iter().copied().sum()
    }

    /// Assert `INV-ACCT-11` (Collateral Conservation) and `INV-ACCT-12` (Fee Backing).
    fn check_invariants(&self) -> Result<(), String> {
        let user_sum = self.sum_user_collateral();
        if self.total_collateral != user_sum {
            return Err(format!(
                "TotalCollateral ({}) != sum of UserCollateral ({})",
                self.total_collateral, user_sum
            ));
        }
        if self.contract_balance < user_sum {
            return Err(format!(
                "INV-ACCT-11 violated: balance ({}) < sum(UserCollateral) ({})",
                self.contract_balance, user_sum
            ));
        }
        if self.contract_balance < self.total_collateral + self.uncollected_fees {
            return Err(format!(
                "INV-ACCT-12 violated: balance ({}) < total_collateral ({}) + uncollected_fees ({})",
                self.contract_balance, self.total_collateral, self.uncollected_fees
            ));
        }
        Ok(())
    }

    /// Model `deposit_collateral`: transfers collateral tokens into contract custody
    /// and increments both `UserCollateral(borrower)` and `TotalCollateral(asset)`.
    fn deposit_collateral(&mut self, borrower: usize, amount: i128) {
        if amount <= 0 {
            return;
        }
        self.user_collateral[borrower] += amount;
        self.total_collateral += amount;
        self.contract_balance += amount;
    }

    /// Model `withdraw_collateral`: decrements `UserCollateral(borrower)` and
    /// `TotalCollateral(asset)` and transfers collateral tokens back to the borrower.
    fn withdraw_collateral(&mut self, borrower: usize, amount: i128) -> Result<(), &'static str> {
        if amount <= 0 || self.user_collateral[borrower] < amount {
            return Err("Insufficient borrower collateral balance");
        }
        self.user_collateral[borrower] -= amount;
        self.total_collateral -= amount;
        self.contract_balance -= amount;
        Ok(())
    }

    /// Proposed `create_loan_request`: computes scheduled interest and platform fee
    /// without crediting `UncollectedFees` upfront.
    fn create_loan_request(
        &mut self,
        principal: i128,
        rate_bps: u32,
        days: u32,
        fee_bps: u32,
    ) -> usize {
        let interest = calculate_interest(principal, rate_bps, days).unwrap();
        let platform_fee = calculate_platform_fee(interest, fee_bps).unwrap();
        let total_due = principal + interest;
        let idx = self.loans.len();
        self.loans.push(SimulatedLoan {
            principal,
            total_due,
            remaining_due: total_due,
            platform_fee,
            accrued_fee: 0,
            status: LifecycleStatus::Pending,
        });
        idx
    }

    /// Model `approve_loan`.
    fn approve_loan(&mut self, loan_idx: usize) {
        if self.loans[loan_idx].status == LifecycleStatus::Pending {
            self.loans[loan_idx].status = LifecycleStatus::Approved;
        }
    }

    /// Model `revoke_approval`.
    fn revoke_approval(&mut self, loan_idx: usize) {
        if self.loans[loan_idx].status == LifecycleStatus::Approved {
            self.loans[loan_idx].status = LifecycleStatus::Pending;
        }
    }

    /// Model `cancel_loan_request`.
    fn cancel_loan(&mut self, loan_idx: usize) {
        if self.loans[loan_idx].status == LifecycleStatus::Pending {
            self.loans[loan_idx].status = LifecycleStatus::Cancelled;
        }
    }

    /// Model `activate_loan`.
    fn activate_loan(&mut self, loan_idx: usize) {
        if self.loans[loan_idx].status == LifecycleStatus::Approved {
            self.loans[loan_idx].status = LifecycleStatus::Active;
        }
    }

    /// Model `switch_rate_model` on an active loan.
    fn switch_rate_model(&mut self, loan_idx: usize) {
        let loan = &mut self.loans[loan_idx];
        if loan.status == LifecycleStatus::Active {
            let fee = calculate_rate_switch_fee(loan.remaining_due).unwrap();
            loan.remaining_due += fee;
            loan.total_due += fee;
        }
    }

    /// Model `mark_defaulted` on an active loan.
    fn mark_defaulted(&mut self, loan_idx: usize) {
        if self.loans[loan_idx].status == LifecycleStatus::Active {
            self.loans[loan_idx].status = LifecycleStatus::Defaulted;
        }
    }

    /// Proposed `record_payment` with backed fee settlement: accrues protocol fees
    /// only as interest above principal is settled, accompanied by the fee token inflow.
    fn record_payment(&mut self, loan_idx: usize, amount: i128) {
        let loan = &mut self.loans[loan_idx];
        if loan.status != LifecycleStatus::Active || amount <= 0 {
            return;
        }
        if amount >= loan.remaining_due {
            loan.remaining_due = 0;
            loan.status = LifecycleStatus::Repaid;
        } else {
            loan.remaining_due -= amount;
        }

        let total_interest = loan.total_due.saturating_sub(loan.principal);
        let paid_after = loan.total_due.saturating_sub(loan.remaining_due);
        let interest_settled = paid_after.saturating_sub(loan.principal);
        let target_accrued_fee = if loan.remaining_due == 0 {
            loan.platform_fee
        } else if total_interest > 0 && interest_settled > 0 {
            loan.platform_fee * interest_settled / total_interest
        } else {
            0
        };

        let newly_accrued = target_accrued_fee.saturating_sub(loan.accrued_fee);
        if newly_accrued > 0 {
            loan.accrued_fee = target_accrued_fee;
            self.uncollected_fees += newly_accrued;
            self.contract_balance += newly_accrued;
        }
    }

    /// Proposed `collect_fees` with a collateral-aware guard absent from production.
    fn collect_fees(&mut self) -> Result<i128, &'static str> {
        if self.uncollected_fees <= 0 {
            return Ok(0);
        }
        let available_fees = self.contract_balance.saturating_sub(self.total_collateral);
        if available_fees < self.uncollected_fees {
            return Err("Insufficient unencumbered fee token balance to collect fees");
        }
        let collected = self.uncollected_fees;
        self.uncollected_fees = 0;
        self.contract_balance -= collected;
        Ok(collected)
    }
}

proptest! {
    /// INV-ACCT-11: Collateral Conservation Invariant.
    /// Across arbitrary multi-borrower deposits and withdrawals, the contract's
    /// token balance is always >= the sum of all borrowers' collateral positions.
    #[test]
    fn prop_reference_model_collateral_conservation_invariant(
        d1 in 1i128..=100_000_000_000i128,
        d2 in 1i128..=100_000_000_000i128,
        d3 in 1i128..=100_000_000_000i128,
        w1_ratio in 0u32..=10_000u32,
        w2_ratio in 0u32..=10_000u32,
    ) {
        let mut vault = ConservationVault::new(3);
        vault.deposit_collateral(0, d1);
        vault.deposit_collateral(1, d2);
        vault.deposit_collateral(2, d3);
        prop_assert!(vault.check_invariants().is_ok());

        let w1 = d1 * (w1_ratio as i128) / 10_000;
        if w1 > 0 {
            prop_assert!(vault.withdraw_collateral(0, w1).is_ok());
        }
        prop_assert!(vault.check_invariants().is_ok());

        let w2 = d2 * (w2_ratio as i128) / 10_000;
        if w2 > 0 {
            prop_assert!(vault.withdraw_collateral(1, w2).is_ok());
        }
        prop_assert!(vault.check_invariants().is_ok());
    }

    /// INV-ACCT-12: Fee Backing Invariant across all loan lifecycles.
    /// Verifies that `balance(contract) >= total_collateral + uncollected_fees`
    /// holds at every stage of the loan lifecycle: creation, approval, revoke,
    /// activation, rate switch, partial repayments, full repayment, cancellation,
    /// default, fee collection, and collateral withdrawal.
    #[test]
    fn prop_reference_model_fee_backing_across_loan_lifecycles(
        collateral in 10_000_000i128..=100_000_000_000i128,
        principal in arb_principal(),
        rate_bps in arb_rate_bps(),
        days in arb_days(),
        fee_bps in arb_platform_fee_bps(),
        partial_split_bps in 1u32..=9_999u32,
        lifecycle_variant in 0u8..=4u8,
    ) {
        let mut vault = ConservationVault::new(1);
        vault.deposit_collateral(0, collateral);
        prop_assert!(vault.check_invariants().is_ok());

        let loan_idx = vault.create_loan_request(principal, rate_bps, days, fee_bps);
        // After loan creation (Pending), no unbacked fee is booked.
        prop_assert_eq!(vault.uncollected_fees, 0);
        prop_assert!(vault.check_invariants().is_ok());

        match lifecycle_variant {
            0 => {
                // Pending -> Cancelled
                vault.cancel_loan(loan_idx);
                prop_assert!(vault.check_invariants().is_ok());
            }
            1 => {
                // Pending -> Approved -> Revoked -> Approved -> Active -> Defaulted
                vault.approve_loan(loan_idx);
                prop_assert!(vault.check_invariants().is_ok());
                vault.revoke_approval(loan_idx);
                prop_assert!(vault.check_invariants().is_ok());
                vault.approve_loan(loan_idx);
                vault.activate_loan(loan_idx);
                prop_assert!(vault.check_invariants().is_ok());
                vault.mark_defaulted(loan_idx);
                prop_assert!(vault.check_invariants().is_ok());
            }
            2 => {
                // Pending -> Approved -> Active -> Single Full Repayment -> Collect Fees
                vault.approve_loan(loan_idx);
                vault.activate_loan(loan_idx);
                let total_due = vault.loans[loan_idx].total_due;
                vault.record_payment(loan_idx, total_due);
                prop_assert!(vault.check_invariants().is_ok());

                let collected = vault.collect_fees().unwrap();
                prop_assert_eq!(collected, vault.loans[loan_idx].platform_fee);
                prop_assert!(vault.check_invariants().is_ok());
            }
            3 => {
                // Pending -> Approved -> Active -> Two Partial Payments -> Collect Fees
                vault.approve_loan(loan_idx);
                vault.activate_loan(loan_idx);
                let total_due = vault.loans[loan_idx].total_due;
                let first_payment = (total_due * (partial_split_bps as i128) / 10_000).max(1);
                vault.record_payment(loan_idx, first_payment);
                prop_assert!(vault.check_invariants().is_ok());

                let remaining = vault.loans[loan_idx].remaining_due;
                if remaining > 0 {
                    vault.record_payment(loan_idx, remaining);
                    prop_assert!(vault.check_invariants().is_ok());
                }

                let _ = vault.collect_fees().unwrap();
                prop_assert!(vault.check_invariants().is_ok());
            }
            _ => {
                // Pending -> Approved -> Active -> Rate Switch -> Full Repayment -> Collect Fees
                vault.approve_loan(loan_idx);
                vault.activate_loan(loan_idx);
                vault.switch_rate_model(loan_idx);
                prop_assert!(vault.check_invariants().is_ok());

                let remaining = vault.loans[loan_idx].remaining_due;
                vault.record_payment(loan_idx, remaining);
                prop_assert!(vault.check_invariants().is_ok());

                let _ = vault.collect_fees().unwrap();
                prop_assert!(vault.check_invariants().is_ok());
            }
        }

        // Finally, withdrawing all depositor collateral succeeds and preserves invariants.
        prop_assert!(vault.withdraw_collateral(0, collateral).is_ok());
        prop_assert!(vault.check_invariants().is_ok());
    }

    /// INV-ACCT-13: Solvency Under Collection.
    /// Executing `collect_fees` never reduces `balance(contract)` below
    /// `total_collateral`, and rejects collection if fees are unbacked.
    #[test]
    fn prop_reference_model_solvency_under_collection(
        collateral in 1i128..=100_000_000_000i128,
        uncollected_fees in 1i128..=10_000_000_000i128,
        backed_fee_tokens in 0i128..=10_000_000_000i128,
    ) {
        let mut vault = ConservationVault::new(1);
        vault.deposit_collateral(0, collateral);
        vault.uncollected_fees = uncollected_fees;
        vault.contract_balance += backed_fee_tokens;

        let res = vault.collect_fees();
        if backed_fee_tokens >= uncollected_fees {
            prop_assert_eq!(res, Ok(uncollected_fees));
            prop_assert_eq!(vault.uncollected_fees, 0);
            prop_assert!(
                vault.contract_balance >= vault.total_collateral,
                "balance={} fell below total_collateral={}",
                vault.contract_balance,
                vault.total_collateral
            );
            prop_assert!(vault.check_invariants().is_ok());
        } else {
            prop_assert!(res.is_err());
            prop_assert_eq!(vault.uncollected_fees, uncollected_fees);
            prop_assert_eq!(vault.contract_balance, collateral + backed_fee_tokens);
            prop_assert!(vault.contract_balance >= vault.total_collateral);
        }
    }
}

proptest! {
    /// Independent cash inflow and liability expose underfunding instead of
    /// assuming that every accrued fee arrives with matching tokens.
    #[test]
    fn prop_reference_model_detects_unbacked_fee_accrual(
        collateral in 1i128..=100_000_000_000i128,
        token_inflow in 0i128..=10_000_000_000i128,
        fee_liability in 1i128..=10_000_000_000i128,
    ) {
        let mut vault = ConservationVault::new(1);
        vault.deposit_collateral(0, collateral);
        vault.contract_balance += token_inflow;
        vault.uncollected_fees = fee_liability;
        prop_assert_eq!(vault.check_invariants().is_ok(), token_inflow >= fee_liability);
    }

    /// Negative control: an unrecorded token outflow must be detected.
    #[test]
    fn prop_reference_model_detects_collateral_token_loss(
        collateral in 1i128..=100_000_000_000i128,
        loss_ratio in 1i128..=10_000i128,
    ) {
        let mut vault = ConservationVault::new(1);
        vault.deposit_collateral(0, collateral);
        let loss = (collateral * loss_ratio / 10_000).max(1);
        vault.contract_balance -= loss;
        prop_assert!(vault.check_invariants().is_err());
    }
}
