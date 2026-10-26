//! Property-based tests for the TrustLend lending contract.
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

// ─── Collateral Conservation & Backed Fee Accrual Invariants (#458) ──────────

/// Lifecycle vault model tracking pooled contract token balance, per-borrower
/// collateral positions, aggregate collateral (`TotalCollateral`), and
/// backed protocol fee accruals (`UncollectedFees`) across loan lifecycles.
#[derive(Debug, Clone, Default)]
struct VaultConservationModel {
    contract_balance: i128,
    borrower_collateral: Vec<i128>,
    total_collateral: i128,
    uncollected_fees: i128,
    treasury_balance: i128,
}

impl VaultConservationModel {
    fn new(num_borrowers: usize) -> Self {
        Self {
            contract_balance: 0,
            borrower_collateral: vec![0; num_borrowers],
            total_collateral: 0,
            uncollected_fees: 0,
            treasury_balance: 0,
        }
    }

    fn sum_user_collateral(&self) -> i128 {
        self.borrower_collateral.iter().copied().sum()
    }

    /// Deposit collateral into the vault for `borrower_idx`.
    fn deposit_collateral(&mut self, borrower_idx: usize, amount: i128) -> bool {
        if amount <= 0 || borrower_idx >= self.borrower_collateral.len() {
            return false;
        }
        self.borrower_collateral[borrower_idx] =
            match self.borrower_collateral[borrower_idx].checked_add(amount) {
                Some(v) => v,
                None => return false,
            };
        self.total_collateral = match self.total_collateral.checked_add(amount) {
            Some(v) => v,
            None => return false,
        };
        self.contract_balance = match self.contract_balance.checked_add(amount) {
            Some(v) => v,
            None => return false,
        };
        true
    }

    /// Withdraw collateral from the vault for `borrower_idx`.
    fn withdraw_collateral(&mut self, borrower_idx: usize, amount: i128) -> bool {
        if amount <= 0 || borrower_idx >= self.borrower_collateral.len() {
            return false;
        }
        if self.borrower_collateral[borrower_idx] < amount {
            return false;
        }
        if self.contract_balance < amount {
            return false;
        }
        self.borrower_collateral[borrower_idx] -= amount;
        self.total_collateral -= amount;
        self.contract_balance -= amount;
        true
    }

    /// Loan creation does not accrue unbacked protocol fees into `UncollectedFees`.
    fn create_loan_request(&mut self, _principal: i128, _rate_bps: u32, _days: u32, _fee_bps: u32) {
        // Creating a loan request neither moves tokens nor credits UncollectedFees.
    }

    /// Settling a loan repayment transfers the backed platform fee into the
    /// contract and credits `UncollectedFees`.
    fn settle_repayment_with_backed_fee(
        &mut self,
        principal: i128,
        rate_bps: u32,
        days: u32,
        fee_bps: u32,
    ) -> Option<i128> {
        let interest = calculate_interest(principal, rate_bps, days)?;
        let platform_fee = calculate_platform_fee(interest, fee_bps)?;
        self.contract_balance = self.contract_balance.checked_add(platform_fee)?;
        self.uncollected_fees = self.uncollected_fees.checked_add(platform_fee)?;
        Some(platform_fee)
    }

    /// Collect protocol fees to the treasury, enforcing that unencumbered
    /// token balance (`contract_balance - total_collateral`) covers `uncollected_fees`.
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
        self.treasury_balance += collected;
        Ok(collected)
    }
}

