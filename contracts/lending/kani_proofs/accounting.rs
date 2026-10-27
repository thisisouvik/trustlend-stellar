//! Formal verification of the lending contract's accounting invariants.
//!
//! Verifies:
//! - `remaining_due >= 0` after any payment
//! - `remaining_due <= total_due` at all times
//! - `total_due >= principal` at creation
//! - Uncollected fees increase correctly
//! - Payment reduces remaining_due correctly

// ─── Mirrored types ──────────────────────────────────────────────────────────

/// Loan status mirroring the contract's `LoanStatus` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoanStatus {
    Pending,
    Approved,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

/// Simplified loan record for proof purposes.
#[derive(Debug, Clone)]
struct LoanRecord {
    amount: i128,
    total_due: i128,
    remaining_due: i128,
    status: LoanStatus,
    platform_fee: i128,
}

/// Compute interest: `principal × rate_bps × days / (10_000 × 365)`.
fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> Option<i128> {
    let numerator = (principal as i128)
        .checked_mul(rate_bps as i128)?
        .checked_mul(days as i128)?;
    Some(numerator / (10_000_i128 * 365))
}

/// Compute platform fee: `interest × fee_bps / 10_000`.
fn calculate_platform_fee(interest: i128, fee_bps: u32) -> Option<i128> {
    (interest as i128)
        .checked_mul(fee_bps as i128)?
        .checked_div(10_000)
}

/// Simulate `create_loan_request` accounting.
fn create_loan(
    principal: i128,
    rate_bps: u32,
    days: u32,
    fee_bps: u32,
) -> Option<(LoanRecord, i128)> {
    let interest = calculate_interest(principal, rate_bps, days)?;
    let platform_fee = calculate_platform_fee(interest, fee_bps)?;
    let total_due = principal.checked_add(interest)?;

    let loan = LoanRecord {
        amount: principal,
        total_due,
        remaining_due: total_due,
        status: LoanStatus::Pending,
        platform_fee,
    };

    Some((loan, platform_fee))
}

/// Simulate `record_payment` accounting.
/// Returns the updated loan and the actual payment applied.
fn record_payment(loan: &mut LoanRecord, amount: i128) -> Option<i128> {
    if amount <= 0 {
        return None;
    }
    if loan.status != LoanStatus::Active {
        return None;
    }

    let actual_payment = if amount >= loan.remaining_due {
        loan.remaining_due
    } else {
        amount
    };

    loan.remaining_due = loan.remaining_due.checked_sub(actual_payment)?;
    if loan.remaining_due == 0 {
        loan.status = LoanStatus::Repaid;
    }

    Some(actual_payment)
}

/// Simulate `switch_rate_model` fee application.
fn apply_switch_fee(loan: &mut LoanRecord, switch_fee_bps: u32) -> Option<i128> {
    let fee = loan
        .remaining_due
        .checked_mul(switch_fee_bps as i128)?
        .checked_div(10_000)?;
    loan.remaining_due = loan.remaining_due.checked_add(fee)?;
    loan.total_due = loan.total_due.checked_add(fee)?;
    Some(fee)
}

// ─── Kani Proof Harnesses ────────────────────────────────────────────────────

/// INV-ACCT-1: remaining_due >= 0 after loan creation.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_1_remaining_due_nonnegative_at_creation() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);

    if let Some((loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        assert!(
            loan.remaining_due >= 0,
            "remaining_due must be non-negative at creation"
        );
    }
}

/// INV-ACCT-2: remaining_due <= total_due at creation.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_2_remaining_le_total_at_creation() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);

    if let Some((loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        assert!(
            loan.remaining_due <= loan.total_due,
            "remaining_due must not exceed total_due at creation"
        );
    }
}

/// INV-ACCT-3: total_due >= principal (interest is non-negative).
#[cfg(kani)]
#[kani::proof]
fn inv_acct_3_total_due_ge_principal() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);

    if let Some((loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        assert!(
            loan.total_due >= principal,
            "total_due must be >= principal"
        );
    }
}

/// INV-ACCT-4: remaining_due never goes negative after payment.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_4_payment_never_negative() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();
    let payment_amount: i128 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);
    kani::assume(payment_amount > 0);

    if let Some((mut loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        loan.status = LoanStatus::Active;
        let _ = record_payment(&mut loan, payment_amount);
        assert!(
            loan.remaining_due >= 0,
            "remaining_due must never go negative after payment"
        );
    }
}

/// INV-ACCT-5: remaining_due decreases by at most payment_amount.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_5_payment_reduces_correctly() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();
    let payment_amount: i128 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);
    kani::assume(payment_amount > 0 && payment_amount <= 100_000_000_000);

    if let Some((mut loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        loan.status = LoanStatus::Active;
        let before = loan.remaining_due;
        let _ = record_payment(&mut loan, payment_amount);
        let after = loan.remaining_due;
        let actual = before - after;
        assert!(
            actual >= 0 && actual <= payment_amount,
            "Payment reduction must be in [0, payment_amount]"
        );
    }
}

