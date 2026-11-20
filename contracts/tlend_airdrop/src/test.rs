#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, String};

use tlend_token::{TlendTokenContract, TlendTokenContractClient};

/// Combine two leaf/node hashes the same sorted-pair way the contract does,
/// so tests can build a real Merkle tree and matching proofs.
fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let (first, second) = if a <= b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
    let mut combined = Bytes::from(first);
    combined.append(&Bytes::from(second));
    env.crypto().sha256(&combined).into()
}

struct World<'a> {
    env: Env,
    admin: Address,
    token: TlendTokenContractClient<'a>,
    airdrop: TlendAirdropContractClient<'a>,
    c0: Address,
    c1: Address,
    c2: Address,
    c3: Address,
    proof0: Vec<BytesN<32>>,
    proof1: Vec<BytesN<32>>,
    proof2: Vec<BytesN<32>>,
    proof3: Vec<BytesN<32>>,
    root: BytesN<32>,
}

const AMOUNTS: [i128; 4] = [100, 200, 300, 400];

fn setup<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let token_id = env.register(TlendTokenContract, ());
    let token = TlendTokenContractClient::new(&env, &token_id);
    token.initialize(
        &admin,
        &7,
        &String::from_str(&env, "TrustLend"),
        &String::from_str(&env, "TLEND"),
    );
    token.mint(&admin, &1_000_000);

    let airdrop_id = env.register(TlendAirdropContract, ());
    let airdrop = TlendAirdropContractClient::new(&env, &airdrop_id);

    let c0 = Address::generate(&env);
    let c1 = Address::generate(&env);
    let c2 = Address::generate(&env);
    let c3 = Address::generate(&env);

    // leaf_hash_for is a pure view — callable before initialize.
    let leaf0 = airdrop.leaf_hash_for(&c0, &AMOUNTS[0]);
    let leaf1 = airdrop.leaf_hash_for(&c1, &AMOUNTS[1]);
    let leaf2 = airdrop.leaf_hash_for(&c2, &AMOUNTS[2]);
    let leaf3 = airdrop.leaf_hash_for(&c3, &AMOUNTS[3]);

    let node01 = hash_pair(&env, &leaf0, &leaf1);
    let node23 = hash_pair(&env, &leaf2, &leaf3);
    let root = hash_pair(&env, &node01, &node23);

    let proof0 = vec![&env, leaf1.clone(), node23.clone()];
    let proof1 = vec![&env, leaf0.clone(), node23.clone()];
    let proof2 = vec![&env, leaf3.clone(), node01.clone()];
    let proof3 = vec![&env, leaf2.clone(), node01.clone()];

    airdrop.initialize(&admin, &token_id, &root);
    airdrop.fund(&admin, &1_000);

    World {
        env,
        admin,
        token,
        airdrop,
        c0,
        c1,
        c2,
        c3,
        proof0,
        proof1,
        proof2,
        proof3,
        root,
    }
}

#[test]
fn test_valid_claim_succeeds() {
    let w = setup();
    w.airdrop.claim(&w.c0, &AMOUNTS[0], &w.proof0);

    assert_eq!(w.token.balance(&w.c0), AMOUNTS[0]);
    assert!(w.airdrop.has_claimed(&w.c0));
}

#[test]
fn test_all_leaves_claimable() {
    let w = setup();
    w.airdrop.claim(&w.c0, &AMOUNTS[0], &w.proof0);
    w.airdrop.claim(&w.c1, &AMOUNTS[1], &w.proof1);
    w.airdrop.claim(&w.c2, &AMOUNTS[2], &w.proof2);
    w.airdrop.claim(&w.c3, &AMOUNTS[3], &w.proof3);

    assert_eq!(w.token.balance(&w.c0), 100);
    assert_eq!(w.token.balance(&w.c1), 200);
    assert_eq!(w.token.balance(&w.c2), 300);
    assert_eq!(w.token.balance(&w.c3), 400);
    assert_eq!(w.token.balance(&w.airdrop.address), 0);
}

