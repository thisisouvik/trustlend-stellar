#![cfg(test)]

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Bytes, BytesN, Env, String};

fn setup_test() -> (Env, Address, ZkCreditVerifierContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(ZkCreditVerifierContract, (&admin,));
    let client = ZkCreditVerifierContractClient::new(&env, &contract_id);

    (env, admin, client)
}

#[test]
#[should_panic(expected = "Contract already initialised")]
fn test_cannot_reinitialize_after_constructor() {
    let (env, _admin, client) = setup_test();
    let attacker = Address::generate(&env);
    client.initialize(&attacker);
}

#[test]
fn test_initialize_requires_admin_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(ZkCreditVerifierContract, (&admin,));
    let client = ZkCreditVerifierContractClient::new(&env, &contract_id);
    let attacker = Address::generate(&env);
    assert!(client.try_initialize(&attacker).is_err());
}

// ─── Provider helpers ─────────────────────────────────────────────────────────

/// A deterministic Ed25519 provider key.
fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_key(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

/// SHA-256 of the provider's public key — the value the admin registers.
fn public_key_hash(env: &Env, key: &SigningKey) -> BytesN<32> {
    let pk = Bytes::from(public_key(env, key));
    env.crypto().sha256(&pk).to_bytes()
}

fn register(
    env: &Env,
    client: &ZkCreditVerifierContractClient,
    admin: &Address,
    provider_id: &String,
    key: &SigningKey,
) {
    client.register_provider(admin, provider_id, &public_key_hash(env, key));
}

/// A payload with an all-zero signature, presenting `key` as the provider key.
fn unsigned_payload(
    env: &Env,
    provider_id: &String,
    key: &SigningKey,
    nullifier_seed: u8,
    min_score_threshold: u32,
    target_tier: u32,
) -> ZkProofPayload {
    ZkProofPayload {
        nullifier: BytesN::from_array(env, &[nullifier_seed; 32]),
        proof_bytes: BytesN::from_array(env, &[0u8; 64]),
        provider_public_key: public_key(env, key),
        min_score_threshold,
        target_tier,
        provider_id: provider_id.clone(),
        expiration: env.ledger().timestamp() + 3600,
    }
}

/// Sign `payload` for `borrower` with `key`, as an off-chain provider would.
fn sign(
    env: &Env,
    client: &ZkCreditVerifierContractClient,
    borrower: &Address,
    payload: &ZkProofPayload,
    key: &SigningKey,
) -> ZkProofPayload {
    let digest = client.proof_digest(borrower, payload);
    let signature = key.sign(&digest.to_array()).to_bytes();
    let mut signed = payload.clone();
    signed.proof_bytes = BytesN::from_array(env, &signature);
    signed
}

/// Assert that a rejected proof left no trace: nullifier unspent, no record.
fn assert_nothing_recorded(
    client: &ZkCreditVerifierContractClient,
    borrower: &Address,
    payload: &ZkProofPayload,
) {
    assert!(!client.is_nullifier_used(&payload.nullifier));
    assert_eq!(client.get_total_verifications(), 0);
    assert!(client.try_get_borrower_record(borrower).is_err());
}

// ─── Happy path ───────────────────────────────────────────────────────────────

#[test]
fn test_initialize_and_register_provider() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let pubkey_hash = BytesN::from_array(&env, &[7u8; 32]);

    assert!(!client.is_provider_registered(&provider_id));

    client.register_provider(&admin, &provider_id, &pubkey_hash);
    assert!(client.is_provider_registered(&provider_id));
    assert_eq!(client.get_total_verifications(), 0);
}

#[test]
fn test_verify_credit_proof_success() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let key = signing_key(1);
    register(&env, &client, &admin, &provider_id, &key);

    let borrower = Address::generate(&env);
    let payload = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &key, 9, 750, 3), // Gold
        &key,
    );
    let nullifier = payload.nullifier.clone();

    assert!(!client.is_nullifier_used(&nullifier));

    let record = client.verify_credit_proof(&borrower, &payload);

    assert_eq!(record.borrower, borrower);
    assert_eq!(record.min_score_threshold, 750);
    assert_eq!(record.tier_granted, 3);
    assert_eq!(record.nullifier, nullifier);
    assert!(client.is_nullifier_used(&nullifier));
    assert_eq!(client.get_total_verifications(), 1);

    let stored = client.get_borrower_record(&borrower);
    assert_eq!(stored.tier_granted, 3);
}

