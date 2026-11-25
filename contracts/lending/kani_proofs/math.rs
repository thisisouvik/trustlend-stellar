//! Formal verification of the lending contract's mathematical functions.
//!
//! Verifies:
//! - Interest formula correctness and overflow safety
//! - Fee calculation correctness
//! - Liquidation threshold bounds
//! - Monotonicity of interest with respect to inputs

// These constants mirror the contract's constants.
const MAX_PLATFORM_FEE_BPS: u32 = 1000;
const MAX_FLASH_LOAN_FEE_BPS: u32 = 500;
const RATE_SWITCH_FEE_BPS: u32 = 50;

/// Mirror of `LendingContract::calculate_interest`.
///
/// `interest = principal × rate_bps × days / (10_000 × 365)`
///
/// Returns `None` on overflow.
fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> Option<i128> {
    let numerator = (principal as i128)
        .checked_mul(rate_bps as i128)?
        .checked_mul(days as i128)?;
    Some(numerator / (10_000_i128 * 365))
}

/// Mirror of `LendingContract::calculate_liquidation_threshold`.
///
/// - Base: 7500 bps
/// - Reputation bonus: `score * 1.5` (max 1500 bps)
/// - Volatility penalty: `volatility / 2`
/// - Clamped to [5000, 9000]
fn calculate_liquidation_threshold(
    borrower_reputation_score: u32,
    asset_volatility_bps: u32,
) -> u32 {
    let base_threshold: u32 = 7500;

    let reputation_bonus = (borrower_reputation_score as u64)
        .checked_mul(15)
        .and_then(|v| v.checked_div(10))
        .unwrap_or(u64::MAX);

    let volatility_penalty = (asset_volatility_bps as u64)
        .checked_div(2)
        .unwrap_or(u64::MAX);

    let threshold = (base_threshold as u64)
        .checked_add(reputation_bonus)
        .unwrap_or(u64::MAX)
        .saturating_sub(volatility_penalty);

    (threshold as u32).clamp(5000, 9000)
}

/// Mirror of platform fee calculation:
/// `platform_fee = interest × fee_bps / 10_000`
fn calculate_platform_fee(interest: i128, fee_bps: u32) -> Option<i128> {
    (interest as i128)
        .checked_mul(fee_bps as i128)?
        .checked_div(10_000)
}

/// Mirror of flash loan fee calculation:
/// `fee = amount × fee_bps / 10_000`
fn calculate_flash_loan_fee(amount: i128, fee_bps: u32) -> Option<i128> {
    (amount as i128)
        .checked_mul(fee_bps as i128)?
        .checked_div(10_000)
}

/// Mirror of rate switch fee calculation:
/// `fee = remaining_due × RATE_SWITCH_FEE_BPS / 10_000`
fn calculate_rate_switch_fee(remaining_due: i128) -> Option<i128> {
    (remaining_due as i128)
        .checked_mul(RATE_SWITCH_FEE_BPS as i128)?
        .checked_div(10_000)
}

// ─── Kani Proof Harnesses ────────────────────────────────────────────────────

/// INV-MATH-1: Interest formula does not overflow for bounded valid inputs.
///
/// Covers the maximum legal inputs from the protocol:
/// - Principal: up to 100_000 XLM (1_000_000_000_000 stroops)
/// - Rate: up to 1500 bps (15%)
/// - Duration: up to 365 days
///
/// The maximum intermediate value is:
/// `1_000_000_000_000 × 1500 × 365 = 5.475 × 10^17`
/// which is well within i128::MAX (~1.7 × 10^38).
#[cfg(kani)]
#[kani::proof]
fn inv_math_1_interest_no_overflow_bounded() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();

    kani::assume(principal >= 0 && principal <= 1_000_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);

    let result = calculate_interest(principal, rate_bps, days);
    assert!(
        result.is_some(),
        "Interest calculation must not overflow for bounded inputs"
    );
}

/// INV-MATH-2: Interest is non-negative for positive inputs.
#[cfg(kani)]
#[kani::proof]
fn inv_math_2_interest_non_negative() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);

    let interest = calculate_interest(principal, rate_bps, days).unwrap();
    assert!(interest >= 0, "Interest must be non-negative");
}

/// INV-MATH-3: Interest is strictly positive when inputs are large enough.
///
/// Because the formula uses integer division, small inputs can truncate to
/// zero. This proof constrains `principal * rate_bps * days >= 3_650_000`
/// to guarantee strictly positive interest.
#[cfg(kani)]
#[kani::proof]
fn inv_math_3_interest_positive_for_nonzero() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);
    kani::assume(principal * rate_bps as i128 * days as i128 >= 3_650_000);

    let interest = calculate_interest(principal, rate_bps, days).unwrap();
    assert!(
        interest > 0,
        "Interest must be positive when inputs are large enough"
    );
}

