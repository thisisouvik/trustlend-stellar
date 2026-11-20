#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, Env};

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum AuctionStatus {
    Active,
    Sold,
    ExpiredUnsold,
}

/// Tokens and recipient used to settle an auction (Issue #418).
#[contracttype]
#[derive(Clone)]
#[cfg_attr(test, derive(Debug))]
pub struct AuctionAssets {
    /// SEP-41 token being liquidated. The auction holds `collateral_amount`
    /// of it in custody from `start_auction` until settlement.
    pub collateral_token: Address,
    /// SEP-41 token bids are paid in (the loan's debt asset, e.g. XLM).
    pub payment_token: Address,
    /// Lending pool / treasury that is owed the debt: receives the winning
    /// bid, or the unsold collateral if the auction expires.
    pub proceeds_recipient: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct LiquidationAuction {
    pub loan_id: u32,
    pub borrower: Address,
    pub collateral_token: Address,
    pub payment_token: Address,
    pub proceeds_recipient: Address,
    pub collateral_amount: i128,
    pub debt_amount: i128,
    pub start_price: i128,
    pub floor_price: i128,
    pub decay_per_second: i128,
    pub started_at: u64,
    pub expires_at: u64,
    pub status: AuctionStatus,
    pub highest_bid: i128,
    pub recovered_amount: i128,
    pub bad_debt: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct AuctionSettlement {
    pub loan_id: u32,
    pub recovered_amount: i128,
    pub bad_debt: i128,
    pub status: AuctionStatus,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Auction(u32),
}

#[contract]
pub struct LiquidationAuctionContract;

#[contractimpl]
impl LiquidationAuctionContract {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Start a Dutch auction for a defaulted loan's collateral.
    ///
    /// `collateral_amount` of `assets.collateral_token` is transferred from
    /// `caller` (the admin / liquidation operator holding the seized
    /// collateral) into this contract, so every auction is backed by
    /// collateral in custody that can actually be delivered to the winner
    /// (Issue #418).
    pub fn start_auction(
        env: Env,
        caller: Address,
        loan_id: u32,
        borrower: Address,
        assets: AuctionAssets,
        collateral_amount: i128,
        debt_amount: i128,
        start_price: i128,
        floor_price: i128,
        decay_per_second: i128,
        duration_seconds: u64,
    ) -> LiquidationAuction {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if env.storage().persistent().has(&DataKey::Auction(loan_id)) {
            panic!("Auction already exists");
        }
        if collateral_amount <= 0 || debt_amount <= 0 {
            panic!("Collateral and debt must be positive");
        }
        if start_price <= 0 || floor_price <= 0 {
            panic!("Auction prices must be positive");
        }
        if start_price < floor_price {
            panic!("Start price must be greater than or equal to floor price");
        }
        if decay_per_second < 0 {
            panic!("Decay must be non-negative");
        }
        if duration_seconds == 0 {
            panic!("Duration must be greater than zero");
        }

        // Take custody of the collateral being sold.
        token::Client::new(&env, &assets.collateral_token).transfer(
            &caller,
            &env.current_contract_address(),
            &collateral_amount,
        );

        let started_at = env.ledger().timestamp();
        let expires_at = started_at
            .checked_add(duration_seconds)
            .expect("Auction expiry timestamp overflow");
        let auction = LiquidationAuction {
            loan_id,
            borrower,
            collateral_token: assets.collateral_token,
            payment_token: assets.payment_token,
            proceeds_recipient: assets.proceeds_recipient,
            collateral_amount,
            debt_amount,
            start_price,
            floor_price,
            decay_per_second,
            started_at,
            expires_at,
            status: AuctionStatus::Active,
            highest_bid: 0,
            recovered_amount: 0,
            bad_debt: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Auction(loan_id), &auction);
        env.events().publish(
            (symbol_short!("auction"), symbol_short!("start")),
            (loan_id, auction.start_price, auction.expires_at),
        );

        auction
    }

    pub fn get_auction(env: Env, loan_id: u32) -> LiquidationAuction {
        env.storage()
            .persistent()
            .get(&DataKey::Auction(loan_id))
            .expect("Auction not found")
    }

    pub fn current_price(env: Env, loan_id: u32) -> i128 {
        let auction = Self::get_auction(env.clone(), loan_id);
        Self::price_at(
            auction.start_price,
            auction.floor_price,
            auction.decay_per_second,
            auction.started_at,
            auction.expires_at,
            env.ledger().timestamp(),
        )
    }

    /// Buy the auctioned collateral at or above the current Dutch price.
    ///
    /// The bidder pays `bid_amount` of the payment token to the auction's
    /// `proceeds_recipient` and receives the collateral from custody in the
    /// same call (Issue #418). A bidder who cannot cover the payment cannot
    /// win: the transfer fails and the whole bid reverts.
    pub fn place_bid(env: Env, bidder: Address, loan_id: u32, bid_amount: i128) -> AuctionSettlement {
        bidder.require_auth();

        let mut auction = Self::load_active_auction(&env, loan_id);
        let now = env.ledger().timestamp();
        if now >= auction.expires_at {
            panic!("Auction has expired");
        }

        let current_price = Self::price_at(
            auction.start_price,
            auction.floor_price,
            auction.decay_per_second,
            auction.started_at,
            auction.expires_at,
            now,
        );

        if bid_amount < current_price {
            panic!("Bid below current auction price");
        }

        auction.status = AuctionStatus::Sold;
        auction.highest_bid = bid_amount;
        auction.recovered_amount = bid_amount;
        // A bid above the debt leaves no bad debt (never a negative amount).
        auction.bad_debt = auction.debt_amount.saturating_sub(bid_amount).max(0);

        let settlement = AuctionSettlement {
            loan_id,
            recovered_amount: auction.recovered_amount,
            bad_debt: auction.bad_debt,
            status: auction.status.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Auction(loan_id), &auction);

        // Payment: bidder → proceeds recipient. Fails (reverting the bid) if
        // the bidder's balance does not cover `bid_amount`.
        token::Client::new(&env, &auction.payment_token).transfer(
            &bidder,
            &auction.proceeds_recipient,
            &bid_amount,
        );
        // Delivery: collateral custody → bidder.
        token::Client::new(&env, &auction.collateral_token).transfer(
            &env.current_contract_address(),
            &bidder,
            &auction.collateral_amount,
        );

        env.events().publish(
            (symbol_short!("auction"), symbol_short!("bid")),
            (loan_id, bidder, bid_amount, settlement.bad_debt),
        );

        settlement
    }

    /// Close an auction that expired without a bid. The full debt becomes
    /// bad debt and the unsold collateral is released from custody to the
    /// `proceeds_recipient`, so it is never stranded in this contract.
    pub fn finalize_expired(env: Env, loan_id: u32) -> AuctionSettlement {
        let mut auction = Self::load_active_auction(&env, loan_id);
        let now = env.ledger().timestamp();
        if now < auction.expires_at {
            panic!("Auction still active");
        }

        auction.status = AuctionStatus::ExpiredUnsold;
        auction.highest_bid = 0;
        auction.recovered_amount = 0;
        auction.bad_debt = auction.debt_amount;

        let settlement = AuctionSettlement {
            loan_id,
            recovered_amount: 0,
            bad_debt: auction.bad_debt,
            status: auction.status.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Auction(loan_id), &auction);

        token::Client::new(&env, &auction.collateral_token).transfer(
            &env.current_contract_address(),
            &auction.proceeds_recipient,
            &auction.collateral_amount,
        );

        env.events().publish(
            (symbol_short!("auction"), symbol_short!("expire")),
            (loan_id, auction.collateral_amount, settlement.bad_debt),
        );

        settlement
    }

    fn price_at(
        start_price: i128,
        floor_price: i128,
        decay_per_second: i128,
        started_at: u64,
        expires_at: u64,
        now: u64,
    ) -> i128 {
        let capped_now = if now > expires_at { expires_at } else { now };
        let elapsed = capped_now.saturating_sub(started_at) as i128;
        let decay = elapsed
            .checked_mul(decay_per_second)
            .expect("Overflow calculating auction price");
        let decayed = start_price.saturating_sub(decay);
        decayed.max(floor_price)
    }

    fn load_active_auction(env: &Env, loan_id: u32) -> LiquidationAuction {
        let auction: LiquidationAuction = env
            .storage()
            .persistent()
            .get(&DataKey::Auction(loan_id))
            .expect("Auction not found");

        if auction.status != AuctionStatus::Active {
            panic!("Auction already settled");
        }

        auction
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised");
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }
}

#[cfg(test)]
mod test;
