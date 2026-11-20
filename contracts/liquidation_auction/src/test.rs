#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

const START_TIMESTAMP: u64 = 1_000;

// Standard auction parameters used across the suite.
const COLLATERAL: i128 = 10_000_000;
const DEBT: i128 = 1_000_000;
const START_PRICE: i128 = 1_000_000;
const FLOOR_PRICE: i128 = 250_000;
const DECAY_PER_SECOND: i128 = 50_000;
const DURATION: u64 = 30;

/// Collateral held by the admin (seized from defaulted loans) and payment
/// tokens held by the bidder at the start of every test.
const ADMIN_COLLATERAL: i128 = 100_000_000;
const BIDDER_FUNDS: i128 = 10_000_000;

struct Fixture {
    env: Env,
    contract_id: Address,
    admin: Address,
    borrower: Address,
    bidder: Address,
    assets: AuctionAssets,
}

impl Fixture {
    fn client(&self) -> LiquidationAuctionContractClient<'_> {
        LiquidationAuctionContractClient::new(&self.env, &self.contract_id)
    }

    fn collateral(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.assets.collateral_token)
    }

    fn payment(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.assets.payment_token)
    }

    /// Start the standard auction for `loan_id`.
    fn start(&self, loan_id: u32) -> LiquidationAuction {
        self.start_with(loan_id, COLLATERAL, DEBT)
    }

    fn start_with(&self, loan_id: u32, collateral: i128, debt: i128) -> LiquidationAuction {
        self.client().start_auction(
            &self.admin,
            &loan_id,
            &self.borrower,
            &self.assets,
            &collateral,
            &debt,
            &START_PRICE,
            &FLOOR_PRICE,
            &DECAY_PER_SECOND,
            &DURATION,
        )
    }
}

/// Real Stellar Asset Contracts for collateral and payment, so settlement
/// moves actual tokens (Issue #418).
fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIMESTAMP);

    let contract_id = env.register(LiquidationAuctionContract, ());
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let bidder = Address::generate(&env);
    let pool = Address::generate(&env);

    client.initialize(&admin);

    let collateral_token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let payment_token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    token::StellarAssetClient::new(&env, &collateral_token).mint(&admin, &ADMIN_COLLATERAL);
    token::StellarAssetClient::new(&env, &payment_token).mint(&bidder, &BIDDER_FUNDS);

    Fixture {
        env,
        contract_id,
        admin,
        borrower,
        bidder,
        assets: AuctionAssets {
            collateral_token,
            payment_token,
            proceeds_recipient: pool,
        },
    }
}

// ─── Pricing and accounting ───────────────────────────────────────────────────

#[test]
fn test_price_decays_to_floor() {
    let f = setup();
    let client = f.client();
    f.start(7);

    assert_eq!(client.current_price(&7), 1_000_000);
    f.env.ledger().set_timestamp(START_TIMESTAMP + 10);
    assert_eq!(client.current_price(&7), 500_000);
    f.env.ledger().set_timestamp(START_TIMESTAMP + 40);
    assert_eq!(client.current_price(&7), 250_000);
}

#[test]
fn test_bid_settles_auction() {
    let f = setup();
    let client = f.client();
    f.start(11);

    f.env.ledger().set_timestamp(START_TIMESTAMP + 10);
    let settlement = client.place_bid(&f.bidder, &11, &1_000_000);

    assert_eq!(settlement.status, AuctionStatus::Sold);
    assert_eq!(settlement.recovered_amount, 1_000_000);
    assert_eq!(settlement.bad_debt, 0);

    let auction = client.get_auction(&11);
    assert_eq!(auction.status, AuctionStatus::Sold);
}

#[test]
#[should_panic(expected = "Bid below current auction price")]
fn test_bid_below_current_price_is_rejected() {
    let f = setup();
    f.start(13);

    f.env.ledger().set_timestamp(START_TIMESTAMP + 10);
    f.client().place_bid(&f.bidder, &13, &400_000);
}

#[test]
fn test_expired_auction_creates_bad_debt() {
    let f = setup();
    f.start(19);

    f.env.ledger().set_timestamp(START_TIMESTAMP + 31);
    let settlement = f.client().finalize_expired(&19);

    assert_eq!(settlement.status, AuctionStatus::ExpiredUnsold);
    assert_eq!(settlement.recovered_amount, 0);
    assert_eq!(settlement.bad_debt, 1_000_000);
}

#[test]
fn test_bid_below_debt_records_insurance_claim() {
    let f = setup();
    f.start(12);

    // Once the Dutch price reaches the floor, the collateral may sell for less
    // than the outstanding debt. The settlement is the amount the insurance
    // fund must cover for this loan.
    f.env.ledger().set_timestamp(START_TIMESTAMP + 20);
    let settlement = f.client().place_bid(&f.bidder, &12, &250_000);

    assert_eq!(settlement.status, AuctionStatus::Sold);
    assert_eq!(settlement.recovered_amount, 250_000);
    assert_eq!(settlement.bad_debt, 750_000);
}

/// Paying more than the debt never records negative bad debt.
#[test]
fn test_bid_above_debt_records_no_bad_debt() {
    let f = setup();
    f.start(14);

    let settlement = f.client().place_bid(&f.bidder, &14, &1_500_000);

    assert_eq!(settlement.recovered_amount, 1_500_000);
    assert_eq!(settlement.bad_debt, 0);
    assert_eq!(f.client().get_auction(&14).bad_debt, 0);
}

// ─── Token settlement (Issue #418) ────────────────────────────────────────────

