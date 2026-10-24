#![no_std]
//! TLEND — TrustLend DAO Governance Token
//!
//! A standard SEP-41 fungible token (the same interface implemented by the
//! Stellar Asset Contract), so TLEND is usable anywhere the codebase already
//! expects a `token::Client` (vesting payouts, airdrop claims, treasury
//! transfers, …). Admin-gated minting is the only extension beyond the core
//! transfer/allowance/burn interface.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token::{self, StellarAssetInterface, TokenInterface},
    Address, BytesN, Env, String,
};

#[cfg(test)]
mod test;

// ─── Types & Storage ─────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Decimals,
    Name,
    Symbol,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),
    /// Whether `id` is authorised to use its balance. Absent == authorised.
    Authorized(Address),
}

// ─── TlendTokenContract ──────────────────────────────────────────────────────

/// Maximum total supply of TLEND tokens: 1,000,000,000 TLEND at 7 decimal places (10^16 stroops).
pub const MAX_TOTAL_SUPPLY: i128 = 10_000_000_000_000_000;
/// Alias for `MAX_TOTAL_SUPPLY`.
pub const MAX_SUPPLY: i128 = MAX_TOTAL_SUPPLY;

#[contract]
pub struct TlendTokenContract;

#[contractimpl]
impl TlendTokenContract {
    /// One-time setup. `decimals`/`name`/`symbol` are immutable token metadata.
    pub fn initialize(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("TLEND already initialised");
        }
        if decimals > 18 {
            panic!("Decimals must be <= 18");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        let admin = Self::read_admin(&env);
        if caller != admin {
            panic!("Unauthorised caller");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0)
    }

    pub fn max_supply(_env: Env) -> i128 {
        MAX_TOTAL_SUPPLY
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fn read_admin(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("TLEND not initialised")
    }

    fn read_balance(env: &Env, id: &Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(id.clone())).unwrap_or(0)
    }

    fn write_balance(env: &Env, id: &Address, amount: i128) {
        env.storage().persistent().set(&DataKey::Balance(id.clone()), &amount);
    }

    fn spend_balance(env: &Env, id: &Address, amount: i128) {
        let balance = Self::read_balance(env, id);
        if balance < amount {
            panic!("Insufficient balance");
        }
        Self::write_balance(env, id, balance - amount);
    }

    fn receive_balance(env: &Env, id: &Address, amount: i128) {
        let balance = Self::read_balance(env, id);
        Self::write_balance(env, id, balance + amount);
    }

    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> AllowanceValue {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        match env.storage().temporary().get::<_, AllowanceValue>(&key) {
            Some(allowance) if allowance.expiration_ledger >= env.ledger().sequence() => allowance,
            _ => AllowanceValue { amount: 0, expiration_ledger: 0 },
        }
    }

    fn write_allowance(
        env: &Env,
        from: &Address,
        spender: &Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            panic!("Expiration ledger is in the past");
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage()
            .temporary()
            .set(&key, &AllowanceValue { amount, expiration_ledger });
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let allowance = Self::read_allowance(env, from, spender);
        if allowance.amount < amount {
            panic!("Insufficient allowance");
        }
        if amount > 0 {
            Self::write_allowance(
                env,
                from,
                spender,
                allowance.amount - amount,
                allowance.expiration_ledger,
            );
        }
    }

    fn check_authorized(env: &Env, id: &Address) {
        let authorized: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Authorized(id.clone()))
            .unwrap_or(true);
        if !authorized {
            panic!("Account is not authorised to hold or transfer TLEND");
        }
    }

    fn check_non_negative_amount(amount: i128) {
        if amount < 0 {
            panic!("Amount must be non-negative");
        }
    }
}

// ─── SEP-41 core token interface ─────────────────────────────────────────────

#[contractimpl]
impl token::TokenInterface for TlendTokenContract {
    fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::read_allowance(&env, &from, &spender).amount
    }

    fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        from.require_auth();
        Self::check_non_negative_amount(amount);

        Self::write_allowance(&env, &from, &spender, amount, expiration_ledger);
        env.events().publish(
            (symbol_short!("approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    fn balance(env: Env, id: Address) -> i128 {
        Self::read_balance(&env, &id)
    }

    fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::check_non_negative_amount(amount);
        Self::check_authorized(&env, &from);
        Self::check_authorized(&env, &to);

        Self::spend_balance(&env, &from, amount);
        Self::receive_balance(&env, &to, amount);
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
    }

    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::check_non_negative_amount(amount);
        Self::check_authorized(&env, &from);
        Self::check_authorized(&env, &to);

        Self::spend_allowance(&env, &from, &spender, amount);
        Self::spend_balance(&env, &from, amount);
        Self::receive_balance(&env, &to, amount);
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
    }

    fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::check_non_negative_amount(amount);
        Self::check_authorized(&env, &from);

        Self::spend_balance(&env, &from, amount);
        let supply = Self::total_supply(env.clone());
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));
        env.events()
            .publish((symbol_short!("burn"), from), amount);
    }

    fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        Self::check_non_negative_amount(amount);
        Self::check_authorized(&env, &from);

        Self::spend_allowance(&env, &from, &spender, amount);
        Self::spend_balance(&env, &from, amount);
        let supply = Self::total_supply(env.clone());
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));
        env.events()
            .publish((symbol_short!("burn"), from), amount);
    }

    fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).expect("TLEND not initialised")
    }

    fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).expect("TLEND not initialised")
    }

    fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).expect("TLEND not initialised")
    }
}

// ─── Admin (Stellar Asset) interface ─────────────────────────────────────────

#[contractimpl]
impl token::StellarAssetInterface for TlendTokenContract {
    fn set_admin(env: Env, new_admin: Address) {
        let admin = Self::read_admin(&env);
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events()
            .publish((symbol_short!("set_admin"), admin), new_admin);
    }

    fn admin(env: Env) -> Address {
        Self::read_admin(&env)
    }

    fn set_authorized(env: Env, id: Address, authorize: bool) {
        let admin = Self::read_admin(&env);
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::Authorized(id.clone()), &authorize);
        env.events()
            .publish((symbol_short!("set_auth"), id), authorize);
    }

    fn authorized(env: Env, id: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Authorized(id))
            .unwrap_or(true)
    }

    fn mint(env: Env, to: Address, amount: i128) {
        let admin = Self::read_admin(&env);
        admin.require_auth();
        Self::check_non_negative_amount(amount);
        Self::check_authorized(&env, &to);

        let supply = Self::total_supply(env.clone());
        let new_supply = supply
            .checked_add(amount)
            .expect("Total supply overflow");
        if new_supply > MAX_TOTAL_SUPPLY {
            panic!("Mint exceeds MAX_TOTAL_SUPPLY");
        }

        Self::receive_balance(&env, &to, amount);
        env.storage().instance().set(&DataKey::TotalSupply, &new_supply);
        env.events()
            .publish((symbol_short!("mint"), admin, to), amount);
    }

    fn clawback(env: Env, from: Address, amount: i128) {
        let admin = Self::read_admin(&env);
        admin.require_auth();
        Self::check_non_negative_amount(amount);

        Self::spend_balance(&env, &from, amount);
        let supply = Self::total_supply(env.clone());
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));
        env.events()
            .publish((symbol_short!("clawback"), admin, from), amount);
    }
}
