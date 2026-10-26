#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, xdr::ToXdr, Address, Bytes, BytesN, Env,
    String,
};

/// Version of the `ZkProofStatement` layout providers sign. Bump it whenever
/// the statement changes so old signatures can never verify against a new
/// layout.
pub const PROOF_STATEMENT_VERSION: u32 = 1;

/// Reputation tier matching borrower_reputation contract enum indexing.
/// 1 = Beginner, 2 = Silver, 3 = Gold, 4 = Platinum
#[contracttype]
#[derive(Clone, Eq, PartialEq, Debug)]
pub enum ZkCreditTier {
    Beginner = 1,
    Silver = 2,
    Gold = 3,
    Platinum = 4,
}

/// Zero-Knowledge proof input parameters provided by the client/prover.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ZkProofPayload {
    /// Unique nullifier hash derived from secret off-chain data + borrower context (SHA-256 / Poseidon)
    pub nullifier: BytesN<32>,
    /// Ed25519 signature by the provider over `proof_digest(borrower, payload)`
    /// (64 bytes). See `ZkProofStatement` for exactly what is signed.
    pub proof_bytes: BytesN<64>,
    /// The provider's Ed25519 public key. Its SHA-256 must equal the
    /// `public_key_hash` registered for `provider_id`.
    pub provider_public_key: BytesN<32>,
    /// Minimum off-chain credit score threshold proven in zero-knowledge (e.g. 700, 750, 800)
    pub min_score_threshold: u32,
    /// Target tier requested based on proven score (1=Beginner, 2=Silver, 3=Gold, 4=Platinum)
    pub target_tier: u32,
    /// Identifier of the trusted ZK provider (e.g., "zkTLS-Bank", "PolygonID-Experian")
    pub provider_id: String,
    /// Expiration ledger timestamp for the generated proof
    pub expiration: u64,
}

/// On-chain record storing the borrower's latest verified ZK credit state.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ZkVerificationRecord {
    pub borrower: Address,
    pub provider_id: String,
    pub min_score_threshold: u32,
    pub tier_granted: u32,
    pub nullifier: BytesN<32>,
    pub verified_at: u64,
}

/// The attestation a registered provider signs with its Ed25519 key.
///
/// It binds every field of the proof to the network, this verifier contract
/// and the borrower, so a signature cannot be replayed on another network or
/// deployment, transferred to another borrower, or reused after changing the
/// tier, score threshold, expiry, provider or nullifier.
///
/// Providers sign the 32-byte SHA-256 digest of this struct's XDR encoding
/// (an `ScVal` map); `proof_digest` returns that digest so it can be obtained
/// by simulation rather than re-implemented off-chain.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ZkProofStatement {
    pub version: u32,
    pub network_id: BytesN<32>,
    pub verifier: Address,
    pub borrower: Address,
    pub provider_id: String,
    pub nullifier: BytesN<32>,
    pub min_score_threshold: u32,
    pub target_tier: u32,
    pub expiration: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    /// Trusted provider public key hash mapping: ProviderKey(String) -> BytesN<32>
    ProviderKey(String),
    /// Nullifier tracking key for double-spending prevention: Nullifier(BytesN<32>) -> bool
    Nullifier(BytesN<32>),
    /// Record per borrower: BorrowerRecord(Address) -> ZkVerificationRecord
    BorrowerRecord(Address),
    TotalVerifications,
}

#[contract]
pub struct ZkCreditVerifierContract;

#[contractimpl]
impl ZkCreditVerifierContract {
    pub fn __constructor(env: Env, admin: Address) {
        Self::init_internal(&env, admin);
    }

