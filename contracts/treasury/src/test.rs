#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, vec, Address, Env};

use lending::{
    AssetCollateralConfig, CollateralEntry, InterestRateModel, LendingContract, LendingContractClient, LoanRequestInput,
};

fn setup_test() -> (
    Env,
    Address,
    Address,
    Address,
    Address,
    TreasuryContractClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let insurance_fund = Address::generate(&env);
    let dao_treasury = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let asset_token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let treasury_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &treasury_id);

    client.initialize(
        &admin,
        &insurance_fund,
        &dao_treasury,
        &DEFAULT_INSURANCE_SHARE_BPS,
        &DEFAULT_DAO_SHARE_BPS,
    );

    (
        env,
        admin,
        insurance_fund,
        dao_treasury,
        asset_token_id,
        client,
    )
}

fn mint_tokens(env: &Env, asset_token: &Address, recipient: &Address, amount: i128) {
    let token_admin_client = token::StellarAssetClient::new(env, asset_token);
    token_admin_client.mint(recipient, &amount);
}

#[test]
fn test_initialize_treasury() {
    let (_env, admin, insurance_fund, dao_treasury, asset_token, client) = setup_test();

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_insurance_fund(), insurance_fund);
    assert_eq!(client.get_dao_treasury(), dao_treasury);

    let rules = client.get_distribution_rules();
    assert_eq!(rules.insurance_share_bps, 5000);
    assert_eq!(rules.dao_share_bps, 5000);

    assert_eq!(client.get_total_collected_fees(), 0);
    assert_eq!(client.get_treasury_balance(&asset_token), 0);
}

#[test]
fn test_set_distribution_rules() {
    let (_env, admin, _insurance_fund, _dao_treasury, _asset_token, client) = setup_test();

    client.set_distribution_rules(&admin, &7000, &3000);
    let rules = client.get_distribution_rules();
    assert_eq!(rules.insurance_share_bps, 7000);
    assert_eq!(rules.dao_share_bps, 3000);
}

#[test]
#[should_panic(expected = "Distribution share BPS must equal 10,000 (100%)")]
fn test_set_distribution_rules_invalid_bps_panics() {
    let (_env, admin, _insurance_fund, _dao_treasury, _asset_token, client) = setup_test();
    client.set_distribution_rules(&admin, &6000, &3000);
}

#[test]
fn test_deposit_fees_and_query_balance() {
    let (env, admin, _insurance_fund, _dao_treasury, asset_token, client) = setup_test();

    let fee_amount = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &admin, fee_amount);

    client.deposit_fees(&admin, &asset_token, &fee_amount);

    assert_eq!(client.get_treasury_balance(&asset_token), fee_amount);
    assert_eq!(client.get_total_collected_fees(), fee_amount);
}

#[test]
fn test_distribute_fees_50_50_split() {
    let (env, admin, insurance_fund, dao_treasury, asset_token, client) = setup_test();

    let total_fees = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &admin, total_fees);
    client.deposit_fees(&admin, &asset_token, &total_fees);

    let (ins_payout, dao_payout) = client.distribute(&admin, &asset_token);

    assert_eq!(ins_payout, 500_0000000i128);
    assert_eq!(dao_payout, 500_0000000i128);

    assert_eq!(
        token::Client::new(&env, &asset_token).balance(&insurance_fund),
        500_0000000i128
    );
    assert_eq!(
        token::Client::new(&env, &asset_token).balance(&dao_treasury),
        500_0000000i128
    );
    assert_eq!(client.get_treasury_balance(&asset_token), 0);

    assert_eq!(client.get_total_distributed_insurance(), 500_0000000i128);
    assert_eq!(client.get_total_distributed_dao(), 500_0000000i128);

    let count = client.get_distribution_count();
    assert_eq!(count, 1);

    let record = client.get_distribution(&1);
    assert_eq!(record.id, 1);
    assert_eq!(record.insurance_amount, 500_0000000i128);
    assert_eq!(record.dao_amount, 500_0000000i128);

    let history = client.get_distribution_history();
    assert_eq!(history.len(), 1);
}

#[test]
#[should_panic(expected = "No balance available to distribute")]
fn test_distribute_empty_balance_panics() {
    let (_env, admin, _insurance_fund, _dao_treasury, asset_token, client) = setup_test();
    client.distribute(&admin, &asset_token);
}

// ─── Protocol fee collection from lending (Issue #338) ────────────────────────

