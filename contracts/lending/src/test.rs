#![cfg(test)]
#![allow(clippy::inconsistent_digit_grouping)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, vec, Address, Env, Vec,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    // Multisig-gated functions are exercised for real in `multisig_admin`'s
    // integration tests; here `admin` stands in as its own "multisig" so the
    // rest of this suite can focus on loan-lifecycle behaviour.
    client.set_multisig_admin(&admin, &admin);

    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    link_reputation(&env, &client, &admin, &borrower);

    (env, contract_id, admin, borrower, collateral_asset)
}

/// Deploy a real BorrowerReputationContract, link it to the lending contract
/// and give `borrower` a Platinum profile (100 000 XLM limit), so the rest of
/// the suite can focus on loan-lifecycle behaviour (Issue #335).
fn link_reputation(env: &Env, client: &LendingContractClient, admin: &Address, borrower: &Address) {
    let reputation_id = env.register(borrower_reputation::BorrowerReputationContract, ());
    borrower_reputation::BorrowerReputationContractClient::new(env, &reputation_id)
        .initialize(admin);
    client.set_reputation_contract(admin, &reputation_id);
    give_reputation_profile(env, client, admin, borrower, 4);
}

/// Create an on-chain reputation profile for `borrower` at `tier`
/// (0=None … 4=Platinum) in the reputation contract linked to `client`.
fn give_reputation_profile(
    env: &Env,
    client: &LendingContractClient,
    admin: &Address,
    borrower: &Address,
    tier: u32,
) {
    let reputation_id = client
        .get_reputation_contract()
        .expect("reputation contract not linked");
    let reputation =
        borrower_reputation::BorrowerReputationContractClient::new(env, &reputation_id);
    reputation.init_borrower(borrower);
    if tier > 0 {
        reputation.apply_zk_tier_upgrade(
            admin,
            borrower,
            &tier,
            &BytesN::from_array(env, &[tier as u8; 32]),
        );
    }
}

// Maximum i128 value — useful for overflow boundary checks.
const I128_MAX: i128 = i128::MAX;

// ─── Normal-case tests ────────────────────────────────────────────────────────

/// Basic happy-path: loan request created with correct totals.
#[test]
fn test_create_loan_request_basic() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // 1 000 XLM at 10 % for 30 days
    // interest = 1_000_0000000 * 1000 * 30 / (10_000 * 365) = 8_219_178 stroops ≈ 0.82 XLM
    let principal: i128 = 1_000_0000000;
    let rate_bps: u32 = 1000;
    let days: u32 = 30;
    let max_loan: i128 = 100_000_0000000;

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: max_loan,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    assert_eq!(loan_id, 1);

    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.amount, principal);
    assert_eq!(loan.duration_days, days);
    assert_eq!(loan.interest_rate_bps, rate_bps);
    assert!(
        loan.total_due > principal,
        "total_due must exceed principal"
    );
    assert_eq!(loan.remaining_due, loan.total_due);
    assert_eq!(loan.status, LoanStatus::Pending);
}

#[test]
#[should_panic(expected = "Interest rate is below the protocol minimum")]
fn test_create_loan_request_rejects_rate_below_protocol_minimum() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: MIN_BORROW_AMOUNT,
            duration_days: 30,
            interest_rate_bps: 0,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry { asset: collateral_asset, amount: 100_000_0000000 },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 4,
        },
    );
}

/// Verify the interest formula numerically for a known input.
#[test]
fn test_interest_calculation_is_correct() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // 10 000 XLM at 15 % for 365 days → full annual interest = 10_000 * 15 % = 1 500 XLM
    let principal: i128 = 10_000_0000000; // 10 000 XLM in stroops
    let rate_bps: u32 = 1500;
    let days: u32 = 365;
    let expected_interest: i128 = principal * 1500 / 10_000; // = 1 500 XLM

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: (principal * 2),
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    let loan = client.get_loan(&loan_id);

    let actual_interest = loan.total_due - principal;
    assert_eq!(actual_interest, expected_interest);
}

/// Maximum allowed duration (365 days) must succeed.
#[test]
fn test_create_loan_max_duration_365_days() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let principal: i128 = 500_0000000; // 500 XLM
    let rate_bps: u32 = 800;
    let days: u32 = 365;
    let max_loan: i128 = 1_000_000_0000000;

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: max_loan,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.duration_days, 365);
    assert!(loan.total_due > principal);
}

/// A loan with duration 1 day (minimum) must succeed.
#[test]
fn test_create_loan_min_duration_1_day() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 1,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.duration_days, 1);
}

// ─── Overflow-protection tests ────────────────────────────────────────────────

/// A very large but still valid principal (Platinum tier max: 100 000 XLM)
/// at the highest rate (1500 bps) for the longest valid duration (365 days)
/// must NOT overflow — this is the extreme-but-legal boundary.
#[test]
fn test_no_overflow_at_maximum_valid_inputs() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Set high collateral factor so borrowing power check passes
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: 9500,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );

    // Platinum tier max = 100 000 XLM = 100_000 * 10_000_000 stroops
    let principal: i128 = 100_000_0000000_i128; // 100 000 XLM
    let rate_bps: u32 = 1500; // highest rate (None tier)
    let days: u32 = 365; // maximum duration

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: principal,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 200_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    let loan = client.get_loan(&loan_id);
    assert!(loan.total_due > principal);
}

/// Passing a principal of i128::MAX should panic with an overflow message,
/// not silently wrap around to a wrong value.
///
/// Such a principal can no longer reach the interest maths through
/// `create_loan_request` (the on-chain credit limit rejects it first, see
/// Issue #335), so the helper is exercised directly.
#[test]
#[should_panic(expected = "Overflow: principal × rate_bps")]
fn test_overflow_panics_with_near_max_principal() {
    // i128::MAX principal × any rate_bps > 1 will overflow the first checked_mul.
    LendingContract::calculate_interest(I128_MAX, 1500, 365);
}

/// A principal that overflows only at the second multiplication step
/// (principal × rate_bps fits, but × days does not) must still panic cleanly.
#[test]
#[should_panic(expected = "Overflow: (principal × rate_bps) × days")]
fn test_overflow_panics_at_second_multiplication() {
    // i128::MAX / 1500 ≈ 1.13 × 10^35 — this value times 1500 fits in i128,
    // but multiplying again by 365 will overflow.
    let boundary_principal: i128 = I128_MAX / 1500;
    LendingContract::calculate_interest(boundary_principal, 1500, 365);
}

/// A principal above the borrower's on-chain credit limit is rejected
/// before any interest arithmetic happens, even when the client claims an
/// unlimited `max_loan_amount`.
#[test]
#[should_panic(expected = "Amount exceeds reputation-based limit")]
fn test_near_max_principal_rejected_by_on_chain_limit() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: I128_MAX,
            duration_days: 365,
            interest_rate_bps: 1500,
            max_loan_amount: I128_MAX,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 4,
        },
    );
}

// ─── Validation-guard tests ───────────────────────────────────────────────────

/// Duration of 0 must be rejected before any arithmetic happens.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_zero_is_rejected() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 0,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
}

/// Duration exceeding 365 days must be rejected.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_366_is_rejected() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 366,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
}

/// Zero-amount loan must be rejected.
#[test]
#[should_panic(expected = "Loan amount must be positive")]
fn test_zero_amount_is_rejected() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 0,
            duration_days: 30,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
}

/// Dust loan amounts below MIN_BORROW_AMOUNT (1 XLM = 10_000_000 stroops) must be rejected.
#[test]
#[should_panic(expected = "Loan amount below minimum borrow threshold")]
fn test_dust_loan_below_min_borrow_amount_is_rejected() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // 1 stroop (0.0000001 XLM) dust loan attempt
    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1,
            duration_days: 30,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
}

/// Boundary check: Loan amount exactly at MIN_BORROW_AMOUNT (10_000_000 stroops = 1 XLM) is accepted.
#[test]
fn test_min_borrow_amount_boundary_accepted() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: MIN_BORROW_AMOUNT,
            duration_days: 30,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );

    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.amount, MIN_BORROW_AMOUNT);
    assert_eq!(client.get_min_borrow_amount(), MIN_BORROW_AMOUNT);
}

/// Amount exceeding the reputation-based limit must be rejected.
#[test]
#[should_panic(expected = "Amount exceeds reputation-based limit")]
fn test_amount_over_max_is_rejected() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // A tier-None borrower's on-chain limit is 1 000 XLM.
    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 0);

    let max_loan: i128 = 1_000_0000000; // 1 000 XLM
    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: (max_loan + 1),
            duration_days: 30,
            interest_rate_bps: 1500,
            max_loan_amount: max_loan,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
}

/// Empty collateral entries must be rejected.
#[test]
#[should_panic(expected = "At least one collateral entry is required")]
fn test_empty_collateral_entries_rejected() {
    let (env, contract_id, _admin, borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: Vec::new(&env),
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
}

/// Non-whitelisted collateral asset must be rejected.
#[test]
#[should_panic(expected = "Collateral asset is not whitelisted")]
fn test_non_whitelisted_collateral_asset_rejected() {
    let (env, contract_id, _admin, borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let random_asset = Address::generate(&env);
    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: random_asset,
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
}

// ─── due_at overflow test ─────────────────────────────────────────────────────

/// Confirm that due_at is computed correctly without overflow.
/// For 365 days the offset is 365 * 86_400 = 31_536_000 seconds.
#[test]
fn test_due_at_computed_correctly() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(1_000_000_000_u64);
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    let days: u32 = 365;
    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: days,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    let loan = client.get_loan(&loan_id);

    let expected_due_at = 1_000_000_000_u64 + (365_u64 * 86_400);
    assert_eq!(loan.due_at, expected_due_at);
}

// ─── platform_fee test ────────────────────────────────────────────────────────

/// Platform fee must equal exactly 1 % of interest.
#[test]
fn test_platform_fee_is_one_percent_of_interest() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let principal: i128 = 10_000_0000000; // 10 000 XLM
    let rate_bps: u32 = 1500;
    let days: u32 = 365;

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: (principal * 2),
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    let loan = client.get_loan(&loan_id);

    let interest = loan.total_due - principal;
    assert_eq!(loan.platform_fee, interest / 100);
}