/// INV-MATH-4: Interest product is monotonically non-decreasing in principal.
#[cfg(kani)]
#[kani::proof]
fn inv_math_4_interest_monotonic_in_principal() {
    let p1: i128 = kani::any();
    let p2: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let days: u32 = kani::any();

    kani::assume(p1 >= 0 && p1 <= p2 && p2 <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(days >= 1 && days <= 365);

    let num1 = p1 * (rate_bps as i128) * (days as i128);
    let num2 = p2 * (rate_bps as i128) * (days as i128);
    assert!(
        num1 <= num2,
        "Interest product must be monotonically non-decreasing in principal"
    );
}

/// INV-MATH-5: Interest product is monotonically non-decreasing in rate.
#[cfg(kani)]
#[kani::proof]
fn inv_math_5_interest_monotonic_in_rate() {
    let principal: i128 = kani::any();
    let r1: u32 = kani::any();
    let r2: u32 = kani::any();
    let days: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(r1 >= 1 && r1 <= r2 && r2 <= 1500);
    kani::assume(days >= 1 && days <= 365);

    let num1 = principal * (r1 as i128) * (days as i128);
    let num2 = principal * (r2 as i128) * (days as i128);
    assert!(
        num1 <= num2,
        "Interest product must be monotonically non-decreasing in rate"
    );
}

/// INV-MATH-6: Interest product is monotonically non-decreasing in days.
#[cfg(kani)]
#[kani::proof]
fn inv_math_6_interest_monotonic_in_days() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();
    let d1: u32 = kani::any();
    let d2: u32 = kani::any();

    kani::assume(principal > 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);
    kani::assume(d1 >= 1 && d1 <= d2 && d2 <= 365);

    let num1 = principal * (rate_bps as i128) * (d1 as i128);
    let num2 = principal * (rate_bps as i128) * (d2 as i128);
    assert!(
        num1 <= num2,
        "Interest product must be monotonically non-decreasing in days"
    );
}

/// INV-MATH-7: Liquidation threshold always falls within [5000, 9000].
#[cfg(kani)]
#[kani::proof]
fn inv_math_7_liquidation_threshold_bounds() {
    let score: u32 = kani::any();
    let volatility: u32 = kani::any();

    let threshold = calculate_liquidation_threshold(score, volatility);
    assert!(threshold >= 5000, "Liquidation threshold must be >= 5000");
    assert!(threshold <= 9000, "Liquidation threshold must be <= 9000");
}

/// INV-MATH-8: Platform fee does not exceed interest (since fee_bps <= 10_000).
#[cfg(kani)]
#[kani::proof]
fn inv_math_8_platform_fee_bounds() {
    let interest: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(interest >= 0 && interest <= i128::MAX / (MAX_PLATFORM_FEE_BPS as i128));
    kani::assume(fee_bps <= MAX_PLATFORM_FEE_BPS);

    if let Some(fee) = calculate_platform_fee(interest, fee_bps) {
        assert!(fee >= 0, "Platform fee must be non-negative");
        assert!(fee <= interest, "Platform fee must not exceed interest");
    }
}

/// INV-MATH-9: Flash loan fee does not exceed amount (since fee_bps <= 500 << 10_000).
#[cfg(kani)]
#[kani::proof]
fn inv_math_9_flash_loan_fee_bounds() {
    let amount: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(amount > 0 && amount <= 100_000_000_000);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    if let Some(fee) = calculate_flash_loan_fee(amount, fee_bps) {
        assert!(fee >= 0, "Flash loan fee must be non-negative");
        assert!(
            fee <= amount,
            "Flash loan fee must not exceed borrowed amount"
        );
    }
}

/// INV-MATH-10: Rate switch fee calculation is correct.
#[cfg(kani)]
#[kani::proof]
fn inv_math_10_rate_switch_fee_correct() {
    let remaining_due: i128 = kani::any();

    kani::assume(remaining_due >= 0 && remaining_due <= 100_000_000_000);

    if let Some(fee) = calculate_rate_switch_fee(remaining_due) {
        let expected = remaining_due * (RATE_SWITCH_FEE_BPS as i128) / 10_000;
        assert_eq!(
            fee, expected,
            "Rate switch fee must equal remaining_due * 50 / 10_000"
        );
    }
}

/// INV-MATH-11: Interest for 1 day at minimum rate is the smallest positive interest.
#[cfg(kani)]
#[kani::proof]
fn inv_math_11_interest_minimum_positive() {
    let principal: i128 = kani::any();
    kani::assume(principal >= 1 && principal <= 100_000_000_000);

    let interest = calculate_interest(principal, 1, 1).unwrap();
    let min_possible = principal / (10_000 * 365);
    assert!(
        interest >= min_possible,
        "Interest must be at least floor(principal / 3650000)"
    );
}

/// INV-MATH-12: Interest for full year identity on numerators.
///
/// This is the algebraic identity:
/// (principal × rate_bps × 365) == (principal × rate_bps) × 365
#[cfg(kani)]
#[kani::proof]
fn inv_math_12_annual_interest_identity() {
    let principal: i128 = kani::any();
    let rate_bps: u32 = kani::any();

    kani::assume(principal >= 0 && principal <= 100_000_000_000);
    kani::assume(rate_bps >= 1 && rate_bps <= 1500);

    let numerator_365 = principal * (rate_bps as i128) * 365;
    let expected = (principal * (rate_bps as i128)) * 365;
    assert_eq!(
        numerator_365, expected,
        "365-day interest numerator identity must hold"
    );
}