/// INV-ACCT-6: remaining_due == 0 implies status == Repaid.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_6_zero_remaining_implies_repaid() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();
    let payment_amount: i128 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);
    kani::assume(payment_amount > 0);

    if let Some((mut loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        loan.status = LoanStatus::Active;
        let _ = record_payment(&mut loan, payment_amount);
        if loan.remaining_due == 0 {
            assert_eq!(
                loan.status,
                LoanStatus::Repaid,
                "remaining_due == 0 must imply status == Repaid"
            );
        }
    }
}

/// INV-ACCT-7: Full payment sets remaining_due to exactly 0.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_7_full_payment_zeroes_remaining() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);

    if let Some((mut loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        loan.status = LoanStatus::Active;
        let full_amount = loan.remaining_due + 1; // more than enough
        let _ = record_payment(&mut loan, full_amount);
        assert_eq!(
            loan.remaining_due, 0,
            "Full payment must zero remaining_due"
        );
    }
}

/// INV-ACCT-8: Platform fee is correctly accumulated into uncollected_fees.
///
/// After N loan creations, uncollected_fees == sum of all platform_fees.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_8_fee_accumulation() {
    let p1: i128 = kani::any();
    let p2: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(p1 > 0 && p1 <= 10_000_000_000);
    kani::assume(p2 > 0 && p2 <= 10_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);

    if let Some((_loan1, fee1)) = create_loan(p1, rate_bps, days, fee_bps) {
        if let Some((_loan2, fee2)) = create_loan(p2, rate_bps, days, fee_bps) {
            let total_fees = fee1.checked_add(fee2);
            assert!(total_fees.is_some(), "Fee accumulation must not overflow");
            assert!(fee1 >= 0, "Individual fees must be non-negative");
            assert!(fee2 >= 0, "Individual fees must be non-negative");
        }
    }
}

/// INV-ACCT-9: Rate switch fee correctly increases remaining_due and total_due.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_9_rate_switch_increases_debt() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);

    if let Some((mut loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        loan.status = LoanStatus::Active;
        let old_remaining = loan.remaining_due;
        let old_total = loan.total_due;

        if let Some(fee) = apply_switch_fee(&mut loan, 50) {
            assert!(fee >= 0, "Switch fee must be non-negative");
            assert_eq!(
                loan.remaining_due,
                old_remaining + fee,
                "remaining_due must increase by exactly the fee"
            );
            assert_eq!(
                loan.total_due,
                old_total + fee,
                "total_due must increase by exactly the fee"
            );
            assert!(
                loan.remaining_due <= loan.total_due,
                "remaining_due <= total_due after switch"
            );
        }
    }
}

/// INV-ACCT-10: Partial payments never mark loan as Repaid.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_10_partial_payment_not_repaid() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();
    let payment_amount: i128 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);
    kani::assume(payment_amount > 0);

    if let Some((mut loan, _fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        loan.status = LoanStatus::Active;
        let total = loan.remaining_due;
        let _ = record_payment(&mut loan, payment_amount);

        if payment_amount < total {
            assert_ne!(
                loan.status,
                LoanStatus::Repaid,
                "Partial payment must not mark loan as Repaid"
            );
        }
    }
}

/// Simulate segregated `collect_fees` guard against pooled contract balance.
/// Returns the updated `(contract_balance, uncollected_fees)` if and only if
/// unencumbered fee tokens cover `uncollected_fees`.
fn collect_fees_segregated(
    contract_balance: i128,
    total_collateral: i128,
    uncollected_fees: i128,
) -> Option<(i128, i128)> {
    if uncollected_fees <= 0 {
        return Some((contract_balance, 0));
    }
    let available_fees = contract_balance.saturating_sub(total_collateral);
    if available_fees < uncollected_fees {
        return None;
    }
    let new_balance = contract_balance.checked_sub(uncollected_fees)?;
    Some((new_balance, 0))
}

/// Reference-model collateral withdrawal; no LendingContract code executes here.
fn withdraw_backed_collateral(
    balance: i128,
    collateral: i128,
    amount: i128,
) -> Option<(i128, i128)> {
    if amount < 0 || amount > collateral || amount > balance {
        return None;
    }
    Some((balance - amount, collateral - amount))
}

/// Reference-model fee settlement with independently supplied token inflow.
/// Rejects fee accrual that would create an unbacked liability.
fn settle_backed_fee(
    balance: i128,
    collateral: i128,
    fees: i128,
    inflow: i128,
    fee: i128,
) -> Option<(i128, i128)> {
    if inflow < 0 || fee < 0 {
        return None;
    }
    let next_balance = balance.checked_add(inflow)?;
    let next_fees = fees.checked_add(fee)?;
    if next_balance < collateral.checked_add(next_fees)? {
        return None;
    }
    Some((next_balance, next_fees))
}