// ─── Dynamic liquidation threshold tests ─────────────────────────────────────

#[test]
fn test_liquidation_threshold_base() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 0, Volatility = 0
    // Expected: base threshold = 7500
    let threshold = client.calculate_liquidation_threshold(&0, &0);
    assert_eq!(threshold, 7500);
}

#[test]
fn test_liquidation_threshold_reputation_boost() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 500, Volatility = 0
    // Expected: 7500 + (500 * 1.5) = 7500 + 750 = 8250
    let threshold = client.calculate_liquidation_threshold(&500, &0);
    assert_eq!(threshold, 8250);

    // Reputation = 1000, Volatility = 0
    // Expected: 7500 + (1000 * 1.5) = 7500 + 1500 = 9000 (upper bound cap)
    let threshold = client.calculate_liquidation_threshold(&1000, &0);
    assert_eq!(threshold, 9000);
}

#[test]
fn test_liquidation_threshold_volatility_penalty() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 0, Volatility = 2000 (20%)
    // Expected: 7500 - (2000 / 2) = 7500 - 1000 = 6500
    let threshold = client.calculate_liquidation_threshold(&0, &2000);
    assert_eq!(threshold, 6500);
}

#[test]
fn test_liquidation_threshold_clamping_bounds() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Upper bound clamp: Reputation = 1000, Volatility = 0
    let threshold = client.calculate_liquidation_threshold(&1000, &0);
    assert_eq!(threshold, 9000);

    // Check Reputation = 2000 (abnormal), Volatility = 0
    let threshold = client.calculate_liquidation_threshold(&2000, &0);
    assert_eq!(threshold, 9000);

    // Lower bound clamp: Reputation = 0, Volatility = 8000 (80% volatility)
    let threshold = client.calculate_liquidation_threshold(&0, &8000);
    assert_eq!(threshold, 5000);
}

#[test]
fn test_liquidation_threshold_extreme_inputs_no_overflow() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let threshold = client.calculate_liquidation_threshold(&u32::MAX, &u32::MAX);
    assert!((5000..=9000).contains(&threshold));
}

// ─── Pausable / Multi-sig tests ──────────────────────────────────────────────

fn setup_with_multisig() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    client.initialize(&admin);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1.clone(), signer2.clone()];
    client.setup_multisig(&admin, &admins, &2);

    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    link_reputation(&env, &client, &admin, &borrower);

    (
        env,
        contract_id,
        admin,
        borrower,
        collateral_asset,
        signer1,
        signer2,
    )
}

fn create_request_struct(
    env: &Env,
    amount: i128,
    duration_days: u32,
    rate_bps: u32,
    max_loan: i128,
    collateral_asset: &Address,
    collateral_amount: i128,
    rate_model: InterestRateModel,
) -> LoanRequestInput {
    LoanRequestInput {
        amount,
        duration_days,
        interest_rate_bps: rate_bps,
        max_loan_amount: max_loan,
        collateral_entries: vec![
            env,
            CollateralEntry {
                asset: collateral_asset.clone(),
                amount: collateral_amount,
            },
        ],
        rate_model,
        reputation_tier: 0,
    }
}

#[test]
fn test_setup_multisig() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = client.get_multisig_admins();
    assert_eq!(admins.len(), 3);
    assert!(admins.iter().any(|a| a == admin));
    assert!(admins.iter().any(|a| a == signer1));
    assert!(admins.iter().any(|a| a == signer2));
    assert_eq!(client.get_multisig_threshold(), 2);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Threshold must be at least 1")]
fn test_setup_multisig_zero_threshold_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1, signer2];
    client.setup_multisig(&admin, &admins, &0);
}

#[test]
#[should_panic(expected = "Threshold exceeds number of admins")]
fn test_setup_multisig_threshold_too_high_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = soroban_sdk::vec![&env, signer1, signer2];
    client.setup_multisig(&admin, &admins, &5);
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_duplicate_pause_signer_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, _signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&admin);
}

#[test]
fn test_pause_activates_with_threshold() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    assert!(!client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 0);

    client.pause(&admin);
    assert!(!client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 1);

    client.pause(&signer1);
    assert!(client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 0);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_create_loan_request_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_approve_loan_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );

    client.pause(&admin);
    client.pause(&signer1);

    let lender = Address::generate(&env);
    client.approve_loan(&lender, &loan_id, &1);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_mark_defaulted_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.mark_defaulted(&admin, &loan_id);
}

#[test]
fn test_record_payment_allowed_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    client.pause(&admin);
    client.pause(&signer1);

    let status = client.record_payment(&admin, &loan_id, &500_0000000);
    assert_eq!(status, LoanStatus::Active);
}

#[test]
#[should_panic(expected = "Contract is not paused")]
fn test_unpause_when_not_paused_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, _signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.unpause(&admin);
}

#[test]
fn test_unpause_deactivates_with_threshold() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    client.unpause(&admin);
    assert!(client.is_paused());
    client.unpause(&signer1);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Signer has already authorised unpause")]
fn test_duplicate_unpause_signer_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.unpause(&admin);
    client.unpause(&admin);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_non_admin_cannot_pause() {
    let (env, contract_id, _admin, _borrower, _collateral_asset, _signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.pause(&random);
}

#[test]
#[should_panic(expected = "Multisig not configured")]
fn test_pause_without_multisig_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.pause(&admin);
}

#[test]
fn test_resume_operations_after_unpause() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    client.unpause(&admin);
    client.unpause(&signer2);
    assert!(!client.is_paused());

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    assert_eq!(loan_id, 1);
}

#[test]
fn test_multisig_admin_can_still_use_admin_functions_when_paused() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    let new_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &new_asset);
    assert!(client.is_asset_whitelisted(&new_asset));
}

#[test]
fn test_pause_unpause_events_emitted() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    let events = env.events().all();
    assert!(!events.is_empty());
}

// ─── Interest rate model tests ────────────────────────────────────────────────

/// Helper: creates and activates a loan, returning its ID.
fn create_and_activate_loan(
    env: &Env,
    client: &LendingContractClient,
    admin: &Address,
    borrower: &Address,
    collateral_asset: &Address,
    rate_model: &InterestRateModel,
) -> u32 {
    let principal: i128 = 1_000_0000000;
    let rate_bps: u32 = 1000;
    let days: u32 = 30;
    let max_loan: i128 = 100_000_0000000;

    let loan_id = client.create_loan_request(
        borrower,
        &create_request_struct(
            env,
            principal,
            days,
            rate_bps,
            max_loan,
            collateral_asset,
            100_000_0000000,
            rate_model.clone(),
        ),
    );

    client.approve_loan(admin, &loan_id, &1);
    client.activate_loan(admin, &loan_id);
    loan_id
}

/// Creating a Fixed-rate loan stores the model correctly.
#[test]
fn test_create_loan_with_fixed_rate_model() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1000,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Fixed);
    assert_eq!(loan.base_rate_bps, 1000);
}

/// Creating a Floating-rate loan stores the model correctly.
#[test]
fn test_create_loan_with_floating_rate_model() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Floating,
        ),
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Floating);
    assert_eq!(loan.base_rate_bps, 500);
}

/// Switching from Fixed to Floating and back works, charges fee, and toggles model.
#[test]
fn test_switch_rate_model_fixed_to_floating() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );
    let loan_before = client.get_loan(&loan_id);
    assert_eq!(loan_before.rate_model, InterestRateModel::Fixed);

    client.switch_rate_model(&borrower, &loan_id);
    let loan_after = client.get_loan(&loan_id);
    assert_eq!(loan_after.rate_model, InterestRateModel::Floating);

    let expected_fee = loan_before.remaining_due * 50 / 10_000;
    assert_eq!(
        loan_after.remaining_due,
        loan_before.remaining_due + expected_fee,
    );
}

/// Switching is blocked during the 24h cooldown.
#[test]
#[should_panic(expected = "Rate switch cooldown not elapsed")]
fn test_switch_rate_model_cooldown_enforced() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(1_000_000_000);
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );

    client.switch_rate_model(&borrower, &loan_id);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3600);
    client.switch_rate_model(&borrower, &loan_id);
}

/// Switching succeeds again after cooldown expires.
#[test]
fn test_switch_rate_model_allowed_after_cooldown() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(1_000_000_000);
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );

    client.switch_rate_model(&borrower, &loan_id);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Floating);

    env.ledger()
        .set_timestamp(env.ledger().timestamp() + 86_401);

    client.switch_rate_model(&borrower, &loan_id);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Fixed);
}

/// Only the borrower can switch the rate model.
#[test]
#[should_panic(expected = "Caller is not the borrower")]
fn test_switch_rate_model_only_borrower() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );

    let attacker = Address::generate(&env);
    client.switch_rate_model(&attacker, &loan_id);
}

