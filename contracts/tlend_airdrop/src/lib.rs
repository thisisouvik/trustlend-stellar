#![no_std]
//! TLEND Airdrop
//!
//! Distributes TLEND to a fixed list of eligible addresses without storing
//! the whole list on-chain: eligibility is committed to as a single Merkle
//! root, and each claimant proves membership with a Merkle proof of their
//! `(address, amount)` leaf. Proof verification uses the standard
//! sorted-pair scheme (each step hashes `sha256(min(a,b) || max(a,b))`), so
//! callers don't need to track left/right sibling order.

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

    /// Recover unclaimed TLEND from the pool to `to`. Admin only; intended for
    /// use once an airdrop round has closed or expired, so tokens allocated to
    /// addresses that never claimed are not trapped in the contract.
    pub fn sweep_unclaimed(env: Env, caller: Address, to: Address, amount: i128) {
        caller.require_auth();
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("Unauthorised caller: not admin");
        }
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let token_addr = Self::get_token(env.clone());
        let token_client = token::Client::new(&env, &token_addr);
        if token_client.balance(&env.current_contract_address()) < amount {
            panic!("Insufficient airdrop balance");
        }
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        env.events().publish(
            (symbol_short!("airdrop"), symbol_short!("sweep")),
            (to, amount),
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

    pub fn has_claimed(env: Env, claimant: Address) -> bool {
        env.storage().persistent().get(&DataKey::Claimed(claimant)).unwrap_or(false)
    }

    /// Compute the leaf hash for `(claimant, amount)` — exposed so off-chain
    /// tooling and tests can build a matching Merkle tree.
    pub fn leaf_hash_for(env: Env, claimant: Address, amount: i128) -> BytesN<32> {
        Self::leaf_hash(&env, &claimant, amount)
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

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