/// A lending contract wired to `treasury` with one loan request whose
/// platform fee has accrued in `fee_token`. When `fund` is set, the lending
/// contract also holds the fee tokens backing that accrual.
/// Returns (lending_id, uncollected).
fn setup_lending_with_fees(
    env: &Env,
    admin: &Address,
    treasury: &TreasuryContractClient,
    fee_token: &Address,
    fund: bool,
) -> (Address, i128) {
    let lending_id = env.register(LendingContract, ());
    let lending = LendingContractClient::new(env, &lending_id);
    lending.initialize(admin);
    lending.set_multisig_admin(admin, admin);

    let borrower = Address::generate(env);
    let collateral_asset = Address::generate(env);
    lending.whitelist_asset(admin, &collateral_asset);
    lending.set_asset_collateral_config(
        admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: 7500,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );
    lending.set_asset_oracle_prices(admin, &collateral_asset, &vec![env, 10_000_000]);

    // Lending reads the borrower's credit limit from the reputation contract.
    let reputation_id = env.register(borrower_reputation::BorrowerReputationContract, ());
    let reputation =
        borrower_reputation::BorrowerReputationContractClient::new(env, &reputation_id);
    reputation.initialize(admin);
    reputation.init_borrower(&borrower);
    lending.set_reputation_contract(admin, &reputation_id);

    // Link lending ↔ treasury and the fee token.
    lending.set_treasury(admin, &treasury.address);
    lending.set_fee_token(admin, fee_token);
    treasury.set_lending_contract(admin, &lending_id);

    // Create, activate, and repay loan so platform fee is settled
    let loan_id = lending.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
            reputation_tier: 0,
        },
    );
    let lender = Address::generate(env);
    lending.approve_loan(&lender, &loan_id, &1);
    lending.activate_loan(admin, &loan_id);
    let loan = lending.get_loan(&loan_id);
    lending.record_payment(admin, &loan_id, &loan.total_due);

    let uncollected = lending.get_uncollected_fees();
    assert!(uncollected > 0);
    if fund {
        mint_tokens(env, fee_token, &lending_id, uncollected);
    }
    (lending_id, uncollected)
}

/// End to end: fees move from lending to the treasury, the treasury's
/// tracked balance is credited, and they can then be distributed.
#[test]
fn test_collect_protocol_fees_from_lending() {
    let (env, admin, insurance_fund, dao_treasury, fee_token, client) = setup_test();
    let (lending_id, uncollected) =
        setup_lending_with_fees(&env, &admin, &client, &fee_token, true);
    let lending = LendingContractClient::new(&env, &lending_id);
    let token_client = token::Client::new(&env, &fee_token);

    let collected = client.collect_protocol_fees(&admin, &lending_id);

    assert_eq!(collected, uncollected);
    assert_eq!(lending.get_uncollected_fees(), 0);
    assert_eq!(token_client.balance(&lending_id), 0);
    assert_eq!(token_client.balance(&client.address), uncollected);
    assert_eq!(client.get_treasury_balance(&fee_token), uncollected);
    assert_eq!(client.get_total_collected_fees(), uncollected);

    // The collected fees are real tokens the treasury can distribute.
    let (insurance_amount, dao_amount) = client.distribute(&admin, &fee_token);
    assert_eq!(insurance_amount + dao_amount, uncollected);
    assert_eq!(token_client.balance(&insurance_fund), insurance_amount);
    assert_eq!(token_client.balance(&dao_treasury), dao_amount);
    assert_eq!(token_client.balance(&client.address), 0);
}

/// An admin collecting on the lending contract directly also keeps the
/// treasury's tracked balance in sync.
#[test]
fn test_direct_lending_collection_updates_treasury_balance() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    let (lending_id, uncollected) =
        setup_lending_with_fees(&env, &admin, &client, &fee_token, true);
    let lending = LendingContractClient::new(&env, &lending_id);

    assert_eq!(lending.collect_fees(&admin, &client.address), uncollected);

    assert_eq!(token::Client::new(&env, &fee_token).balance(&client.address), uncollected);
    assert_eq!(client.get_treasury_balance(&fee_token), uncollected);
    assert_eq!(client.get_total_collected_fees(), uncollected);
    let (insurance_amount, dao_amount) = client.distribute(&admin, &fee_token);
    assert_eq!(insurance_amount + dao_amount, uncollected);
}