#[test]
#[should_panic(expected = "Already claimed")]
fn test_double_claim_panics() {
    let w = setup();
    w.airdrop.claim(&w.c0, &AMOUNTS[0], &w.proof0);
    w.airdrop.claim(&w.c0, &AMOUNTS[0], &w.proof0);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn test_wrong_amount_panics() {
    let w = setup();
    w.airdrop.claim(&w.c0, &(AMOUNTS[0] + 1), &w.proof0);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn test_swapped_proof_panics() {
    let w = setup();
    // c0's amount with c1's proof — leaf won't match, verification must fail.
    w.airdrop.claim(&w.c0, &AMOUNTS[0], &w.proof1);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn test_non_eligible_address_panics() {
    let w = setup();
    let outsider = Address::generate(&w.env);
    w.airdrop.claim(&outsider, &AMOUNTS[0], &w.proof0);
}

#[test]
#[should_panic(expected = "Invalid Merkle proof")]
fn test_root_rotation_invalidates_old_proofs() {
    let w = setup();
    let fresh_root: BytesN<32> = w.env.crypto().sha256(&Bytes::from_array(&w.env, &[7u8; 1])).into();

    w.airdrop.set_merkle_root(&w.admin, &fresh_root);
    assert_eq!(w.airdrop.get_merkle_root(), fresh_root);
    assert_ne!(fresh_root, w.root);

    // Proof was valid under the old root only.
    w.airdrop.claim(&w.c0, &AMOUNTS[0], &w.proof0);
}

#[test]
#[should_panic(expected = "not admin")]
fn test_non_admin_cannot_set_root() {
    let w = setup();
    let attacker = Address::generate(&w.env);
    w.airdrop.set_merkle_root(&attacker, &w.root);
}

// ─── Unclaimed token recovery (Issue #422) ───────────────────────────────────

use soroban_sdk::testutils::Ledger as _;

const DEADLINE: u64 = 1_000_000;

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| li.timestamp = timestamp);
}

/// Opens a claim window ending at `DEADLINE`, then lets c0 and c1 claim
/// (300 of the 1,000 funded), leaving 700 unclaimed.
fn setup_partially_claimed<'a>() -> World<'a> {
    let w = setup();
    w.airdrop.set_claim_deadline(&w.admin, &DEADLINE);
    w.airdrop.claim(&w.c0, &AMOUNTS[0], &w.proof0);
    w.airdrop.claim(&w.c1, &AMOUNTS[1], &w.proof1);
    assert_eq!(w.airdrop.get_unclaimed_balance(), 700);
    w
}

#[test]
fn test_admin_sweeps_unclaimed_tokens_after_deadline() {
    let w = setup_partially_claimed();
    let treasury = Address::generate(&w.env);

    set_time(&w.env, DEADLINE + 1);
    w.airdrop.sweep_unclaimed(&w.admin, &treasury, &700);

    assert_eq!(w.token.balance(&treasury), 700);
    assert_eq!(w.airdrop.get_unclaimed_balance(), 0);
    // Claimed balances are untouched.
    assert_eq!(w.token.balance(&w.c0), AMOUNTS[0]);
    assert_eq!(w.token.balance(&w.c1), AMOUNTS[1]);
}

#[test]
fn test_multisig_admin_can_sweep() {
    let w = setup_partially_claimed();
    let multisig = Address::generate(&w.env);
    let treasury = Address::generate(&w.env);

    w.airdrop.set_multisig_admin(&w.admin, &multisig);
    assert_eq!(w.airdrop.get_multisig_admin(), Some(multisig.clone()));

    set_time(&w.env, DEADLINE + 1);
    w.airdrop.sweep_unclaimed(&multisig, &treasury, &700);
    assert_eq!(w.token.balance(&treasury), 700);
}

#[test]
fn test_partial_sweep_leaves_remainder() {
    let w = setup_partially_claimed();
    let treasury = Address::generate(&w.env);

    set_time(&w.env, DEADLINE + 1);
    w.airdrop.sweep_unclaimed(&w.admin, &treasury, &250);
    assert_eq!(w.token.balance(&treasury), 250);
    assert_eq!(w.airdrop.get_unclaimed_balance(), 450);

    w.airdrop.sweep_unclaimed(&w.admin, &treasury, &450);
    assert_eq!(w.token.balance(&treasury), 700);
    assert_eq!(w.airdrop.get_unclaimed_balance(), 0);
}

#[test]
#[should_panic(expected = "not admin or multisig")]
fn test_non_admin_cannot_sweep() {
    let w = setup_partially_claimed();
    let attacker = Address::generate(&w.env);

    set_time(&w.env, DEADLINE + 1);
    w.airdrop.sweep_unclaimed(&attacker, &attacker, &700);
}

#[test]
#[should_panic(expected = "Claim period still active")]
fn test_cannot_sweep_before_deadline() {
    let w = setup_partially_claimed();
    // Still inside the window: the deadline itself is the last claimable moment.
    set_time(&w.env, DEADLINE);
    w.airdrop.sweep_unclaimed(&w.admin, &w.admin, &700);
}

#[test]
#[should_panic(expected = "Claim deadline not set")]
fn test_cannot_sweep_without_deadline() {
    let w = setup();
    w.airdrop.sweep_unclaimed(&w.admin, &w.admin, &1_000);
}

#[test]
#[should_panic(expected = "amount exceeds unclaimed balance")]
fn test_cannot_sweep_more_than_balance() {
    let w = setup_partially_claimed();
    set_time(&w.env, DEADLINE + 1);
    w.airdrop.sweep_unclaimed(&w.admin, &w.admin, &701);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_cannot_sweep_zero() {
    let w = setup_partially_claimed();
    set_time(&w.env, DEADLINE + 1);
    w.airdrop.sweep_unclaimed(&w.admin, &w.admin, &0);
}

#[test]
fn test_claim_allowed_up_to_deadline() {
    let w = setup_partially_claimed();
    set_time(&w.env, DEADLINE);
    w.airdrop.claim(&w.c2, &AMOUNTS[2], &w.proof2);
    assert_eq!(w.token.balance(&w.c2), AMOUNTS[2]);
}

#[test]
#[should_panic(expected = "Claim period has ended")]
fn test_claim_rejected_after_deadline() {
    let w = setup_partially_claimed();
    set_time(&w.env, DEADLINE + 1);
    w.airdrop.claim(&w.c2, &AMOUNTS[2], &w.proof2);
}

#[test]
fn test_claim_deadline_can_be_extended() {
    let w = setup();
    w.airdrop.set_claim_deadline(&w.admin, &DEADLINE);
    w.airdrop.set_claim_deadline(&w.admin, &(DEADLINE * 2));
    assert_eq!(w.airdrop.get_claim_deadline(), Some(DEADLINE * 2));
}

#[test]
#[should_panic(expected = "Deadline can only be extended")]
fn test_claim_deadline_cannot_be_shortened() {
    let w = setup();
    w.airdrop.set_claim_deadline(&w.admin, &DEADLINE);
    w.airdrop.set_claim_deadline(&w.admin, &(DEADLINE - 1));
}

#[test]
#[should_panic(expected = "Deadline must be in the future")]
fn test_claim_deadline_must_be_in_future() {
    let w = setup();
    set_time(&w.env, DEADLINE);
    w.airdrop.set_claim_deadline(&w.admin, &DEADLINE);
}

#[test]
#[should_panic(expected = "not admin")]
fn test_non_admin_cannot_set_claim_deadline() {
    let w = setup();
    let attacker = Address::generate(&w.env);
    w.airdrop.set_claim_deadline(&attacker, &DEADLINE);
}

#[test]
#[should_panic(expected = "not admin")]
fn test_non_admin_cannot_set_multisig_admin() {
    let w = setup();
    let attacker = Address::generate(&w.env);
    w.airdrop.set_multisig_admin(&attacker, &attacker);
}

#[test]
#[should_panic(expected = "Multisig admin already configured")]
fn test_multisig_admin_set_once() {
    let w = setup();
    let multisig = Address::generate(&w.env);
    w.airdrop.set_multisig_admin(&w.admin, &multisig);
    w.airdrop.set_multisig_admin(&w.admin, &multisig);
}