/// Can only switch rate model on ACTIVE loans.
#[test]
#[should_panic(expected = "Can only switch rate model on ACTIVE loans")]
fn test_switch_rate_model_only_active() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1000,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.switch_rate_model(&borrower, &loan_id);
}

/// Admin can update the floating rate and remaining totals are recalculated.
#[test]
fn test_update_floating_rate() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Floating,
    );
    let loan_before = client.get_loan(&loan_id);
    assert_eq!(loan_before.interest_rate_bps, 1000);

    client.update_floating_rate(&admin, &loan_id, &2000);
    let loan_after = client.get_loan(&loan_id);
    assert_eq!(loan_after.interest_rate_bps, 2000);
}

/// update_floating_rate panics on a Fixed-rate loan.
#[test]
#[should_panic(expected = "Loan is not using floating rate model")]
fn test_update_floating_rate_rejects_fixed() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );
    client.update_floating_rate(&admin, &loan_id, &2000);
}

// ─── Flash Loan Receiver Contracts ────────────────────────────────────────────

mod good_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct GoodReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for GoodReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            fee: i128,
            pool: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            let caller = env.current_contract_address();
            let repayment = amount
                .checked_add(fee)
                .expect("Overflow computing repayment");
            token_client.transfer(&caller, &pool, &repayment);
        }
    }
}

mod generous_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct GenerousReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for GenerousReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            fee: i128,
            pool: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            let caller = env.current_contract_address();
            let repayment = amount
                .checked_add(fee)
                .expect("Overflow computing repayment")
                .checked_add(100)
                .expect("Overflow adding surplus");
            token_client.transfer(&caller, &pool, &repayment);
        }
    }
}

mod partial_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct PartialReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for PartialReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            _fee: i128,
            pool: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            let caller = env.current_contract_address();
            token_client.transfer(&caller, &pool, &amount);
        }
    }
}

mod stingy_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct StingyReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for StingyReceiver {
        fn execute_operation(
            _env: Env,
            _token: Address,
            _amount: i128,
            _fee: i128,
            _pool: Address,
            _params: Bytes,
        ) {
        }
    }
}

// ─── Flash Loan Test Helpers ──────────────────────────────────────────────────

fn setup_flash_loan() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);

    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);

    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let pool_funding: i128 = 1_000_000_0000000;
    let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&contract_id, &pool_funding);

    (env, contract_id, admin, borrower, token_address)
}

fn mint_tokens(env: &Env, token: &Address, recipient: &Address, amount: i128) {
    let token_admin_client = token::StellarAssetClient::new(env, token);
    token_admin_client.mint(recipient, &amount);
}

const DEFAULT_FLASH_LOAN_FEE_BPS: i128 = 9;

#[test]
fn test_flash_loan_success_full_repayment() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let loan_amount: i128 = 1_000_0000000;
    let fee = loan_amount * DEFAULT_FLASH_LOAN_FEE_BPS / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(
        &receiver_id,
        &token_address,
        &loan_amount,
        &Bytes::new(&env),
    );
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + fee);
}

#[test]
fn test_flash_loan_accepts_overpayment() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(generous_receiver::GenerousReceiver, ());
    let loan_amount: i128 = 1_000_0000000;
    let fee = loan_amount * DEFAULT_FLASH_LOAN_FEE_BPS / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, fee + 100);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(
        &receiver_id,
        &token_address,
        &loan_amount,
        &Bytes::new(&env),
    );
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + fee + 100);
}

#[test]
fn test_flash_loan_applies_custom_fee_bps() {
    let (env, contract_id, admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_flash_loan_fee_bps(&admin, &50);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let loan_amount: i128 = 10_000_0000000;
    let expected_fee = loan_amount * 50 / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, expected_fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(
        &receiver_id,
        &token_address,
        &loan_amount,
        &Bytes::new(&env),
    );
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + expected_fee);
}

#[test]
#[should_panic(expected = "Flash loan not repaid")]
fn test_flash_loan_reverts_when_receiver_repays_nothing() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(stingy_receiver::StingyReceiver, ());
    client.flash_loan(
        &receiver_id,
        &token_address,
        &1_000_0000000,
        &Bytes::new(&env),
    );
}

#[test]
#[should_panic(expected = "Flash loan not repaid")]
fn test_flash_loan_reverts_on_partial_repayment() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(partial_receiver::PartialReceiver, ());
    client.flash_loan(
        &receiver_id,
        &token_address,
        &1_000_0000000,
        &Bytes::new(&env),
    );
}

#[test]
fn test_failed_flash_loan_rolls_back_pool_balance() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(stingy_receiver::StingyReceiver, ());
    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);

    let result = client.try_flash_loan(
        &receiver_id,
        &token_address,
        &1_000_0000000,
        &Bytes::new(&env),
    );
    assert!(result.is_err(), "flash_loan should have panicked");

    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_before, pool_after);
}

#[test]
fn test_pool_usable_again_immediately_after_a_failed_flash_loan() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let stingy_id = env.register(stingy_receiver::StingyReceiver, ());
    let result = client.try_flash_loan(
        &stingy_id,
        &token_address,
        &1_000_0000000,
        &Bytes::new(&env),
    );
    assert!(result.is_err());

    let good_id = env.register(good_receiver::GoodReceiver, ());
    let fee = 1_000_0000000 * DEFAULT_FLASH_LOAN_FEE_BPS / 10_000;
    mint_tokens(&env, &token_address, &good_id, fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(&good_id, &token_address, &1_000_0000000, &Bytes::new(&env));
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + fee);
}

#[test]
#[should_panic(expected = "Insufficient pool liquidity for flash loan")]
fn test_flash_loan_rejects_amount_over_pool_liquidity() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let pool_balance = token::Client::new(&env, &token_address).balance(&contract_id);

    client.flash_loan(
        &receiver_id,
        &token_address,
        &(pool_balance + 1),
        &Bytes::new(&env),
    );
}

#[test]
#[should_panic(expected = "Flash loan amount must be positive")]
fn test_flash_loan_rejects_zero_amount() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    client.flash_loan(&receiver_id, &token_address, &0, &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "Flash loan amount must be positive")]
fn test_flash_loan_rejects_negative_amount() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    client.flash_loan(&receiver_id, &token_address, &(-1), &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "Unauthorised")]
fn test_only_admin_can_change_flash_loan_fee() {
    let (env, contract_id, _admin, _borrower, _token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.set_flash_loan_fee_bps(&random, &50);
}

#[test]
#[should_panic(expected = "Fee exceeds MAX_FLASH_LOAN_FEE_BPS")]
fn test_flash_loan_fee_capped() {
    let (env, contract_id, admin, _borrower, _token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_flash_loan_fee_bps(&admin, &501);
}

#[test]
fn test_flash_loan_fee_at_max_boundary_accepted() {
    let (env, contract_id, admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_flash_loan_fee_bps(&admin, &500);
    assert_eq!(client.get_flash_loan_fee_bps(), 500);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let loan_amount: i128 = 1_000_0000000;
    let expected_fee = loan_amount * 500 / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, expected_fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(
        &receiver_id,
        &token_address,
        &loan_amount,
        &Bytes::new(&env),
    );
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + expected_fee);
}

// ─── Multi-Asset Collateral Vault Tests ───────────────────────────────────────

fn setup_multi_collateral() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);

    let asset_a_admin = Address::generate(&env);
    let asset_b_admin = Address::generate(&env);
    let asset_a = env.register_stellar_asset_contract_v2(asset_a_admin).address();
    let asset_b = env.register_stellar_asset_contract_v2(asset_b_admin).address();
    client.whitelist_asset(&admin, &asset_a);
    client.whitelist_asset(&admin, &asset_b);
    for asset in [&asset_a, &asset_b] {
        client.set_asset_collateral_config(
            &admin,
            asset,
            &AssetCollateralConfig {
                collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
                has_price_oracle: true,
                volatility_bps: 0,
            },
        );
        client.set_asset_oracle_prices(&admin, asset, &vec![&env, PRICE_PRECISION]);
    }

    // Give each test borrower ample funds so deposits exercise real transfers.
    let funding = 1_000_000_000_000_000i128;
    token::StellarAssetClient::new(&env, &asset_a).mint(&borrower, &funding);
    token::StellarAssetClient::new(&env, &asset_b).mint(&borrower, &funding);

    link_reputation(&env, &client, &admin, &borrower);

    (env, contract_id, admin, borrower, asset_a, asset_b)
}

/// Deposit a single collateral asset succeeds.
#[test]
fn test_deposit_collateral_single_asset() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let token_client = token::Client::new(&env, &asset_a);
    let borrower_before = token_client.balance(&borrower);
    let contract_before = token_client.balance(&contract_id);
    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    assert_eq!(token_client.balance(&borrower), borrower_before - 1_000_0000000);
    assert_eq!(token_client.balance(&contract_id), contract_before + 1_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().asset, asset_a);
    assert_eq!(entries.get(0).unwrap().amount, 1_000_0000000);
}

/// Deposit multiple different collateral assets succeeds.
#[test]
fn test_deposit_collateral_multiple_assets() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &3_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 2);

    let entry_a = entries.get(0).unwrap();
    let entry_b = entries.get(1).unwrap();
    assert_eq!(entry_a.asset, asset_a);
    assert_eq!(entry_a.amount, 5_000_0000000);
    assert_eq!(entry_b.asset, asset_b);
    assert_eq!(entry_b.amount, 3_000_0000000);
}