proptest! {
    /// INV-ACCT-11, INV-ACCT-12, INV-ACCT-13: Across arbitrary sequences of
    /// collateral deposits, loan requests, repayments, fee collections, and
    /// collateral withdrawals:
    /// 1. `contract_balance >= sum(user_collateral) == total_collateral`
    /// 2. `contract_balance >= total_collateral + uncollected_fees`
    /// 3. `collect_fees` never reduces `contract_balance` below `total_collateral`.
    #[test]
    fn prop_collateral_conservation_and_backed_fee_invariants_across_lifecycle(
        deposits in prop::collection::vec(10_000_000i128..=50_000_000_000i128, 1..=5),
        loans in prop::collection::vec(
            (arb_principal(), arb_rate_bps(), arb_days(), arb_platform_fee_bps(), any::<bool>()),
            1..=6
        ),
        withdraw_Ratio_bps in prop::collection::vec(0u32..=10_000u32, 1..=5),
    ) {
        let num_borrowers = deposits.len();
        let mut vault = VaultConservationModel::new(num_borrowers);

        // 1. Borrowers deposit collateral
        for (idx, &amount) in deposits.iter().enumerate() {
            prop_assert!(vault.deposit_collateral(idx, amount));
            prop_assert_eq!(vault.total_collateral, vault.sum_user_collateral());
            prop_assert!(vault.contract_balance >= vault.total_collateral + vault.uncollected_fees);
        }

        // 2. Loan requests, repayments, and interleaved fee collections
        for (principal, rate_bps, days, fee_bps, collect_after) in loans {
            // Loan creation alone never inflates uncollected_fees
            let fees_before = vault.uncollected_fees;
            vault.create_loan_request(principal, rate_bps, days, fee_bps);
            prop_assert_eq!(vault.uncollected_fees, fees_before);
            prop_assert!(vault.contract_balance >= vault.total_collateral + vault.uncollected_fees);

            // Repayment settles backed fee
            let _ = vault.settle_repayment_with_backed_fee(principal, rate_bps, days, fee_bps).unwrap();
            prop_assert_eq!(vault.total_collateral, vault.sum_user_collateral());
            prop_assert!(
                vault.contract_balance >= vault.total_collateral + vault.uncollected_fees,
                "Fee backing invariant violated: balance={} < collateral={} + fees={}",
                vault.contract_balance,
                vault.total_collateral,
                vault.uncollected_fees
            );

            if collect_after {
                let collected = vault.collect_fees().unwrap();
                prop_assert!(collected >= 0);
                prop_assert_eq!(vault.uncollected_fees, 0);
                // INV-ACCT-13: Solvency under collection
                prop_assert!(
                    vault.contract_balance >= vault.total_collateral,
                    "Solvency under collection violated: balance={} < total_collateral={}",
                    vault.contract_balance,
                    vault.total_collateral
                );
            }
        }

        // 3. Final fee collection & borrower collateral withdrawals
        let _ = vault.collect_fees().unwrap();
        prop_assert!(vault.contract_balance >= vault.total_collateral);

        for (idx, &ratio_bps) in withdraw_Ratio_bps.iter().take(num_borrowers).enumerate() {
            let current_pos = vault.borrower_collateral[idx];
            let withdraw_amt = (current_pos * (ratio_bps as i128)) / 10_000;
            if withdraw_amt > 0 {
                prop_assert!(
                    vault.withdraw_collateral(idx, withdraw_amt),
                    "Borrower withdrawal failed despite sufficient collateral"
                );
            }
            prop_assert_eq!(vault.total_collateral, vault.sum_user_collateral());
            prop_assert!(vault.contract_balance >= vault.total_collateral + vault.uncollected_fees);
        }
    }

    /// Verifies that if `uncollected_fees` exceeds unencumbered fee tokens
    /// (`contract_balance - total_collateral`), `collect_fees` is rejected and
    /// depositor collateral remains untouched.
    #[test]
    fn prop_collect_fees_rejects_unbacked_accrual_preserving_collateral(
        collateral in 10_000_000i128..=100_000_000_000i128,
        unbacked_fee in 1i128..=10_000_000_000i128,
    ) {
        let mut vault = VaultConservationModel::new(1);
        prop_assert!(vault.deposit_collateral(0, collateral));

        // Simulate an unbacked fee accrual without corresponding token inflow
        vault.uncollected_fees = unbacked_fee;

        let res = vault.collect_fees();
        prop_assert!(res.is_err(), "collect_fees must fail when fees are only backed by collateral");
        prop_assert_eq!(vault.contract_balance, collateral);
        prop_assert_eq!(vault.total_collateral, collateral);
        prop_assert!(vault.withdraw_collateral(0, collateral));
        prop_assert_eq!(vault.contract_balance, 0);
    }
}
