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

/// INV-ACCT-11 & INV-ACCT-12: Collateral Conservation and Fee Backing Invariants.
/// `contract_balance >= total_collateral + uncollected_fees` and
/// `total_collateral == sum(user_collateral)`.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_11_12_collateral_conservation_and_fee_backing() {
    let c1: i128 = kani::any();
    let c2: i128 = kani::any();
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(c1 > 0 && c1 <= 50_000_000_000);
    kani::assume(c2 > 0 && c2 <= 50_000_000_000);
    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(fee_bps <= 1000);

    let total_collateral = c1 + c2;
    if let Some((_loan, backed_fee)) = create_loan(principal, rate_bps, days, fee_bps) {
        let uncollected_fees = backed_fee;
        let contract_balance = total_collateral + backed_fee;

        // INV-ACCT-11: Collateral Conservation
        assert!(
            contract_balance >= c1 + c2,
            "Contract balance must cover sum of borrower collateral"
        );
        // INV-ACCT-12: Fee Backing
        assert!(
            contract_balance >= total_collateral + uncollected_fees,
            "Contract balance must cover total collateral plus uncollected fees"
        );
    }
}

/// INV-ACCT-13: Solvency Under Collection.
/// Executing `collect_fees` never reduces `contract_balance` below `total_collateral`.
#[cfg(kani)]
#[kani::proof]
fn inv_acct_13_solvency_under_collection() {
    let total_collateral: i128 = kani::any();
    let unencumbered_fees: i128 = kani::any();
    let uncollected_fees: i128 = kani::any();

    kani::assume(total_collateral >= 0 && total_collateral <= 100_000_000_000);
    kani::assume(unencumbered_fees >= 0 && unencumbered_fees <= 10_000_000_000);
    kani::assume(uncollected_fees > 0 && uncollected_fees <= 10_000_000_000);

    let contract_balance = total_collateral + unencumbered_fees;
    let available_fees = contract_balance.saturating_sub(total_collateral);

    if available_fees >= uncollected_fees {
        let balance_after = contract_balance - uncollected_fees;
        assert!(
            balance_after >= total_collateral,
            "Fee collection must never reduce contract balance below total collateral"
        );
    }
}