/// Depositing the same asset twice accumulates the amount.
#[test]
fn test_deposit_collateral_same_asset_accumulates() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.deposit_collateral(&borrower, &asset_a, &2_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().amount, 3_000_0000000);
}

/// Deposit of zero amount is rejected.
#[test]
#[should_panic(expected = "Collateral amount must be positive")]
fn test_deposit_collateral_zero_amount_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &0);
}

/// Deposit to a non-whitelisted asset is rejected.
#[test]
#[should_panic(expected = "Asset is not whitelisted")]
fn test_deposit_collateral_non_whitelisted_asset_rejected() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random_asset = Address::generate(&env);
    client.deposit_collateral(&borrower, &random_asset, &1_000_0000000);
}

/// Withdraw collateral from a single asset reduces balance.
#[test]
fn test_withdraw_collateral_basic() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let token_client = token::Client::new(&env, &asset_a);
    let borrower_before = token_client.balance(&borrower);
    let contract_before = token_client.balance(&contract_id);
    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    assert_eq!(token_client.balance(&borrower), borrower_before - 5_000_0000000);
    assert_eq!(token_client.balance(&contract_id), contract_before + 5_000_0000000);
    client.withdraw_collateral(&borrower, &asset_a, &2_000_0000000);
    assert_eq!(token_client.balance(&borrower), borrower_before - 3_000_0000000);
    assert_eq!(token_client.balance(&contract_id), contract_before + 3_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().amount, 3_000_0000000);
}

/// Withdrawing the full amount removes the entry entirely.
#[test]
fn test_withdraw_collateral_full_amount_removes_entry() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &3_000_0000000);

    // Withdraw all of asset_a
    client.withdraw_collateral(&borrower, &asset_a, &5_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().asset, asset_b);
}

/// Withdrawing more than the balance is rejected.
#[test]
#[should_panic(expected = "Insufficient collateral balance for withdrawal")]
fn test_withdraw_collateral_exceeds_balance_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.withdraw_collateral(&borrower, &asset_a, &2_000_0000000);
}

/// Withdrawing zero amount is rejected.
#[test]
#[should_panic(expected = "Withdrawal amount must be positive")]
fn test_withdraw_collateral_zero_amount_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.withdraw_collateral(&borrower, &asset_a, &0);
}

/// Withdrawing an asset that was never deposited is rejected.
#[test]
#[should_panic(expected = "No collateral of the specified asset found")]
fn test_withdraw_collateral_nonexistent_asset_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.withdraw_collateral(&borrower, &asset_b, &500_0000000);
}

/// Deposit is blocked when contract is paused.
/// Uses try_ to catch the HostError (panic message is in diagnostic event).
#[test]
fn test_deposit_collateral_blocked_when_paused() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Need at least 2 signers for threshold 2
    let signer = Address::generate(&env);
    let admins = vec![&env, admin.clone(), signer.clone()];
    client.setup_multisig(&admin, &admins, &2);
    client.pause(&admin);
    client.pause(&signer);
    assert!(client.is_paused());

    let result = client.try_deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    assert!(
        result.is_err(),
        "deposit_collateral should have failed when paused"
    );
}

/// Get borrowing power with no active loans allows full withdrawal.
#[test]
fn test_withdraw_collateral_allowed_with_no_active_loans() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &3_000_0000000);

    // Should be able to withdraw all
    client.withdraw_collateral(&borrower, &asset_a, &5_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().asset, asset_b);
}

/// Get user collateral entries for a borrower with no collateral returns empty Vec.
#[test]
fn test_get_user_collateral_entries_empty_for_new_borrower() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 0);
}

/// Get total collateral value for a borrower with deposits.
#[test]
fn test_get_total_collateral_value() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &20_000_0000000);

    let total_value = client.get_total_collateral_value(&borrower);
    // Without oracle, each unit is valued at 1.0 base asset unit
    // Total = 10_000_0000000 + 20_000_0000000 = 30_000_0000000
    assert_eq!(total_value, 30_000_0000000);
}

/// Get total collateral value for a borrower with no deposits.
#[test]
fn test_get_total_collateral_value_empty() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let total_value = client.get_total_collateral_value(&borrower);
    assert_eq!(total_value, 0);
}

/// Borrowing power for a single asset with default (75%) collateral factor.
#[test]
fn test_get_borrowing_power_single_asset() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Set a specific collateral config: 80% LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 8000, // 80% LTV
            has_price_oracle: true,
            volatility_bps: 500, // 5% vol
        },
    );

    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);

    let borrowing_power = client.get_borrowing_power(&borrower);
    // 10_000_0000000 * 80% = 8_000_0000000
    assert_eq!(borrowing_power, 8_000_0000000);
}

/// Borrowing power for multiple assets with different collateral factors.
#[test]
fn test_get_borrowing_power_multiple_assets() {
    let (env, contract_id, admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Asset A: 75% LTV (default)
    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);

    // Asset B: 50% LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_b,
        &AssetCollateralConfig {
            collateral_factor_bps: 5000, // 50% LTV
            has_price_oracle: true,
            volatility_bps: 2000, // 20% vol
        },
    );
    client.deposit_collateral(&borrower, &asset_b, &10_000_0000000);

    let borrowing_power = client.get_borrowing_power(&borrower);
    // Asset A: 10_000_0000000 * 75% = 7_500_0000000
    // Asset B: 10_000_0000000 * 50% = 5_000_0000000
    // Total: 12_500_0000000
    assert_eq!(borrowing_power, 12_500_0000000);
}

/// Borrowing power with no deposited collateral.
#[test]
fn test_get_borrowing_power_no_collateral() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let borrowing_power = client.get_borrowing_power(&borrower);
    assert_eq!(borrowing_power, 0);
}

#[test]
#[should_panic(expected = "No oracle price registered for collateral asset")]
fn test_collateral_valuation_rejects_oracle_config_without_price() {
    let (env, contract_id, admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);
    let missing_asset_admin = Address::generate(&env);
    let missing_asset = env.register_stellar_asset_contract_v2(missing_asset_admin).address();
    client.whitelist_asset(&admin, &missing_asset);
    client.set_asset_collateral_config(
        &admin,
        &missing_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: 7500,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    token::StellarAssetClient::new(&env, &missing_asset).mint(&borrower, &10_000_0000000);
    client.deposit_collateral(&borrower, &missing_asset, &10_000_0000000);

    client.get_borrowing_power(&borrower);
}

#[test]
#[should_panic(expected = "Oracle price for collateral asset is stale")]
fn test_collateral_valuation_rejects_stale_oracle_price() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);
    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);
    let mut ledger = env.ledger().get();
    ledger.timestamp = ORACLE_PRICE_MAX_AGE_SECONDS + 1;
    env.ledger().set(ledger);

    client.get_borrowing_power(&borrower);
}

/// Setting asset collateral config validates the asset is whitelisted.
#[test]
#[should_panic(expected = "Asset is not whitelisted")]
fn test_set_asset_collateral_config_non_whitelisted_rejected() {
    let (env, contract_id, admin, _borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random_asset = Address::generate(&env);
    client.set_asset_collateral_config(
        &admin,
        &random_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: 8000,
            has_price_oracle: true,
            volatility_bps: 500,
        },
    );
}

/// Setting asset collateral config clamps the collateral factor to bounds.
#[test]
fn test_set_asset_collateral_config_clamps_to_bounds() {
    let (env, contract_id, admin, _borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Set factor above max (9600 > 9500)
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 9600, // Above MAX
            has_price_oracle: true,
            volatility_bps: 500,
        },
    );

    let config = client.get_asset_collateral_config(&asset_a);
    assert_eq!(config.collateral_factor_bps, 9500); // Clamped to MAX

    // Set factor below min (500 < 1000)
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 500, // Below MIN
            has_price_oracle: true,
            volatility_bps: 500,
        },
    );

    let config = client.get_asset_collateral_config(&asset_a);
    assert_eq!(config.collateral_factor_bps, 1000); // Clamped to MIN
}

/// Get asset collateral config returns default for unconfigured asset.
#[test]
fn test_get_asset_collateral_config_default() {
    let (env, contract_id, _admin, _borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let unconfigured_asset = Address::generate(&env);
    let config = client.get_asset_collateral_config(&unconfigured_asset);
    // Default: 75% LTV, no oracle, 0 volatility
    assert_eq!(config.collateral_factor_bps, 7500);
    assert!(!config.has_price_oracle);
    assert_eq!(config.volatility_bps, 0);
}

/// Price oracle can be set and retrieved (multisig-gated).
#[test]
fn test_set_price_oracle() {
    let (env, contract_id, admin, _borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let oracle = Address::generate(&env);
    client.set_price_oracle(&admin, &oracle);

    let retrieved = client.get_price_oracle();
    assert_eq!(retrieved, oracle);
}

/// Median aggregation ignores a manipulated outlier price sample.
#[test]
fn test_price_oracle_median_resists_manipulation() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 7500,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);

    client.set_asset_oracle_prices(
        &admin,
        &asset_a,
        &vec![&env, PRICE_PRECISION, PRICE_PRECISION, PRICE_PRECISION * 10],
    );

    let value = client.get_total_collateral_value(&borrower);
    assert_eq!(value, 1_000_0000000);
}