#[test]
fn test_collect_protocol_fees_non_admin_rejected() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    let (lending_id, uncollected) =
        setup_lending_with_fees(&env, &admin, &client, &fee_token, true);
    let stranger = Address::generate(&env);

    assert!(client.try_collect_protocol_fees(&stranger, &lending_id).is_err());
    assert_eq!(
        LendingContractClient::new(&env, &lending_id).get_uncollected_fees(),
        uncollected
    );
    assert_eq!(client.get_treasury_balance(&fee_token), 0);
}

/// Strangers cannot drive the lending contract's collection either.
#[test]
fn test_lending_collect_fees_by_stranger_rejected() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    let (lending_id, uncollected) =
        setup_lending_with_fees(&env, &admin, &client, &fee_token, true);
    let lending = LendingContractClient::new(&env, &lending_id);

    let stranger = Address::generate(&env);
    assert!(lending.try_collect_fees(&stranger, &client.address).is_err());
    assert_eq!(lending.get_uncollected_fees(), uncollected);
    assert_eq!(token::Client::new(&env, &fee_token).balance(&client.address), 0);
}

#[test]
#[should_panic(expected = "Unauthorised: not the registered lending contract")]
fn test_collect_from_unregistered_lending_rejected() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    setup_lending_with_fees(&env, &admin, &client, &fee_token, true);
    client.collect_protocol_fees(&admin, &Address::generate(&env));
}

/// Fee accounting cannot be collected without the tokens to back it.
#[test]
fn test_collect_without_fee_tokens_rejected() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    let (lending_id, uncollected) =
        setup_lending_with_fees(&env, &admin, &client, &fee_token, false);

    assert!(client.try_collect_protocol_fees(&admin, &lending_id).is_err());
    assert_eq!(
        LendingContractClient::new(&env, &lending_id).get_uncollected_fees(),
        uncollected
    );
    assert_eq!(client.get_treasury_balance(&fee_token), 0);
    assert_eq!(client.get_total_collected_fees(), 0);
}

mod fake_lending {
    use super::*;
    use soroban_sdk::{contract, contractimpl, symbol_short};

    /// Reports fees as collected without transferring anything.
    #[contract]
    pub struct FakeLending;

    #[contractimpl]
    impl FakeLending {
        pub fn init(env: Env, fee_token: Address) {
            env.storage().instance().set(&symbol_short!("token"), &fee_token);
        }

        pub fn get_fee_token(env: Env) -> Option<Address> {
            env.storage().instance().get(&symbol_short!("token"))
        }

        pub fn collect_fees(_env: Env, _caller: Address, _treasury_address: Address) -> i128 {
            1_000_0000000
        }
    }
}

/// A lending contract that reports fees it never sent is rejected, so the
/// treasury cannot record unbacked balances.
#[test]
#[should_panic(expected = "Collected fees do not match tokens received")]
fn test_reported_fees_must_match_tokens_received() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    let fake_id = env.register(fake_lending::FakeLending, ());
    fake_lending::FakeLendingClient::new(&env, &fake_id).init(&fee_token);
    client.set_lending_contract(&admin, &fake_id);

    client.collect_protocol_fees(&admin, &fake_id);
}

#[test]
#[should_panic(expected = "Unauthorised: not the registered lending contract")]
fn test_record_protocol_fees_only_from_registered_lending() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    client.set_lending_contract(&admin, &Address::generate(&env));

    let stranger = Address::generate(&env);
    mint_tokens(&env, &fee_token, &client.address, 1_000);
    client.record_protocol_fees(&stranger, &fee_token, &1_000);
}

/// Even the registered lending contract can only record tokens the treasury
/// actually received.
#[test]
#[should_panic(expected = "Fee tokens not received")]
fn test_record_protocol_fees_requires_tokens_received() {
    let (env, admin, _insurance_fund, _dao_treasury, fee_token, client) = setup_test();
    let lending = Address::generate(&env);
    client.set_lending_contract(&admin, &lending);

    client.record_protocol_fees(&lending, &fee_token, &1_000);
}

#[test]
fn test_set_lending_contract_admin_only() {
    let (env, admin, _insurance_fund, _dao_treasury, _fee_token, client) = setup_test();
    let lending = Address::generate(&env);

    assert_eq!(client.get_lending_contract(), None);
    assert!(client
        .try_set_lending_contract(&Address::generate(&env), &lending)
        .is_err());
    client.set_lending_contract(&admin, &lending);
    assert_eq!(client.get_lending_contract(), Some(lending));
}