    /// Initialize contract with admin address.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        Self::init_internal(&env, admin);
    }

    fn init_internal(env: &Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TotalVerifications, &0u32);
    }

    /// Admin registers a trusted ZK proof provider (e.g., zkTLS attestation service or Polygon ID issuer).
    ///
    /// `public_key_hash` is the SHA-256 of the provider's 32-byte Ed25519
    /// public key. Re-registering a provider rotates its key: proofs signed
    /// with the previous key stop verifying.
    pub fn register_provider(env: Env, admin: Address, provider_id: String, public_key_hash: BytesN<32>) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let key = DataKey::ProviderKey(provider_id.clone());
        env.storage().instance().set(&key, &public_key_hash);

        env.events().publish(
            (symbol_short!("zk_prov"), symbol_short!("register")),
            (provider_id, public_key_hash),
        );
    }

    /// Check if a ZK provider is registered.
    pub fn is_provider_registered(env: Env, provider_id: String) -> bool {
        let key = DataKey::ProviderKey(provider_id);
        env.storage().instance().has(&key)
    }

    /// Check if a nullifier has already been spent.
    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        let key = DataKey::Nullifier(nullifier);
        env.storage().persistent().has(&key)
    }

    /// SHA-256 of the `ZkProofStatement` a provider must sign for `borrower`
    /// to submit `proof` to this contract. `proof_bytes` and
    /// `provider_public_key` are not part of the statement and are ignored.
    pub fn proof_digest(env: Env, borrower: Address, proof: ZkProofPayload) -> BytesN<32> {
        Self::statement_digest(&env, &borrower, &proof)
    }

    /// Verify a Zero-Knowledge Credit Proof submitted by a borrower.
    ///
    /// Validates proof expiration, nullifier replay attack protection, provider authorization,
    /// the provider's Ed25519 signature over the proof statement, and records the ZK
    /// verification on-chain.
    pub fn verify_credit_proof(
        env: Env,
        borrower: Address,
        proof: ZkProofPayload,
    ) -> ZkVerificationRecord {
        borrower.require_auth();

        // 1. Check expiration
        let current_time = env.ledger().timestamp();
        if proof.expiration < current_time {
            panic!("ZK Proof has expired");
        }

        // 2. Prevent replay attacks: ensure nullifier has not been spent
        let nullifier_key = DataKey::Nullifier(proof.nullifier.clone());
        if env.storage().persistent().has(&nullifier_key) {
            panic!("Nullifier already spent");
        }

        // 3. Verify ZK Provider authorization
        let provider_key = DataKey::ProviderKey(proof.provider_id.clone());
        let pubkey_hash: BytesN<32> = match env.storage().instance().get(&provider_key) {
            Some(hash) => hash,
            None => panic!("Unregistered ZK proof provider"),
        };

        // 4. Validate tier parameters (1..=4)
        if proof.target_tier < 1 || proof.target_tier > 4 {
            panic!("Invalid ZK target tier");
        }

        // 5. Cryptographic proof validation (Issue #336)
        // 5a. The presented key must be the one registered for this provider.
        let presented_key_hash: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from(proof.provider_public_key.clone()))
            .to_bytes();
        if presented_key_hash != pubkey_hash {
            panic!("Provider public key does not match registered key hash");
        }
        // 5b. That key must have signed this exact statement. The host traps
        // on an invalid signature, so nothing below runs for a forged proof.
        let digest = Self::statement_digest(&env, &borrower, &proof);
        env.crypto().ed25519_verify(
            &proof.provider_public_key,
            &Bytes::from(digest),
            &proof.proof_bytes,
        );

        // 6. Mark nullifier as spent in persistent storage
        env.storage().persistent().set(&nullifier_key, &true);

        // 7. Store borrower ZK record
        let record = ZkVerificationRecord {
            borrower: borrower.clone(),
            provider_id: proof.provider_id.clone(),
            min_score_threshold: proof.min_score_threshold,
            tier_granted: proof.target_tier,
            nullifier: proof.nullifier.clone(),
            verified_at: current_time,
        };

        let borrower_key = DataKey::BorrowerRecord(borrower.clone());
        env.storage().persistent().set(&borrower_key, &record);

        // 8. Increment total verification count
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TotalVerifications)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalVerifications, &(count + 1));

        // 9. Publish event
        env.events().publish(
            (symbol_short!("zk_proof"), symbol_short!("verified")),
            (
                borrower,
                proof.provider_id,
                proof.min_score_threshold,
                proof.target_tier,
            ),
        );

        record
    }

    /// Retrieve verified ZK record for a borrower.
    pub fn get_borrower_record(env: Env, borrower: Address) -> ZkVerificationRecord {
        let key = DataKey::BorrowerRecord(borrower);
        env.storage()
            .persistent()
            .get(&key)
            .expect("No ZK credit record found for borrower")
    }

    /// Total number of ZK proofs verified by the contract.
    pub fn get_total_verifications(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TotalVerifications)
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    fn statement_digest(env: &Env, borrower: &Address, proof: &ZkProofPayload) -> BytesN<32> {
        let statement = ZkProofStatement {
            version: PROOF_STATEMENT_VERSION,
            network_id: env.ledger().network_id(),
            verifier: env.current_contract_address(),
            borrower: borrower.clone(),
            provider_id: proof.provider_id.clone(),
            nullifier: proof.nullifier.clone(),
            min_score_threshold: proof.min_score_threshold,
            target_tier: proof.target_tier,
            expiration: proof.expiration,
        };
        env.crypto().sha256(&statement.to_xdr(env)).to_bytes()
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = Self::get_admin(env.clone());
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }
}

#[cfg(test)]
mod test;