/// TWAP is used when live oracle samples are unavailable.
#[test]
fn test_price_oracle_twap_fallback_is_used() {
    let (env, contract_id, admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let asset_twap_admin = Address::generate(&env);
    let asset_twap = env.register_stellar_asset_contract_v2(asset_twap_admin).address();
    client.whitelist_asset(&admin, &asset_twap);
    client.set_asset_collateral_config(
        &admin,
        &asset_twap,
        &AssetCollateralConfig {
            collateral_factor_bps: 7500,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );

    token::StellarAssetClient::new(&env, &asset_twap).mint(&borrower, &1_000_000_000_000_000i128);
    client.deposit_collateral(&borrower, &asset_twap, &1_000_0000000);
    client.set_asset_twap_price(&admin, &asset_twap, &(PRICE_PRECISION * 2));

    let value = client.get_total_collateral_value(&borrower);
    assert_eq!(value, 2_000_0000000);
}

/// Collateral without an enabled oracle quote must never be assigned face value.
#[test]
#[should_panic(expected = "Collateral asset has no active price oracle")]
fn test_collateral_without_oracle_price_is_rejected() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig { collateral_factor_bps: 7500, has_price_oracle: false, volatility_bps: 0 },
    );
    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.get_total_collateral_value(&borrower);
}

/// A quote stops being usable after the configured freshness window.
#[test]
#[should_panic(expected = "Collateral oracle price is stale")]
fn test_stale_collateral_oracle_price_is_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);
    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    env.ledger().set_timestamp(MAX_COLLATERAL_PRICE_AGE_SECS + 1);
    client.get_total_collateral_value(&borrower);
}

/// Only multisig admin can set the price oracle.
#[test]
#[should_panic(expected = "Unauthorised")]
fn test_set_price_oracle_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    let oracle = Address::generate(&env);
    client.set_price_oracle(&random, &oracle);
}

/// Only multisig admin can configure asset collateral config.
#[test]
#[should_panic(expected = "Unauthorised")]
fn test_set_asset_collateral_config_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.set_asset_collateral_config(
        &random,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 8000,
            has_price_oracle: true,
            volatility_bps: 500,
        },
    );
}

/// Borrowing power check is enforced during create_loan_request.
#[test]
fn test_create_loan_request_checks_borrowing_power() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Configure with low LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 1000, // 10% LTV
            has_price_oracle: true,
            volatility_bps: 500,
        },
    );

    // Deposit collateral worth 10_000_0000000, borrowing power = 1_000_0000000
    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);

    // This should fail because we're trying to borrow more than borrowing power
    let result = client.try_create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 5_000_0000000, // > 1_000_0000000 borrowing power
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: asset_a.clone(),
                    amount: 10_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    assert!(
        result.is_err(),
        "create_loan_request should have failed due to borrowing power"
    );
}

/// Zero interest cannot be used to bypass the protocol's minimum APR.
#[test]
fn test_create_loan_request_rejects_interest_below_protocol_minimum() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);
    let result = client.try_create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 10_000_0000000,
            duration_days: 30,
            interest_rate_bps: 0,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry { asset: asset_a, amount: 10_000_0000000 },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    assert!(result.is_err());
}

/// Create loan request with multiple collateral assets.
#[test]
fn test_create_loan_request_with_multi_asset_collateral() {
    let (env, contract_id, admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Configure asset B with 50% LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_b,
        &AssetCollateralConfig {
            collateral_factor_bps: 5000, // 50% LTV
            has_price_oracle: true,
            volatility_bps: 1000,
        },
    );

    // deposit_collateral on user's vault
    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000); // 7.5K borrowing power
    client.deposit_collateral(&borrower, &asset_b, &10_000_0000000); // 5K borrowing power

    // Total borrowing power = 12_500_0000000
    // Requesting 10_000_0000000 should work
    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 10_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: asset_a.clone(),
                    amount: 10_000_0000000,
                },
                CollateralEntry {
                    asset: asset_b.clone(),
                    amount: 10_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );

    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.status, LoanStatus::Pending);
}

// ─── Borrower Loyalty Rewards integration tests ───────────────────────────

#[test]
fn test_set_loyalty_contract() {
    let (env, contract_id, admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loyalty = Address::generate(&env);
    client.set_loyalty_contract(&admin, &loyalty);
    let stored = client.get_loyalty_contract();
    assert_eq!(stored, Some(loyalty));
}

#[test]
fn test_set_loyalty_contract_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loyalty = Address::generate(&env);
    let stranger = Address::generate(&env);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_loyalty_contract(&stranger, &loyalty);
    }));
    assert!(result.is_err());
}

#[test]
fn test_repayment_without_loyalty_contract_works() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    let loan = client.get_loan(&loan_id);
    let status = client.record_payment(&admin, &loan_id, &loan.total_due);
    assert_eq!(status, LoanStatus::Repaid);
}

#[test]
fn test_repayment_calls_loyalty_contract() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let lender = Address::generate(&env);
    let collateral_asset = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    // Register and initialise loyalty contract
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let loyalty_id = env.register(borrower_loyalty::BorrowerLoyaltyContract, ());
    let loyalty_client = borrower_loyalty::BorrowerLoyaltyContractClient::new(&env, &loyalty_id);

    loyalty_client.initialize(
        &admin,
        &token_id,
        &contract_id,
        &borrower_loyalty::RewardConfig {
            base_amount: 1_000_0000,
            reference_loan_amount: 10_000_0000000,
            max_duration_multiplier_bps: 10_000,
            tier_none_multiplier_bps: 5_000,
            tier_beginner_multiplier_bps: 10_000,
            tier_silver_multiplier_bps: 15_000,
            tier_gold_multiplier_bps: 20_000,
            tier_platinum_multiplier_bps: 30_000,
        },
    );

    // Fund the loyalty contract with tokens
    let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_id);
    token_admin_client.mint(&loyalty_id, &1_000_000_0000000);

    // Link loyalty contract to lending contract
    client.set_loyalty_contract(&admin, &loyalty_id);

    // The borrower is Platinum on-chain, so the loan is snapshotted as tier 4
    link_reputation(&env, &client, &admin, &borrower);
    let loan_amount: i128 = 10_000_0000000;
    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: loan_amount,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 4,
        },
    );
    assert_eq!(client.get_loan_reputation_tier(&loan_id), 4);

    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    // Repay the loan in full on time
    let loan = client.get_loan(&loan_id);
    let status = client.record_payment(&admin, &loan_id, &loan.total_due);
    assert_eq!(status, LoanStatus::Repaid);

    // Check that rewards were distributed
    let borrower_rewards = loyalty_client.get_borrower_rewards(&borrower);
    assert!(
        borrower_rewards > 0,
        "Borrower should have received rewards"
    );

    let total = loyalty_client.get_total_rewards_distributed();
    assert_eq!(total, borrower_rewards);

    // Verify reward amount: Platinum tier, 10_000 XLM, 30 days
    // base=1 TLEND, size=1.0x, duration=1.0x (max=1.0x), tier=3.0x
    // expected = 1 * 1.0 * 1.0 * 3.0 = 3 TLEND
    assert_eq!(
        borrower_rewards, 3_000_0000,
        "Platinum borrower should get 3 TLEND"
    );
}

#[test]
fn test_late_repayment_no_reward() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let lender = Address::generate(&env);
    let collateral_asset = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    // Register and initialise loyalty contract
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let loyalty_id = env.register(borrower_loyalty::BorrowerLoyaltyContract, ());
    let loyalty_client = borrower_loyalty::BorrowerLoyaltyContractClient::new(&env, &loyalty_id);

    loyalty_client.initialize(
        &admin,
        &token_id,
        &contract_id,
        &borrower_loyalty::RewardConfig {
            base_amount: 1_000_0000,
            reference_loan_amount: 10_000_0000000,
            max_duration_multiplier_bps: 10_000,
            tier_none_multiplier_bps: 5_000,
            tier_beginner_multiplier_bps: 10_000,
            tier_silver_multiplier_bps: 15_000,
            tier_gold_multiplier_bps: 20_000,
            tier_platinum_multiplier_bps: 30_000,
        },
    );

    let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_id);
    token_admin_client.mint(&loyalty_id, &1_000_000_0000000);

    client.set_loyalty_contract(&admin, &loyalty_id);
    link_reputation(&env, &client, &admin, &borrower);

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 10_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 4,
        },
    );

    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    // Jump past due date (30 days = 30 * 86400 sec)
    let loan = client.get_loan(&loan_id);
    env.ledger().set_timestamp(loan.due_at + 1);

    // Repay late
    let loan = client.get_loan(&loan_id);
    let status = client.record_payment(&admin, &loan_id, &loan.total_due);
    assert_eq!(status, LoanStatus::Repaid);

    // No rewards should be recorded
    let borrower_rewards = loyalty_client.get_borrower_rewards(&borrower);
    assert_eq!(
        borrower_rewards, 0,
        "Late repayment should receive no rewards"
    );

    let total = loyalty_client.get_total_rewards_distributed();
    assert_eq!(total, 0);
}

// ─── Referral Rewards integration tests (Issue #266) ──────────────────────

/// Wire a funded referral contract to a fresh lending contract.
/// Returns (env, lending_id, admin, borrower, collateral_asset, referral_id, token_id).
fn setup_with_referral() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let collateral_asset = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let referral_id = env.register(referral_rewards::ReferralRewardsContract, ());
    let referral_client =
        referral_rewards::ReferralRewardsContractClient::new(&env, &referral_id);

    referral_client.initialize(
        &admin,
        &token_id,
        &contract_id,
        &referral_rewards::ReferralConfig {
            base_bonus: 10_0000000,               // 10 TLND
            reference_loan_amount: 1_000_0000000, // 1_000 XLM
            max_size_multiplier_bps: 20_000,
            min_qualifying_loan: 100_0000000,
            max_referrals_per_referrer: 0,
        },
    );

    soroban_sdk::token::StellarAssetClient::new(&env, &token_id)
        .mint(&referral_id, &1_000_0000000);

    client.set_referral_contract(&admin, &referral_id);
    link_reputation(&env, &client, &admin, &borrower);

    (
        env,
        contract_id,
        admin,
        borrower,
        collateral_asset,
        referral_id,
        token_id,
    )
}