#[test]
#[should_panic(expected = "Nullifier already spent")]
fn test_nullifier_reuse_panics() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "PolygonID-Experian");
    let key = signing_key(2);
    register(&env, &client, &admin, &provider_id, &key);

    let borrower = Address::generate(&env);
    let payload = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &key, 5, 800, 4),
        &key,
    );

    client.verify_credit_proof(&borrower, &payload);

    // Second call with same nullifier should panic
    client.verify_credit_proof(&borrower, &payload);
}

#[test]
#[should_panic(expected = "ZK Proof has expired")]
fn test_expired_proof_panics() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let key = signing_key(3);
    register(&env, &client, &admin, &provider_id, &key);

    let borrower = Address::generate(&env);
    env.ledger().set_timestamp(1_000_000_000);
    let mut payload = unsigned_payload(&env, &provider_id, &key, 4, 700, 2);
    payload.expiration = env.ledger().timestamp() - 10; // Expired
    let payload = sign(&env, &client, &borrower, &payload, &key);

    client.verify_credit_proof(&borrower, &payload);
}

#[test]
#[should_panic(expected = "Unregistered ZK proof provider")]
fn test_unregistered_provider_panics() {
    let (env, _admin, client) = setup_test();

    let provider_id = String::from_str(&env, "UnknownProvider");
    let key = signing_key(12);
    let borrower = Address::generate(&env);
    let payload = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &key, 12, 700, 2),
        &key,
    );

    client.verify_credit_proof(&borrower, &payload);
}

// ─── Forged / improperly signed proofs (Issue #336) ───────────────────────────

/// The original exploit: an all-zero signature.
#[test]
fn test_invalid_zero_proof_bytes_rejected() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let key = signing_key(4);
    register(&env, &client, &admin, &provider_id, &key);

    let borrower = Address::generate(&env);
    let payload = unsigned_payload(&env, &provider_id, &key, 14, 700, 2);

    assert!(client.try_verify_credit_proof(&borrower, &payload).is_err());
    assert_nothing_recorded(&client, &borrower, &payload);
}

/// The original exploit: any non-zero 64 bytes used to be accepted.
#[test]
fn test_arbitrary_non_zero_proof_bytes_rejected() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let key = signing_key(4);
    register(&env, &client, &admin, &provider_id, &key);

    let borrower = Address::generate(&env);
    let mut payload = unsigned_payload(&env, &provider_id, &key, 15, 800, 4);
    let mut forged = [0u8; 64];
    forged[0] = 0xab;
    forged[63] = 0xcd;
    payload.proof_bytes = BytesN::from_array(&env, &forged);

    assert!(client.try_verify_credit_proof(&borrower, &payload).is_err());
    assert_nothing_recorded(&client, &borrower, &payload);
}

/// An attacker presenting their own key (validly self-signed) is rejected
/// because it is not the key registered for the provider.
#[test]
#[should_panic(expected = "Provider public key does not match registered key hash")]
fn test_unregistered_key_rejected_even_with_valid_signature() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    register(&env, &client, &admin, &provider_id, &signing_key(5));

    let attacker_key = signing_key(66);
    let borrower = Address::generate(&env);
    let payload = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &attacker_key, 16, 800, 4),
        &attacker_key,
    );

    client.verify_credit_proof(&borrower, &payload);
}

/// An attacker presenting the registered provider key but signing with
/// their own key fails signature verification.
#[test]
fn test_signature_by_wrong_key_rejected() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let provider_key = signing_key(6);
    register(&env, &client, &admin, &provider_id, &provider_key);

    let borrower = Address::generate(&env);
    let payload = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &provider_key, 17, 800, 4),
        &signing_key(66),
    );

    assert!(client.try_verify_credit_proof(&borrower, &payload).is_err());
    assert_nothing_recorded(&client, &borrower, &payload);
}

/// A genuine Silver attestation cannot be upgraded to Platinum, nor have its
/// score threshold, expiry or nullifier changed, after signing.
#[test]
fn test_tampered_fields_invalidate_signature() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let key = signing_key(7);
    register(&env, &client, &admin, &provider_id, &key);

    let borrower = Address::generate(&env);
    let genuine = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &key, 18, 700, 2),
        &key,
    );

    let mut tier = genuine.clone();
    tier.target_tier = 4;
    let mut score = genuine.clone();
    score.min_score_threshold = 850;
    let mut expiry = genuine.clone();
    expiry.expiration += 365 * 86_400;
    let mut nullifier = genuine.clone();
    nullifier.nullifier = BytesN::from_array(&env, &[19u8; 32]);

    for tampered in [tier, score, expiry, nullifier] {
        assert!(client.try_verify_credit_proof(&borrower, &tampered).is_err());
        assert_nothing_recorded(&client, &borrower, &tampered);
    }

    // The untampered proof still verifies.
    assert_eq!(client.verify_credit_proof(&borrower, &genuine).tier_granted, 2);
}

