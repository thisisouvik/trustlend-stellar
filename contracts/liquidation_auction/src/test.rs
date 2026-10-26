#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

const START_TIMESTAMP: u64 = 1_000;

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIMESTAMP);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let bidder = Address::generate(&env);

    let contract_id = env.register(LiquidationAuctionContract, (&admin,));

    (env, contract_id, admin, borrower, bidder)
}

#[test]
#[should_panic(expected = "Contract already initialised")]
fn test_cannot_reinitialize_after_constructor() {
    let (env, contract_id, _admin, _borrower, _bidder) = setup();
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);
    let attacker = Address::generate(&env);
    client.initialize(&attacker);
}

#[test]
fn test_initialize_requires_admin_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(LiquidationAuctionContract, (&admin,));
    let client = LiquidationAuctionContractClient::new(&env, &contract_id);
    let attacker = Address::generate(&env);
    assert!(client.try_initialize(&attacker).is_err());
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
