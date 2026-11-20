#![no_std]
//! TLEND Airdrop
//!
//! Distributes TLEND to a fixed list of eligible addresses without storing
//! the whole list on-chain: eligibility is committed to as a single Merkle
//! root, and each claimant proves membership with a Merkle proof of their
//! `(address, amount)` leaf. Proof verification uses the standard
//! sorted-pair scheme (each step hashes `sha256(min(a,b) || max(a,b))`), so
//! callers don't need to track left/right sibling order.
//!
//! ## Unclaimed token recovery (Issue #422)
//! The admin can set a claim deadline (a ledger timestamp) that may only be
//! extended, never shortened. Once it has passed, claims close and the admin
//! or the configured multisig admin can `sweep_unclaimed` the remaining TLEND
//! back to the treasury, so expired campaigns don't trap tokens forever.
//! Sweeps are impossible while the claim window is open (or before a
//! deadline has been set), so eligible claimants always keep their window.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env, Vec,
};

#[cfg(test)]
mod test;

// ─── Types & Storage ─────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    MerkleRoot,
    Claimed(Address),
    /// Ledger timestamp after which claims close and sweeps open.
    ClaimDeadline,
    /// Multisig admin contract, authorised alongside `Admin` for recovery.
    MultisigAdmin,
}

// ─── TlendAirdropContract ────────────────────────────────────────────────────

#[contract]
pub struct TlendAirdropContract;