#[test]
fn test_set_referral_contract() {
    let (env, contract_id, admin, _borrower, _collateral) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let referral = Address::generate(&env);
    client.set_referral_contract(&admin, &referral);
    assert_eq!(client.get_referral_contract(), Some(referral));
}

#[test]
fn test_set_referral_contract_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, _collateral) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let stranger = Address::generate(&env);
    let referral = Address::generate(&env);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.set_referral_contract(&stranger, &referral);
    }));
    assert!(result.is_err());
}

#[test]
fn test_activation_without_referral_contract_works() {
    // The default configuration has no referral contract set at all.
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    let lender = Address::generate(&env);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    assert_eq!(client.get_loan(&loan_id).status, LoanStatus::Active);
}

#[test]
fn test_activation_pays_referrer_automatically() {
    let (env, contract_id, admin, borrower, collateral_asset, referral_id, token_id) =
        setup_with_referral();
    let client = LendingContractClient::new(&env, &contract_id);
    let referral_client =
        referral_rewards::ReferralRewardsContractClient::new(&env, &referral_id);
    let lender = Address::generate(&env);
    let referrer = Address::generate(&env);

    // The friend signs up through the referrer's link.
    referral_client.register_referral(&borrower, &referrer);

    let loan_amount: i128 = 1_000_0000000;
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            loan_amount,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);

    let token_client = soroban_sdk::token::Client::new(&env, &token_id);
    assert_eq!(token_client.balance(&referrer), 0);

    // Taking out the loan is what triggers the bonus — no separate call.
    client.activate_loan(&admin, &loan_id);

    assert_eq!(token_client.balance(&referrer), 10_0000000);
    assert!(referral_client.is_bonus_paid(&borrower));
    assert_eq!(referral_client.get_referrer_earnings(&referrer), 10_0000000);
}

#[test]
fn test_activation_pays_nothing_for_unreferred_borrower() {
    let (env, contract_id, admin, borrower, collateral_asset, referral_id, _token_id) =
        setup_with_referral();
    let client = LendingContractClient::new(&env, &contract_id);
    let referral_client =
        referral_rewards::ReferralRewardsContractClient::new(&env, &referral_id);
    let lender = Address::generate(&env);

    // No register_referral call — this borrower arrived on their own.
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    assert_eq!(client.get_loan(&loan_id).status, LoanStatus::Active);
    assert_eq!(referral_client.get_total_bonuses_paid(), 0);
}

#[test]
fn test_second_loan_by_same_borrower_pays_no_second_bonus() {
    let (env, contract_id, admin, borrower, collateral_asset, referral_id, token_id) =
        setup_with_referral();
    let client = LendingContractClient::new(&env, &contract_id);
    let referral_client =
        referral_rewards::ReferralRewardsContractClient::new(&env, &referral_id);
    let lender = Address::generate(&env);
    let referrer = Address::generate(&env);
    let token_client = soroban_sdk::token::Client::new(&env, &token_id);

    referral_client.register_referral(&borrower, &referrer);

    for _ in 0..2 {
        let loan_id = client.create_loan_request(
            &borrower,
            &create_request_struct(
                &env,
                1_000_0000000,
                30,
                1500,
                100_000_0000000,
                &collateral_asset,
                100_000_0000000,
                InterestRateModel::Fixed,
            ),
        );
        client.approve_loan(&lender, &loan_id, &1);
        client.activate_loan(&admin, &loan_id);
    }

    // One referred friend = one bonus, however many loans they take.
    assert_eq!(token_client.balance(&referrer), 10_0000000);
    assert_eq!(referral_client.get_paid_referral_count(&referrer), 1);
}

#[test]
fn test_activation_succeeds_when_referral_pool_is_empty() {
    // A drained reward pool must never block a borrower's loan.
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let lender = Address::generate(&env);
    let referrer = Address::generate(&env);
    let collateral_asset = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let referral_id = env.register(referral_rewards::ReferralRewardsContract, ());
    let referral_client =
        referral_rewards::ReferralRewardsContractClient::new(&env, &referral_id);
    referral_client.initialize(
        &admin,
        &token_id,
        &contract_id,
        &referral_rewards::ReferralConfig {
            base_bonus: 10_0000000,
            reference_loan_amount: 1_000_0000000,
            max_size_multiplier_bps: 20_000,
            min_qualifying_loan: 100_0000000,
            max_referrals_per_referrer: 0,
        },
    );
    // Deliberately no mint — the pool is empty.
    client.set_referral_contract(&admin, &referral_id);
    referral_client.register_referral(&borrower, &referrer);
    link_reputation(&env, &client, &admin, &borrower);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    assert_eq!(client.get_loan(&loan_id).status, LoanStatus::Active);
    assert_eq!(referral_client.get_total_bonuses_paid(), 0);
    // Unpaid, so a later top-up still rewards the referrer.
    assert!(!referral_client.is_bonus_paid(&borrower));
}

#[test]
fn test_activation_survives_broken_referral_contract() {
    // Point the lending contract at an address that is not a contract at all.
    // try_invoke_contract must swallow the failure.
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    let lender = Address::generate(&env);

    client.set_referral_contract(&admin, &Address::generate(&env));

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    assert_eq!(client.get_loan(&loan_id).status, LoanStatus::Active);
}

// ─── Sweep Unsupported Tokens Tests ──────────────────────────────────────────

#[test]
fn test_sweep_unsupported_tokens_success() {
    let (env, contract_id, admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Create an unsupported token (not whitelisted)
    let token_admin = Address::generate(&env);
    let unsupported_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_client = token::Client::new(&env, &unsupported_token);
    let token_admin_client = token::StellarAssetClient::new(&env, &unsupported_token);

    // User accidentally sends 5,000 tokens to the contract
    let accidental_amount: i128 = 5_000_0000000;
    token_admin_client.mint(&contract_id, &accidental_amount);
    assert_eq!(token_client.balance(&contract_id), accidental_amount);

    let recovery_recipient = Address::generate(&env);
    let sweep_amount: i128 = 3_000_0000000;

    // Admin sweeps 3,000 tokens to recovery recipient
    client.sweep_tokens(&admin, &unsupported_token, &recovery_recipient, &sweep_amount);

    assert_eq!(token_client.balance(&recovery_recipient), sweep_amount);
    assert_eq!(
        token_client.balance(&contract_id),
        accidental_amount - sweep_amount
    );

    // Admin sweeps remaining 2,000 tokens
    client.sweep_tokens(
        &admin,
        &unsupported_token,
        &recovery_recipient,
        &(accidental_amount - sweep_amount),
    );
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(token_client.balance(&recovery_recipient), accidental_amount);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not admin")]
fn test_sweep_unsupported_tokens_non_admin_rejected() {
    let (env, contract_id, _admin, borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let unsupported_token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let recipient = Address::generate(&env);
    client.sweep_tokens(&borrower, &unsupported_token, &recipient, &1_000_0000000);
}

#[test]
#[should_panic(expected = "Cannot sweep supported whitelisted asset")]
fn test_sweep_whitelisted_asset_rejected() {
    let (env, contract_id, admin, _borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let recipient = Address::generate(&env);
    // Attempting to sweep a whitelisted asset must be rejected
    client.sweep_tokens(&admin, &collateral_asset, &recipient, &1_000_0000000);
}

#[test]
#[should_panic(expected = "Sweep amount must be positive")]
fn test_sweep_zero_or_negative_amount_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let unsupported_token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let recipient = Address::generate(&env);
    client.sweep_tokens(&admin, &unsupported_token, &recipient, &0);
}

#[test]
#[should_panic(expected = "Insufficient balance to sweep")]
fn test_sweep_amount_exceeding_balance_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let unsupported_token = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_admin_client = token::StellarAssetClient::new(&env, &unsupported_token);

    // Contract has only 100 tokens
    token_admin_client.mint(&contract_id, &100);

    let recipient = Address::generate(&env);
    // Attempting to sweep 200 tokens must fail
    client.sweep_tokens(&admin, &unsupported_token, &recipient, &200);
}

// ─── On-chain reputation enforcement (Issue #335) ─────────────────────────

/// A loan request whose client-side `max_loan_amount` and `reputation_tier`
/// are attacker-chosen.
fn spoofed_request(
    env: &Env,
    amount: i128,
    collateral_asset: &Address,
    claimed_max_loan: i128,
    claimed_tier: u32,
) -> LoanRequestInput {
    LoanRequestInput {
        amount,
        duration_days: 30,
        interest_rate_bps: 1000,
        max_loan_amount: claimed_max_loan,
        collateral_entries: vec![
            env,
            CollateralEntry {
                asset: collateral_asset.clone(),
                amount: 100_000_0000000,
            },
        ],
        rate_model: InterestRateModel::Fixed,
        reputation_tier: claimed_tier,
    }
}

#[test]
fn test_set_reputation_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert_eq!(client.get_reputation_contract(), None);
    let reputation = Address::generate(&env);
    client.set_reputation_contract(&admin, &reputation);
    assert_eq!(client.get_reputation_contract(), Some(reputation));
}

#[test]
fn test_set_reputation_contract_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let original = client.get_reputation_contract();
    let stranger = Address::generate(&env);
    let result = client.try_set_reputation_contract(&stranger, &Address::generate(&env));
    assert!(result.is_err());
    assert_eq!(client.get_reputation_contract(), original);
}