/// A proof signed for one borrower cannot be used by another.
#[test]
fn test_proof_cannot_be_transferred_to_another_borrower() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let key = signing_key(8);
    register(&env, &client, &admin, &provider_id, &key);

    let victim = Address::generate(&env);
    let thief = Address::generate(&env);
    let payload = sign(
        &env,
        &client,
        &victim,
        &unsigned_payload(&env, &provider_id, &key, 20, 800, 4),
        &key,
    );

    assert!(client.try_verify_credit_proof(&thief, &payload).is_err());
    assert_nothing_recorded(&client, &thief, &payload);
}

/// A proof signed by provider A cannot be relabelled as coming from
/// provider B, even when both are registered.
#[test]
fn test_proof_cannot_be_relabelled_to_another_provider() {
    let (env, admin, client) = setup_test();

    let provider_a = String::from_str(&env, "zkTLS-Bank");
    let provider_b = String::from_str(&env, "PolygonID-Experian");
    let key_a = signing_key(9);
    let key_b = signing_key(10);
    register(&env, &client, &admin, &provider_a, &key_a);
    register(&env, &client, &admin, &provider_b, &key_b);

    let borrower = Address::generate(&env);
    let mut payload = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_a, &key_a, 21, 800, 4),
        &key_a,
    );
    payload.provider_id = provider_b;

    assert!(client.try_verify_credit_proof(&borrower, &payload).is_err());
    assert_nothing_recorded(&client, &borrower, &payload);
}

/// A proof signed for one verifier deployment does not verify on another.
#[test]
fn test_proof_bound_to_verifier_contract() {
    let (env, admin, client) = setup_test();
    let other_id = env.register(ZkCreditVerifierContract, (&admin,));
    let other = ZkCreditVerifierContractClient::new(&env, &other_id);

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let key = signing_key(11);
    register(&env, &client, &admin, &provider_id, &key);
    register(&env, &other, &admin, &provider_id, &key);

    let borrower = Address::generate(&env);
    let unsigned = unsigned_payload(&env, &provider_id, &key, 22, 800, 4);
    assert_ne!(
        client.proof_digest(&borrower, &unsigned),
        other.proof_digest(&borrower, &unsigned)
    );

    let payload = sign(&env, &client, &borrower, &unsigned, &key);
    assert!(other.try_verify_credit_proof(&borrower, &payload).is_err());
    assert_nothing_recorded(&other, &borrower, &payload);
}

/// Re-registering a provider rotates its key: proofs signed with the old
/// key stop verifying, proofs signed with the new key are accepted.
#[test]
fn test_key_rotation_revokes_old_key() {
    let (env, admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let old_key = signing_key(12);
    let new_key = signing_key(13);
    register(&env, &client, &admin, &provider_id, &old_key);

    let borrower = Address::generate(&env);
    let old_proof = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &old_key, 23, 800, 4),
        &old_key,
    );

    register(&env, &client, &admin, &provider_id, &new_key);
    assert!(client.try_verify_credit_proof(&borrower, &old_proof).is_err());
    assert_nothing_recorded(&client, &borrower, &old_proof);

    let new_proof = sign(
        &env,
        &client,
        &borrower,
        &unsigned_payload(&env, &provider_id, &new_key, 23, 800, 4),
        &new_key,
    );
    assert_eq!(client.verify_credit_proof(&borrower, &new_proof).tier_granted, 4);
}

/// The digest ignores the signature and presented key, so a provider can
/// compute it before signing.
#[test]
fn test_proof_digest_ignores_signature_and_key_fields() {
    let (env, _admin, client) = setup_test();

    let provider_id = String::from_str(&env, "zkTLS-Bank");
    let borrower = Address::generate(&env);
    let a = unsigned_payload(&env, &provider_id, &signing_key(14), 24, 800, 4);
    let mut b = unsigned_payload(&env, &provider_id, &signing_key(15), 24, 800, 4);
    b.proof_bytes = BytesN::from_array(&env, &[0xffu8; 64]);

    assert_eq!(
        client.proof_digest(&borrower, &a),
        client.proof_digest(&borrower, &b)
    );
}