/// Starting an auction moves the collateral into the auction's custody.
#[test]
fn test_start_auction_takes_collateral_custody() {
    let f = setup();

    let auction = f.start(21);

    assert_eq!(f.collateral().balance(&f.contract_id), COLLATERAL);
    assert_eq!(f.collateral().balance(&f.admin), ADMIN_COLLATERAL - COLLATERAL);
    assert_eq!(auction.collateral_token, f.assets.collateral_token);
    assert_eq!(auction.payment_token, f.assets.payment_token);
    assert_eq!(auction.proceeds_recipient, f.assets.proceeds_recipient);
}

/// An auction cannot be started for collateral the caller does not hold.
#[test]
fn test_start_auction_without_collateral_fails() {
    let f = setup();
    let client = f.client();

    let result = client.try_start_auction(
        &f.admin,
        &22,
        &f.borrower,
        &f.assets,
        &(ADMIN_COLLATERAL + 1),
        &DEBT,
        &START_PRICE,
        &FLOOR_PRICE,
        &DECAY_PER_SECOND,
        &DURATION,
    );

    assert!(result.is_err());
    assert!(client.try_get_auction(&22).is_err());
    assert_eq!(f.collateral().balance(&f.contract_id), 0);
}

/// The winning bid pays the proceeds recipient and delivers the collateral.
#[test]
fn test_winning_bid_pays_recipient_and_delivers_collateral() {
    let f = setup();
    f.start(23);

    f.env.ledger().set_timestamp(START_TIMESTAMP + 10);
    f.client().place_bid(&f.bidder, &23, &500_000);

    // Payment: bidder → pool.
    assert_eq!(f.payment().balance(&f.bidder), BIDDER_FUNDS - 500_000);
    assert_eq!(f.payment().balance(&f.assets.proceeds_recipient), 500_000);
    assert_eq!(f.payment().balance(&f.contract_id), 0);
    // Delivery: custody → bidder.
    assert_eq!(f.collateral().balance(&f.bidder), COLLATERAL);
    assert_eq!(f.collateral().balance(&f.contract_id), 0);
}

/// A bidder with no payment tokens cannot win: the bid reverts and the
/// auction stays open with the collateral still in custody.
#[test]
fn test_bidder_without_funds_cannot_win() {
    let f = setup();
    let client = f.client();
    f.start(24);
    let broke_bidder = Address::generate(&f.env);

    let result = client.try_place_bid(&broke_bidder, &24, &1_000_000);

    assert!(result.is_err());
    let auction = client.get_auction(&24);
    assert_eq!(auction.status, AuctionStatus::Active);
    assert_eq!(auction.recovered_amount, 0);
    assert_eq!(f.collateral().balance(&f.contract_id), COLLATERAL);
    assert_eq!(f.collateral().balance(&broke_bidder), 0);
    assert_eq!(f.payment().balance(&f.assets.proceeds_recipient), 0);
}

/// A bidder whose balance is below their bid cannot win either.
#[test]
fn test_bidder_with_insufficient_balance_cannot_win() {
    let f = setup();
    let client = f.client();
    f.start(25);
    let small_bidder = Address::generate(&f.env);
    token::StellarAssetClient::new(&f.env, &f.assets.payment_token).mint(&small_bidder, &999_999);

    let result = client.try_place_bid(&small_bidder, &25, &1_000_000);

    assert!(result.is_err());
    assert_eq!(client.get_auction(&25).status, AuctionStatus::Active);
    assert_eq!(f.payment().balance(&small_bidder), 999_999);
    assert_eq!(f.collateral().balance(&f.contract_id), COLLATERAL);

    // A funded bidder can still buy the collateral afterwards.
    client.place_bid(&f.bidder, &25, &1_000_000);
    assert_eq!(f.collateral().balance(&f.bidder), COLLATERAL);
}

/// A sold auction cannot be bought (or paid out) a second time.
#[test]
#[should_panic(expected = "Auction already settled")]
fn test_sold_auction_cannot_be_bid_again() {
    let f = setup();
    let client = f.client();
    f.start(26);

    client.place_bid(&f.bidder, &26, &1_000_000);
    client.place_bid(&f.bidder, &26, &1_000_000);
}

/// An expired, unsold auction releases its collateral to the proceeds
/// recipient instead of leaving it locked in the contract.
#[test]
fn test_expired_auction_releases_collateral_to_recipient() {
    let f = setup();
    f.start(27);

    f.env.ledger().set_timestamp(START_TIMESTAMP + DURATION);
    f.client().finalize_expired(&27);

    assert_eq!(f.collateral().balance(&f.contract_id), 0);
    assert_eq!(f.collateral().balance(&f.assets.proceeds_recipient), COLLATERAL);
}

/// Custody always equals the collateral of auctions still open.
#[test]
fn test_custody_matches_open_auctions() {
    let f = setup();
    let client = f.client();

    f.start_with(31, 1_000_000, DEBT);
    f.start_with(32, 2_000_000, DEBT);
    f.start_with(33, 4_000_000, DEBT);
    assert_eq!(f.collateral().balance(&f.contract_id), 7_000_000);

    client.place_bid(&f.bidder, &31, &1_000_000);
    assert_eq!(f.collateral().balance(&f.contract_id), 6_000_000);

    f.env.ledger().set_timestamp(START_TIMESTAMP + DURATION);
    client.finalize_expired(&32);
    assert_eq!(f.collateral().balance(&f.contract_id), 4_000_000);
    assert_eq!(client.get_auction(&33).status, AuctionStatus::Active);
}
