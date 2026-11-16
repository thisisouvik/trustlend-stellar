#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

const START_TIMESTAMP: u64 = 1_000;

struct Ctx {
    env: Env,
    contract_id: Address,
    admin: Address,
    borrower: Address,
    bidder: Address,
    treasury: Address,
    payment_token: Address,
    collateral_token: Address,
}

fn setup() -> (Env, Address, Address, Address, Address) {
    let c = setup_ctx();
    (c.env, c.contract_id, c.admin, c.borrower, c.bidder)
}

fn setup_ctx() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIMESTAMP);

    let contract_id = env.register(LiquidationAuctionContract, ());
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let bidder = Address::generate(&env);
    let treasury = Address::generate(&env);
    let payment_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let collateral_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    client.initialize(&admin, &payment_token, &collateral_token, &treasury);

    // The auction contract holds the seized collateral; the bidder is funded.
    StellarAssetClient::new(&env, &collateral_token).mint(&contract_id, &10_000_000);
    StellarAssetClient::new(&env, &payment_token).mint(&bidder, &5_000_000);

    Ctx {
        env,
        contract_id,
        admin,
        borrower,
        bidder,
        treasury,
        payment_token,
        collateral_token,
    }
}

#[test]
fn test_price_decays_to_floor() {
    let (env, contract_id, admin, borrower, _bidder) = setup();
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);

    client.start_auction(
        &admin,
        &7,
        &borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    assert_eq!(client.current_price(&7), 1_000_000);
    env.ledger().set_timestamp(START_TIMESTAMP + 10);
    assert_eq!(client.current_price(&7), 500_000);
    env.ledger().set_timestamp(START_TIMESTAMP + 40);
    assert_eq!(client.current_price(&7), 250_000);
}

#[test]
fn test_bid_settles_auction() {
    let (env, contract_id, admin, borrower, bidder) = setup();
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);

    client.start_auction(
        &admin,
        &11,
        &borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    env.ledger().set_timestamp(START_TIMESTAMP + 10);
    let settlement = client.place_bid(&bidder, &11, &1_000_000);

    assert_eq!(settlement.status, AuctionStatus::Sold);
    assert_eq!(settlement.recovered_amount, 1_000_000);
    assert_eq!(settlement.bad_debt, 0);

    let auction = client.get_auction(&11);
    assert_eq!(auction.status, AuctionStatus::Sold);
}

#[test]
#[should_panic(expected = "Bid below current auction price")]
fn test_bid_below_current_price_is_rejected() {
    let (env, contract_id, admin, borrower, bidder) = setup();
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);

    client.start_auction(
        &admin,
        &13,
        &borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    env.ledger().set_timestamp(START_TIMESTAMP + 10);
    client.place_bid(&bidder, &13, &400_000);
}

#[test]
fn test_expired_auction_creates_bad_debt() {
    let (env, contract_id, admin, borrower, _bidder) = setup();
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);

    client.start_auction(
        &admin,
        &19,
        &borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    env.ledger().set_timestamp(START_TIMESTAMP + 31);
    let settlement = client.finalize_expired(&19);

    assert_eq!(settlement.status, AuctionStatus::ExpiredUnsold);
    assert_eq!(settlement.recovered_amount, 0);
    assert_eq!(settlement.bad_debt, 1_000_000);
}

#[test]
fn test_bid_below_debt_records_insurance_claim() {
    let (env, contract_id, admin, borrower, bidder) = setup();
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);

    client.start_auction(
        &admin,
        &12,
        &borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    // Once the Dutch price reaches the floor, the collateral may sell for less
    // than the outstanding debt. The settlement is the amount the insurance
    // fund must cover for this loan.
    env.ledger().set_timestamp(START_TIMESTAMP + 20);
    let settlement = client.place_bid(&bidder, &12, &250_000);

    assert_eq!(settlement.status, AuctionStatus::Sold);
    assert_eq!(settlement.recovered_amount, 250_000);
    assert_eq!(settlement.bad_debt, 750_000);
}

#[test]
fn test_bid_moves_payment_and_collateral() {
    let c = setup_ctx();
    let client = LiquidationAuctionContractClient::new(&c.env, &c.contract_id);
    client.start_auction(
        &c.admin,
        &21,
        &c.borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    c.env.ledger().set_timestamp(START_TIMESTAMP + 10);
    client.place_bid(&c.bidder, &21, &600_000);

    let pay = TokenClient::new(&c.env, &c.payment_token);
    let col = TokenClient::new(&c.env, &c.collateral_token);
    assert_eq!(pay.balance(&c.bidder), 4_400_000);
    assert_eq!(pay.balance(&c.treasury), 600_000);
    assert_eq!(col.balance(&c.bidder), 10_000_000);
    assert_eq!(col.balance(&c.contract_id), 0);
}

#[test]
#[should_panic]
fn test_bidder_without_funds_cannot_win_auction() {
    let c = setup_ctx();
    let client = LiquidationAuctionContractClient::new(&c.env, &c.contract_id);
    client.start_auction(
        &c.admin,
        &22,
        &c.borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    let broke = Address::generate(&c.env);
    c.env.ledger().set_timestamp(START_TIMESTAMP + 10);
    client.place_bid(&broke, &22, &600_000);
}

#[test]
fn test_failed_bid_leaves_auction_active() {
    let c = setup_ctx();
    let client = LiquidationAuctionContractClient::new(&c.env, &c.contract_id);
    client.start_auction(
        &c.admin,
        &23,
        &c.borrower,
        &10_000_000,
        &1_000_000,
        &1_000_000,
        &250_000,
        &50_000,
        &30,
    );

    let broke = Address::generate(&c.env);
    c.env.ledger().set_timestamp(START_TIMESTAMP + 10);
    assert!(client.try_place_bid(&broke, &23, &600_000).is_err());

    assert_eq!(client.get_auction(&23).status, AuctionStatus::Active);
    let col = TokenClient::new(&c.env, &c.collateral_token);
    assert_eq!(col.balance(&c.contract_id), 10_000_000);
    assert_eq!(col.balance(&broke), 0);
}