/// Without a reputation contract there is nothing to vouch for the borrower,
/// so the request must fail closed instead of trusting the client.
#[test]
#[should_panic(expected = "Reputation contract not configured")]
fn test_create_loan_rejected_without_reputation_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let collateral_asset = Address::generate(&env);
    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);
    client.whitelist_asset(&admin, &collateral_asset);

    client.create_loan_request(
        &borrower,
        &spoofed_request(&env, 1_000_0000000, &collateral_asset, 100_000_0000000, 4),
    );
}

/// A borrower with no on-chain reputation profile cannot borrow at all.
#[test]
fn test_create_loan_rejected_without_reputation_profile() {
    let (env, contract_id, _admin, _borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let unknown = Address::generate(&env);
    let result = client.try_create_loan_request(
        &unknown,
        &spoofed_request(&env, 100_0000000, &collateral_asset, 100_000_0000000, 4),
    );
    assert!(result.is_err());
    assert_eq!(client.get_loan_count(), 0);
}

/// A tier-None borrower (1 000 XLM limit) cannot borrow more by claiming a
/// higher `max_loan_amount` and Platinum tier in the request.
#[test]
#[should_panic(expected = "Amount exceeds reputation-based limit")]
fn test_spoofed_max_loan_amount_cannot_bypass_credit_limit() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 0);

    client.create_loan_request(
        &borrower,
        &spoofed_request(&env, 5_000_0000000, &collateral_asset, 100_000_0000000, 4),
    );
}

/// The limit is enforced at the exact on-chain boundary for each tier,
/// whatever the client claims.
#[test]
fn test_credit_limit_boundary_comes_from_reputation_contract() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Silver: 5 000 XLM on-chain limit.
    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 2);
    let limit: i128 = 5_000_0000000;

    let over = client.try_create_loan_request(
        &borrower,
        &spoofed_request(&env, limit + 1, &collateral_asset, I128_MAX, 4),
    );
    assert!(over.is_err());

    let loan_id = client.create_loan_request(
        &borrower,
        &spoofed_request(&env, limit, &collateral_asset, I128_MAX, 4),
    );
    assert_eq!(client.get_loan(&loan_id).amount, limit);
}

/// Understating the limit or tier client-side does not hurt an honest
/// borrower either — the client values are ignored in both directions.
#[test]
fn test_understated_client_values_are_ignored() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Gold: 10 000 XLM on-chain limit.
    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 3);

    let loan_id = client.create_loan_request(
        &borrower,
        &spoofed_request(&env, 10_000_0000000, &collateral_asset, 0, 0),
    );
    assert_eq!(client.get_loan(&loan_id).amount, 10_000_0000000);
    assert_eq!(client.get_loan_reputation_tier(&loan_id), 3);
}

/// The tier stored for the loan is the borrower's on-chain tier, not the one
/// claimed in the request.
#[test]
fn test_spoofed_reputation_tier_is_ignored() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 0);

    let loan_id = client.create_loan_request(
        &borrower,
        &spoofed_request(&env, 500_0000000, &collateral_asset, 500_0000000, 4),
    );
    assert_eq!(client.get_loan_reputation_tier(&loan_id), 0);
}

/// Tier snapshots follow the reputation contract: once the borrower is
/// genuinely upgraded on-chain, new loans pick up the new tier.
#[test]
fn test_loan_tier_tracks_on_chain_reputation() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    let reputation = borrower_reputation::BorrowerReputationContractClient::new(
        &env,
        &client.get_reputation_contract().unwrap(),
    );

    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 1);
    let first = client.create_loan_request(
        &borrower,
        &spoofed_request(&env, 500_0000000, &collateral_asset, 0, 4),
    );
    assert_eq!(client.get_loan_reputation_tier(&first), 1);

    reputation.apply_zk_tier_upgrade(&admin, &borrower, &3, &BytesN::from_array(&env, &[9; 32]));
    let second = client.create_loan_request(
        &borrower,
        &spoofed_request(&env, 500_0000000, &collateral_asset, 0, 0),
    );
    assert_eq!(client.get_loan_reputation_tier(&second), 3);
    // The earlier loan keeps the tier it was created with.
    assert_eq!(client.get_loan_reputation_tier(&first), 1);
}

/// The oracle-boosted limit from the reputation contract is honoured, so
/// the on-chain limit is more than a static tier table.
#[test]
fn test_oracle_boosted_credit_limit_is_honoured() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    let reputation = borrower_reputation::BorrowerReputationContractClient::new(
        &env,
        &client.get_reputation_contract().unwrap(),
    );

    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 0);

    // Above the 1 000 XLM tier-None limit before any oracle data.
    let amount: i128 = 1_500_0000000;
    let before = client.try_create_loan_request(
        &borrower,
        &spoofed_request(&env, amount, &collateral_asset, 0, 0),
    );
    assert!(before.is_err());

    // A perfect oracle score doubles the limit to 2 000 XLM.
    let oracle = Address::generate(&env);
    reputation.set_multisig_admin(&admin, &admin);
    reputation.set_oracle(&admin, &oracle);
    reputation.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &soroban_sdk::String::from_str(&env, "test"),
    );
    assert_eq!(reputation.calculate_max_loan(&borrower), 2_000_0000000);

    let loan_id = client.create_loan_request(
        &borrower,
        &spoofed_request(&env, amount, &collateral_asset, 0, 0),
    );
    assert_eq!(client.get_loan(&loan_id).amount, amount);
}

/// End-to-end: a tier-None borrower claiming Platinum must be paid the
/// tier-None loyalty reward on on-time repayment, not the Platinum bonus.
#[test]
fn test_spoofed_tier_cannot_inflate_loyalty_reward() {
    let (env, contract_id, admin, _platinum, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    let lender = Address::generate(&env);

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let loyalty_id = env.register(borrower_loyalty::BorrowerLoyaltyContract, ());
    let loyalty_client = borrower_loyalty::BorrowerLoyaltyContractClient::new(&env, &loyalty_id);
    loyalty_client.initialize(
        &admin,
        &token_id,
        &contract_id,
        &borrower_loyalty::RewardConfig {
            base_amount: 1_000_0000,
            reference_loan_amount: 1_000_0000000,
            max_duration_multiplier_bps: 10_000,
            tier_none_multiplier_bps: 5_000,
            tier_beginner_multiplier_bps: 10_000,
            tier_silver_multiplier_bps: 15_000,
            tier_gold_multiplier_bps: 20_000,
            tier_platinum_multiplier_bps: 30_000,
        },
    );
    soroban_sdk::token::StellarAssetClient::new(&env, &token_id)
        .mint(&loyalty_id, &1_000_000_0000000);
    client.set_loyalty_contract(&admin, &loyalty_id);

    let borrower = Address::generate(&env);
    give_reputation_profile(&env, &client, &admin, &borrower, 0);

    let amount: i128 = 1_000_0000000;
    let loan_id = client.create_loan_request(
        &borrower,
        &spoofed_request(&env, amount, &collateral_asset, 100_000_0000000, 4),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);
    let loan = client.get_loan(&loan_id);
    client.record_payment(&admin, &loan_id, &loan.total_due);

    let none_reward = loyalty_client.calculate_reward_view(&amount, &30, &0);
    let platinum_reward = loyalty_client.calculate_reward_view(&amount, &30, &4);
    assert!(none_reward < platinum_reward);
    assert_eq!(loyalty_client.get_borrower_rewards(&borrower), none_reward);
}

// ─── Protocol fee collection (Issue #338) ─────────────────────────────────

mod mock_treasury {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    /// Records the fees the lending contract reports on admin collection.
    #[contract]
    pub struct MockTreasury;

    #[contractimpl]
    impl TreasuryFeeReceiver for MockTreasury {
        fn record_protocol_fees(
            env: Env,
            lending_contract: Address,
            _asset_token: Address,
            amount: i128,
        ) {
            lending_contract.require_auth();
            let total: i128 = env
                .storage()
                .instance()
                .get(&symbol_short!("recorded"))
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&symbol_short!("recorded"), &(total + amount));
        }
    }

    #[contractimpl]
    impl MockTreasury {
        pub fn recorded(env: Env) -> i128 {
            env.storage()
                .instance()
                .get(&symbol_short!("recorded"))
                .unwrap_or(0)
        }
    }
}

/// Lending contract with a treasury and fee token configured and one loan
/// request whose platform fee is accrued. When `fund` is set, the contract
/// also holds the fee tokens backing that accrual.
/// Returns (env, lending_id, admin, fee_token, treasury_id, uncollected).
fn setup_fee_collection(fund: bool) -> (Env, Address, Address, Address, Address, i128) {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let fee_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let treasury_id = env.register(mock_treasury::MockTreasury, ());
    client.set_treasury(&admin, &treasury_id);
    client.set_fee_token(&admin, &fee_token);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1000,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    // Fees do not accrue upfront before repayment (#457)
    assert_eq!(client.get_uncollected_fees(), 0);
    let lender = Address::generate(&env);
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);
    let loan = client.get_loan(&loan_id);
    client.record_payment(&admin, &loan_id, &loan.total_due);

    let uncollected = client.get_uncollected_fees();
    assert!(uncollected > 0);
    if fund {
        mint_tokens(&env, &fee_token, &contract_id, uncollected);
    }

    (env, contract_id, admin, fee_token, treasury_id, uncollected)
}