#[contractimpl]
impl TlendAirdropContract {
    pub fn initialize(env: Env, admin: Address, token: Address, merkle_root: BytesN<32>) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Airdrop contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::MerkleRoot, &merkle_root);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("Unauthorised caller");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Replace the eligibility commitment (e.g. to open a new airdrop round).
    /// Does not reset `Claimed` flags — use a fresh contract instance per
    /// round if past claimants must be eligible again.
    pub fn set_merkle_root(env: Env, admin: Address, new_root: BytesN<32>) {
        admin.require_auth();
        let stored_admin = Self::get_admin(env.clone());
        if admin != stored_admin {
            panic!("Unauthorised caller: not admin");
        }
        env.storage().instance().set(&DataKey::MerkleRoot, &new_root);
    }

    /// Fund the airdrop pool by pulling `amount` TLEND from `admin`.
    pub fn fund(env: Env, admin: Address, amount: i128) {
        admin.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let token_addr = Self::get_token(env.clone());
        token::Client::new(&env, &token_addr).transfer(
            &admin,
            &env.current_contract_address(),
            &amount,
        );
    }

    /// Claim `amount` TLEND as `claimant`, proving membership of the
    /// `(claimant, amount)` leaf in the committed Merkle tree.
    pub fn claim(env: Env, claimant: Address, amount: i128, proof: Vec<BytesN<32>>) {
        claimant.require_auth();

        if amount <= 0 {
            panic!("amount must be positive");
        }
        if Self::claim_period_ended(&env) {
            panic!("Claim period has ended");
        }
        if Self::has_claimed(env.clone(), claimant.clone()) {
            panic!("Already claimed");
        }

        let root: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::MerkleRoot)
            .expect("Airdrop contract not initialised");
        let leaf = Self::leaf_hash(&env, &claimant, amount);
        if !Self::verify_proof(&env, leaf, proof, &root) {
            panic!("Invalid Merkle proof");
        }

        env.storage()
            .persistent()
            .set(&DataKey::Claimed(claimant.clone()), &true);

        let token_addr = Self::get_token(env.clone());
        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &claimant,
            &amount,
        );

        env.events().publish(
            (symbol_short!("airdrop"), symbol_short!("claim")),
            (claimant, amount),
        );
    }

    // ── Unclaimed token recovery (Issue #422) ────────────────────────────────

    /// Register the multisig admin contract allowed to sweep unclaimed tokens
    /// alongside the admin. Admin only; can be configured once.
    pub fn set_multisig_admin(env: Env, admin: Address, multisig: Address) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()) {
            panic!("Unauthorised caller: not admin");
        }
        if env.storage().instance().has(&DataKey::MultisigAdmin) {
            panic!("Multisig admin already configured");
        }
        env.storage().instance().set(&DataKey::MultisigAdmin, &multisig);
    }

    /// Set the ledger timestamp after which claims close and unclaimed tokens
    /// can be swept. Admin only. The deadline must be in the future and can
    /// only be extended, so claimants are never cut short.
    pub fn set_claim_deadline(env: Env, admin: Address, deadline: u64) {
        admin.require_auth();
        if admin != Self::get_admin(env.clone()) {
            panic!("Unauthorised caller: not admin");
        }
        if deadline <= env.ledger().timestamp() {
            panic!("Deadline must be in the future");
        }
        if let Some(current) = Self::get_claim_deadline(env.clone()) {
            if deadline < current {
                panic!("Deadline can only be extended");
            }
        }
        env.storage().instance().set(&DataKey::ClaimDeadline, &deadline);

        env.events().publish(
            (symbol_short!("airdrop"), symbol_short!("deadline")),
            deadline,
        );
    }

    /// Recover `amount` unclaimed TLEND to `to` (e.g. the treasury) once the
    /// claim period has ended. Restricted to the admin or the multisig admin.
    pub fn sweep_unclaimed(env: Env, caller: Address, to: Address, amount: i128) {
        caller.require_auth();
        Self::assert_admin_or_multisig(&env, &caller);

        if amount <= 0 {
            panic!("amount must be positive");
        }
        if Self::get_claim_deadline(env.clone()).is_none() {
            panic!("Claim deadline not set");
        }
        if !Self::claim_period_ended(&env) {
            panic!("Claim period still active");
        }

        let token_client = token::Client::new(&env, &Self::get_token(env.clone()));
        let contract = env.current_contract_address();
        if amount > token_client.balance(&contract) {
            panic!("amount exceeds unclaimed balance");
        }
        token_client.transfer(&contract, &to, &amount);

        env.events().publish(
            (symbol_short!("airdrop"), symbol_short!("sweep")),
            (caller, to, amount),
        );
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("Airdrop contract not initialised")
    }

    pub fn get_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token).expect("Airdrop contract not initialised")
    }

    pub fn get_merkle_root(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::MerkleRoot)
            .expect("Airdrop contract not initialised")
    }

    pub fn get_claim_deadline(env: Env) -> Option<u64> {
        env.storage().instance().get(&DataKey::ClaimDeadline)
    }

    pub fn get_multisig_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::MultisigAdmin)
    }

    /// TLEND currently held by the airdrop (unclaimed or not yet allocated).
    pub fn get_unclaimed_balance(env: Env) -> i128 {
        token::Client::new(&env, &Self::get_token(env.clone()))
            .balance(&env.current_contract_address())
    }

    pub fn has_claimed(env: Env, claimant: Address) -> bool {
        env.storage().persistent().get(&DataKey::Claimed(claimant)).unwrap_or(false)
    }

    /// Compute the leaf hash for `(claimant, amount)` — exposed so off-chain
    /// tooling and tests can build a matching Merkle tree.
    pub fn leaf_hash_for(env: Env, claimant: Address, amount: i128) -> BytesN<32> {
        Self::leaf_hash(&env, &claimant, amount)
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// True once a claim deadline is set and the ledger is past it.
    fn claim_period_ended(env: &Env) -> bool {
        match Self::get_claim_deadline(env.clone()) {
            Some(deadline) => env.ledger().timestamp() > deadline,
            None => false,
        }
    }

    fn assert_admin_or_multisig(env: &Env, caller: &Address) {
        if *caller == Self::get_admin(env.clone()) {
            return;
        }
        if Self::get_multisig_admin(env.clone()).map_or(false, |m| m == *caller) {
            return;
        }
        panic!("Unauthorised caller: not admin or multisig");
    }

    fn leaf_hash(env: &Env, claimant: &Address, amount: i128) -> BytesN<32> {
        let addr_str = claimant.to_string();
        let len = addr_str.len() as usize;
        let mut buf = [0u8; 64];
        addr_str.copy_into_slice(&mut buf[..len]);

        let mut data = Bytes::from_slice(env, &buf[..len]);
        data.append(&Bytes::from_array(env, &amount.to_be_bytes()));

        env.crypto().sha256(&data).into()
    }

    /// Sorted-pair Merkle proof verification (OpenZeppelin-style): at each
    /// step the smaller of the two 32-byte hashes (by byte value) goes first,
    /// so proofs don't need to encode left/right direction.
    fn verify_proof(
        env: &Env,
        leaf: BytesN<32>,
        proof: Vec<BytesN<32>>,
        root: &BytesN<32>,
    ) -> bool {
        let mut computed = leaf;
        for sibling in proof.iter() {
            let (first, second) = if computed <= sibling {
                (computed.clone(), sibling.clone())
            } else {
                (sibling.clone(), computed.clone())
            };
            let mut combined = Bytes::from(first);
            combined.append(&Bytes::from(second));
            computed = env.crypto().sha256(&combined).into();
        }
        computed == *root
    }
}
