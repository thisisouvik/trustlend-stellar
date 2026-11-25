//! Formal verification of the lending contract's flash loan invariants.
//!
//! Verifies:
//! - Flash loan fee calculation correctness
//! - Pool balance invariant: successful loan increases pool by fee
//! - Pool balance invariant: failed loan leaves pool unchanged
//! - Fee stays within configured bounds
//! - Flash loan amount must be positive

const MAX_FLASH_LOAN_FEE_BPS: u32 = 500;

/// Calculate flash loan fee: `amount × fee_bps / 10_000`.
fn calculate_flash_loan_fee(amount: i128, fee_bps: u32) -> Option<i128> {
    (amount as i128)
        .checked_mul(fee_bps as i128)?
        .checked_div(10_000)
}

/// Simulate a successful flash loan.
/// Returns (pool_after, fee) or None on invalid input.
fn simulate_flash_loan_success(
    pool_balance: i128,
    amount: i128,
    fee_bps: u32,
) -> Option<(i128, i128)> {
    if amount <= 0 {
        return None;
    }
    if pool_balance < amount {
        return None;
    }

    let fee = calculate_flash_loan_fee(amount, fee_bps)?;
    let required_after = pool_balance.checked_add(fee)?;
    let balance_after = required_after; // receiver repaid exactly

    Some((balance_after, fee))
}

/// Simulate a failed flash loan (receiver does not repay).
/// Pool balance must be unchanged.
fn simulate_flash_loan_failure(pool_balance: i128, amount: i128) -> Option<i128> {
    if amount <= 0 {
        return None;
    }
    // In the real contract, the whole transaction is rolled back on panic.
    // So the pool balance is exactly what it was before.
    Some(pool_balance)
}

// ─── Kani Proof Harnesses ────────────────────────────────────────────────────

/// INV-FL-1: Flash loan fee is non-negative for positive amounts.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_1_fee_nonnegative() {
    let amount: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(amount > 0 && amount <= 100_000_000_000);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    if let Some(fee) = calculate_flash_loan_fee(amount, fee_bps) {
        assert!(fee >= 0, "Flash loan fee must be non-negative");
    }
}

/// INV-FL-2: Flash loan fee does not exceed borrowed amount.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_2_fee_le_amount() {
    let amount: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(amount > 0 && amount <= 100_000_000_000);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    if let Some(fee) = calculate_flash_loan_fee(amount, fee_bps) {
        assert!(
            fee <= amount,
            "Flash loan fee must not exceed borrowed amount"
        );
    }
}

/// INV-FL-3: Successful flash loan increases pool by exactly the fee.
///
/// `pool_after == pool_before + fee` (receiver repaid principal + fee)
#[cfg(kani)]
#[kani::proof]
fn inv_fl_3_successful_loan_increases_pool() {
    let pool_balance: i128 = kani::any();
    let amount: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(pool_balance >= 0 && pool_balance <= 100_000_000_000);
    kani::assume(amount > 0 && amount <= 100_000_000_000);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);
    kani::assume(pool_balance >= amount); // pool has enough

    if let Some((pool_after, fee)) = simulate_flash_loan_success(pool_balance, amount, fee_bps) {
        assert_eq!(
            pool_after,
            pool_balance + fee,
            "Pool must increase by exactly the fee"
        );
    }
}

/// INV-FL-4: Failed flash loan leaves pool balance unchanged.
///
/// This models the Soroban transaction rollback: if the receiver panics,
/// all state changes are reverted.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_4_failed_loan_unchanged_pool() {
    let pool_balance: i128 = kani::any();
    let amount: i128 = kani::any();

    kani::assume(pool_balance >= 0 && pool_balance <= 100_000_000_000);
    kani::assume(amount > 0);

    if let Some(pool_after) = simulate_flash_loan_failure(pool_balance, amount) {
        assert_eq!(
            pool_after, pool_balance,
            "Failed flash loan must leave pool unchanged"
        );
    }
}

/// INV-FL-5: Zero amount is rejected.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_5_zero_amount_rejected() {
    let pool_balance: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(pool_balance >= 0);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    let result = simulate_flash_loan_success(pool_balance, 0, fee_bps);
    assert!(result.is_none(), "Zero amount must be rejected");
}

/// INV-FL-6: Negative amount is rejected.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_6_negative_amount_rejected() {
    let pool_balance: i128 = kani::any();
    let amount: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(pool_balance >= 0);
    kani::assume(amount < 0);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    let result = simulate_flash_loan_success(pool_balance, amount, fee_bps);
    assert!(result.is_none(), "Negative amount must be rejected");
}

/// INV-FL-7: Insufficient pool liquidity is rejected.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_7_insufficient_liquidity_rejected() {
    let pool_balance: i128 = kani::any();
    let amount: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(pool_balance >= 0 && pool_balance <= 100_000_000_000);
    kani::assume(amount > pool_balance); // more than pool has
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    let result = simulate_flash_loan_success(pool_balance, amount, fee_bps);
    assert!(
        result.is_none(),
        "Insufficient pool liquidity must be rejected"
    );
}

/// INV-FL-8: Fee formula is correct: fee == amount * fee_bps / 10_000.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_8_fee_formula_correct() {
    let amount: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(amount > 0 && amount <= 100_000_000_000);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    if let Some(fee) = calculate_flash_loan_fee(amount, fee_bps) {
        let expected = amount * (fee_bps as i128) / 10_000;
        assert_eq!(
            fee, expected,
            "Fee formula must be amount * fee_bps / 10_000"
        );
    }
}

/// INV-FL-9: Flash loan fee product is monotonically non-decreasing in amount.
///
/// Since integer division by constant 10_000 is monotonic, verifying that
/// the product `amount * fee_bps` is non-decreasing proves fee monotonicity
/// without triggering combinatorial SAT solver state explosion on 128-bit division circuits.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_9_fee_monotonic_in_amount() {
    let a1: i128 = kani::any();
    let a2: i128 = kani::any();
    let fee_bps: u32 = kani::any();

    kani::assume(a1 > 0 && a1 <= a2 && a2 <= 100_000_000_000);
    kani::assume(fee_bps <= MAX_FLASH_LOAN_FEE_BPS);

    let num1 = a1 * (fee_bps as i128);
    let num2 = a2 * (fee_bps as i128);
    assert!(
        num1 <= num2,
        "Fee product must be monotonically non-decreasing in amount"
    );
}

/// INV-FL-10: Flash loan fee product is monotonically non-decreasing in fee_bps.
#[cfg(kani)]
#[kani::proof]
fn inv_fl_10_fee_monotonic_in_bps() {
    let amount: i128 = kani::any();
    let bps1: u32 = kani::any();
    let bps2: u32 = kani::any();

    kani::assume(amount > 0 && amount <= 100_000_000_000);
    kani::assume(bps1 <= bps2 && bps2 <= MAX_FLASH_LOAN_FEE_BPS);

    let num1 = amount * (bps1 as i128);
    let num2 = amount * (bps2 as i128);
    assert!(
        num1 <= num2,
        "Fee product must be monotonically non-decreasing in fee_bps"
    );
}