#[test]
fn test_set_treasury_and_fee_token() {
    let (env, contract_id, admin, _borrower, _collateral) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    assert_eq!(client.get_treasury(), None);
    assert_eq!(client.get_fee_token(), None);

    let treasury = Address::generate(&env);
    let fee_token = Address::generate(&env);
    client.set_treasury(&admin, &treasury);
    client.set_fee_token(&admin, &fee_token);
    assert_eq!(client.get_treasury(), Some(treasury));
    assert_eq!(client.get_fee_token(), Some(fee_token));
}

#[test]
fn test_set_treasury_and_fee_token_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, _collateral) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    let stranger = Address::generate(&env);

    assert!(client
        .try_set_treasury(&stranger, &Address::generate(&env))
        .is_err());
    assert!(client
        .try_set_fee_token(&stranger, &Address::generate(&env))
        .is_err());
    assert_eq!(client.get_treasury(), None);
    assert_eq!(client.get_fee_token(), None);
}

/// Admin collection moves the fee tokens to the treasury, clears the
/// accrual and notifies the treasury of the amount.
#[test]
fn test_admin_collect_fees_transfers_tokens_to_treasury() {
    let (env, contract_id, admin, fee_token, treasury_id, uncollected) = setup_fee_collection(true);
    let client = LendingContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &fee_token);

    let collected = client.collect_fees(&admin, &treasury_id);

    assert_eq!(collected, uncollected);
    assert_eq!(client.get_uncollected_fees(), 0);
    assert_eq!(token_client.balance(&treasury_id), uncollected);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(
        mock_treasury::MockTreasuryClient::new(&env, &treasury_id).recorded(),
        uncollected
    );
}

/// When the treasury contract itself collects, the tokens still move but no
/// notification is sent back (the treasury does its own bookkeeping).
#[test]
fn test_treasury_collect_fees_transfers_without_notification() {
    let (env, contract_id, _admin, fee_token, treasury_id, uncollected) = setup_fee_collection(true);
    let client = LendingContractClient::new(&env, &contract_id);

    assert_eq!(client.collect_fees(&treasury_id, &treasury_id), uncollected);
    assert_eq!(token::Client::new(&env, &fee_token).balance(&treasury_id), uncollected);
    assert_eq!(
        mock_treasury::MockTreasuryClient::new(&env, &treasury_id).recorded(),
        0
    );
}

/// Anyone else cannot trigger collection, and nothing changes.
#[test]
fn test_collect_fees_by_unauthorised_caller_rejected() {
    let (env, contract_id, _admin, fee_token, treasury_id, uncollected) = setup_fee_collection(true);
    let client = LendingContractClient::new(&env, &contract_id);
    let stranger = Address::generate(&env);

    assert!(client.try_collect_fees(&stranger, &treasury_id).is_err());
    assert!(client.try_collect_fees(&stranger, &stranger).is_err());
    assert_eq!(client.get_uncollected_fees(), uncollected);
    assert_eq!(token::Client::new(&env, &fee_token).balance(&contract_id), uncollected);
}

/// Even the admin cannot send fees anywhere but the configured treasury.
#[test]
#[should_panic(expected = "Fees can only be collected to the configured treasury")]
fn test_collect_fees_to_other_destination_rejected() {
    let (env, contract_id, admin, _fee_token, _treasury_id, _uncollected) = setup_fee_collection(true);
    let client = LendingContractClient::new(&env, &contract_id);
    client.collect_fees(&admin, &Address::generate(&env));
}

#[test]
#[should_panic(expected = "Treasury not configured")]
fn test_collect_fees_without_treasury_rejected() {
    let (env, contract_id, admin, _borrower, _collateral) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    client.collect_fees(&admin, &Address::generate(&env));
}

/// Accounting cannot be cleared without the tokens to back it.
#[test]
fn test_collect_fees_without_fee_tokens_rejected() {
    // The accrual is recorded but no fee tokens back it.
    let (env, contract_id, admin, fee_token, treasury_id, uncollected) = setup_fee_collection(false);
    let client = LendingContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &fee_token);

    assert!(client.try_collect_fees(&admin, &treasury_id).is_err());
    assert_eq!(client.get_uncollected_fees(), uncollected);
    assert_eq!(token_client.balance(&treasury_id), 0);
}

#[test]
fn test_collect_fees_with_nothing_accrued_returns_zero() {
    let (env, contract_id, admin, _borrower, _collateral) = setup();
    let client = LendingContractClient::new(&env, &contract_id);
    let treasury_id = env.register(mock_treasury::MockTreasury, ());
    client.set_treasury(&admin, &treasury_id);

    assert_eq!(client.collect_fees(&admin, &treasury_id), 0);
}

/// `sweep_tokens` cannot take fee tokens reserved for the treasury.
#[test]
fn test_sweep_cannot_take_uncollected_fees() {
    let (env, contract_id, admin, fee_token, _treasury_id, uncollected) = setup_fee_collection(true);
    let client = LendingContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    mint_tokens(&env, &fee_token, &contract_id, 100);
    assert!(client
        .try_sweep_tokens(&admin, &fee_token, &recipient, &101)
        .is_err());

    client.sweep_tokens(&admin, &fee_token, &recipient, &100);
    assert_eq!(token::Client::new(&env, &fee_token).balance(&contract_id), uncollected);
}

#[test]
fn test_collect_fees_cannot_drain_depositor_collateral() {
    let (env, contract_id, admin, borrower, _dummy_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Deploy a real SEP-41 asset contract that acts as both whitelisted collateral and fee token
    let collateral_asset = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    let treasury_id = env.register(mock_treasury::MockTreasury, ());
    client.set_treasury(&admin, &treasury_id);
    client.set_fee_token(&admin, &collateral_asset);

    // Borrower deposits 50,000 tokens of collateral
    let collateral_deposit = 50_000_0000000i128;
    mint_tokens(&env, &collateral_asset, &borrower, collateral_deposit);
    client.deposit_collateral(&borrower, &collateral_asset, &collateral_deposit);
    assert_eq!(
        client.get_total_collateral_for_asset(&collateral_asset),
        collateral_deposit
    );

    // Create, approve, activate, and repay a loan so platform fees accrue
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1000,
            100_000_0000000,
            &collateral_asset,
            collateral_deposit,
            InterestRateModel::Fixed,
        ),
    );
    assert_eq!(client.get_uncollected_fees(), 0);

    let lender = Address::generate(&env);
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);
    let loan = client.get_loan(&loan_id);
    client.record_payment(&admin, &loan_id, &loan.total_due);

    let uncollected = client.get_uncollected_fees();
    assert!(uncollected > 0);

    // Contract holds only the borrower's collateral (no unencumbered fee tokens)
    let token_client = token::Client::new(&env, &collateral_asset);
    assert_eq!(token_client.balance(&contract_id), collateral_deposit);

    // Fee collection must fail because all held tokens are encumbered collateral
    assert!(client.try_collect_fees(&admin, &treasury_id).is_err());
    assert_eq!(client.get_uncollected_fees(), uncollected);
    assert_eq!(token_client.balance(&contract_id), collateral_deposit);
    assert_eq!(token_client.balance(&treasury_id), 0);

    // Borrower can still withdraw their full collateral position without panic
    client.withdraw_collateral(&borrower, &collateral_asset, &collateral_deposit);
    assert_eq!(client.get_total_collateral_for_asset(&collateral_asset), 0);
    assert_eq!(token_client.balance(&borrower), collateral_deposit);
}

#[test]
fn test_collect_fees_succeeds_when_unencumbered_fee_tokens_cover_accrual() {
    let (env, contract_id, admin, borrower, _dummy_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let collateral_asset = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    client.whitelist_asset(&admin, &collateral_asset);
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: DEFAULT_COLLATERAL_FACTOR_BPS,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    client.set_asset_oracle_prices(&admin, &collateral_asset, &vec![&env, PRICE_PRECISION]);

    let treasury_id = env.register(mock_treasury::MockTreasury, ());
    client.set_treasury(&admin, &treasury_id);
    client.set_fee_token(&admin, &collateral_asset);

    let collateral_deposit = 50_000_0000000i128;
    mint_tokens(&env, &collateral_asset, &borrower, collateral_deposit);
    client.deposit_collateral(&borrower, &collateral_asset, &collateral_deposit);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1000,
            100_000_0000000,
            &collateral_asset,
            collateral_deposit,
            InterestRateModel::Fixed,
        ),
    );
    let lender = Address::generate(&env);
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);
    let loan = client.get_loan(&loan_id);
    client.record_payment(&admin, &loan_id, &loan.total_due);

    let uncollected = client.get_uncollected_fees();
    assert!(uncollected > 0);

    // Fund the contract with the unencumbered fee tokens backing the accrual
    mint_tokens(&env, &collateral_asset, &contract_id, uncollected);

    let collected = client.collect_fees(&admin, &treasury_id);
    assert_eq!(collected, uncollected);
    assert_eq!(client.get_uncollected_fees(), 0);

    // Depositor collateral remains 100% intact and withdrawable
    let token_client = token::Client::new(&env, &collateral_asset);
    assert_eq!(token_client.balance(&contract_id), collateral_deposit);
    client.withdraw_collateral(&borrower, &collateral_asset, &collateral_deposit);
    assert_eq!(token_client.balance(&borrower), collateral_deposit);
}