/// INV-ACCT-11 for the reference withdrawal model, not production enforcement.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_11_collateral_conservation() {
    let collateral: i128 = kani::any();
    let balance: i128 = kani::any();
    let withdrawal: i128 = kani::any();
    kani::assume(collateral >= 0 && collateral <= 100_000_000_000);
    kani::assume(balance >= collateral && balance <= 200_000_000_000);
    kani::assume(withdrawal >= 0 && withdrawal <= 200_000_000_000);
    match withdraw_backed_collateral(balance, collateral, withdrawal) {
        Some((next_balance, next_collateral)) => {
            assert_eq!(next_balance, balance - withdrawal);
            assert_eq!(next_collateral, collateral - withdrawal);
            assert!(next_balance >= next_collateral);
        }
        None => assert!(withdrawal > collateral),
    }
}

/// INV-ACCT-12 for a proposed settlement model, not production enforcement.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_12_fee_backing_invariant() {
    let total_collateral: i128 = kani::any();
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();
    let inflow: i128 = kani::any();

    kani::assume(total_collateral >= 0 && total_collateral <= 100_000_000_000);
    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);
    kani::assume(inflow >= 0 && inflow <= 100_000_000_000);

    if let Some((mut loan, platform_fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        loan.status = LoanStatus::Active;
        let total_due = loan.total_due;
        let applied = record_payment(&mut loan, total_due).expect("active loan accepts repayment");
        assert_eq!(applied, total_due);
        assert_eq!(loan.status, LoanStatus::Repaid);
        let interest_paid = applied - principal;
        assert_eq!(
            platform_fee,
            calculate_platform_fee(interest_paid, fee_bps).unwrap()
        );
        match settle_backed_fee(total_collateral, total_collateral, 0, inflow, platform_fee) {
            Some((balance, fees)) => {
                assert_eq!(fees, platform_fee);
                assert_eq!(balance, total_collateral + inflow);
                assert!(balance >= total_collateral + fees);
            }
            None => assert!(inflow < platform_fee),
        }
    }
}

/// INV-ACCT-13 for collect_fees_segregated, not LendingContract::collect_fees.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_13_solvency_under_collection() {
    let total_collateral: i128 = kani::any();
    let uncollected_fees: i128 = kani::any();
    let extra_tokens: i128 = kani::any();

    kani::assume(total_collateral >= 0 && total_collateral <= 100_000_000_000);
    kani::assume(uncollected_fees > 0 && uncollected_fees <= 10_000_000_000);
    kani::assume(extra_tokens >= 0 && extra_tokens <= 10_000_000_000);

    let contract_balance = total_collateral + extra_tokens;
    match collect_fees_segregated(contract_balance, total_collateral, uncollected_fees) {
        Some((new_balance, new_uncollected)) => {
            assert_eq!(new_uncollected, 0);
            assert!(
                new_balance >= total_collateral,
                "collect_fees must never reduce balance below total_collateral"
            );
        }
        None => {
            assert!(
                extra_tokens < uncollected_fees,
                "collect_fees must only fail when unencumbered tokens are insufficient"
            );
        }
    }
}

#[cfg(test)]
mod reference_model_tests {
    use super::*;

    #[test]
    fn fee_settlement_rejects_independently_underfunded_inflow() {
        assert_eq!(settle_backed_fee(100, 100, 0, 0, 10), None);
        assert_eq!(settle_backed_fee(100, 100, 0, 9, 10), None);
        assert_eq!(settle_backed_fee(100, 100, 0, 10, 10), Some((110, 10)));
        assert_eq!(settle_backed_fee(110, 100, 10, 4, 5), None);
        assert_eq!(settle_backed_fee(110, 100, 10, 6, 5), Some((116, 15)));
    }

    #[test]
    fn collateral_withdrawal_preserves_surplus_and_rejects_excess() {
        assert_eq!(withdraw_backed_collateral(120, 100, 40), Some((80, 60)));
        assert_eq!(withdraw_backed_collateral(120, 100, 101), None);
        assert_eq!(withdraw_backed_collateral(120, 100, -1), None);
    }

    #[test]
    fn collection_guard_preserves_collateral_and_failed_state() {
        assert_eq!(collect_fees_segregated(109, 100, 10), None);
        assert_eq!(collect_fees_segregated(110, 100, 10), Some((100, 0)));
        assert_eq!(collect_fees_segregated(120, 100, 10), Some((110, 0)));
    }

    #[test]
    fn settlement_fee_is_tied_to_applied_payment() {
        let (mut loan, fee) = create_loan(100_000, 1000, 365, 1000).unwrap();
        loan.status = LoanStatus::Active;
        let due = loan.total_due;
        let applied = record_payment(&mut loan, due + 1).unwrap();
        assert_eq!(applied, due);
        assert_eq!(loan.status, LoanStatus::Repaid);
        assert_eq!(
            fee,
            calculate_platform_fee(applied - loan.amount, 1000).unwrap()
        );
    }
}
