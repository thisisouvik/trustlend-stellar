#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

use borrower_reputation::{BorrowerReputationContract, BorrowerReputationContractClient};
use default_management::DefaultManagementContract;
use lending::{LendingContract, LendingContractClient};

const THRESHOLD_2_OF_3: u32 = 2;

struct World<'a> {
    env: Env,
    signers: [Address; 3], // alice, bob, carol
    msig: MultiSigAdminContractClient<'a>,
    lending: LendingContractClient<'a>,
    lending_id: Address,
}

fn setup<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    let signers = [alice.clone(), bob.clone(), carol.clone()];

    let mut signer_vec = Vec::new(&env);
    for s in &signers {
        signer_vec.push_back(s.clone());
    }
    let msig_id = env.register(MultiSigAdminContract, (signer_vec, THRESHOLD_2_OF_3));
    let msig = MultiSigAdminContractClient::new(&env, &msig_id);

    // The lending contract's single admin bootstraps the link to the
    // multisig, then permanently loses direct access to the gated functions.
    let plain_admin = Address::generate(&env);
    let lending_id = env.register(LendingContract, (&plain_admin,));
    let lending = LendingContractClient::new(&env, &lending_id);
    lending.set_multisig_admin(&plain_admin, &msig_id);

    World { env, signers, msig, lending, lending_id }
}

// ─── Init / reads ───────────────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_signers_and_threshold() {
    let w = setup();
    assert_eq!(w.msig.get_threshold(), THRESHOLD_2_OF_3);
    assert_eq!(w.msig.get_signers().len(), 3);
    assert!(w.msig.is_signer(&w.signers[0]));
    assert!(!w.msig.is_signer(&Address::generate(&w.env)));
}

#[test]
#[should_panic(expected = "already initialised")]
fn test_cannot_reinitialize() {
    let w = setup();
    let mut v = Vec::new(&w.env);
    v.push_back(w.signers[0].clone());
    w.msig.initialize(&v, &1);
}

#[test]
fn test_initialize_requires_first_signer_auth() {
    let env = Env::default();
    let signer = Address::generate(&env);
    let mut v = Vec::new(&env);
    v.push_back(signer);
    let msig_id = env.register(MultiSigAdminContract, (v, 1_u32));
    let msig = MultiSigAdminContractClient::new(&env, &msig_id);
    let attacker = Address::generate(&env);
    let mut attacker_v = Vec::new(&env);
    attacker_v.push_back(attacker);
    assert!(msig.try_initialize(&attacker_v, &1).is_err());
}

#[test]
#[should_panic(expected = "Threshold must be between 1 and the number of signers")]
fn test_initialize_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let mut v = Vec::new(&env);
    v.push_back(Address::generate(&env));
    let _msig_id = env.register(MultiSigAdminContract, (v, 0_u32));
}

#[test]
#[should_panic(expected = "Threshold must be between 1 and the number of signers")]
fn test_initialize_rejects_threshold_above_signer_count() {
    let env = Env::default();
    env.mock_all_auths();
    let mut v = Vec::new(&env);
    v.push_back(Address::generate(&env));
    let _msig_id = env.register(MultiSigAdminContract, (v, 2_u32));
}

#[test]
#[should_panic(expected = "Duplicate signer")]
fn test_initialize_rejects_duplicate_signers() {
    let env = Env::default();
    env.mock_all_auths();
    let dup = Address::generate(&env);
    let mut v = Vec::new(&env);
    v.push_back(dup.clone());
    v.push_back(dup);
    let _msig_id = env.register(MultiSigAdminContract, (v, 1_u32));
}

// ─── Core sequence: propose → approve (N times, distinct wallets) → execute ──────

#[test]
fn test_full_approval_sequence_whitelists_asset() {
    let w = setup();
    let asset = Address::generate(&w.env);
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();

    // 1. Alice proposes (her proposal counts as her own approval).
    let id = w.msig.propose(&alice, &AdminAction::WhitelistAsset(w.lending_id.clone(), asset.clone()));
    assert_eq!(id, 1);
    assert!(w.msig.has_approved(&id, &alice));
    assert!(!w.lending.is_asset_whitelisted(&asset));

    // Not enough approvals yet (threshold is 2).
    let before = w.msig.get_proposal(&id);
    assert_eq!(before.approvals.len(), 1);
    assert_eq!(before.status, ProposalStatus::Active);

    // 2. In a SEPARATE transaction, Bob — a distinct wallet — approves.
    w.msig.approve(&bob, &id);
    assert!(w.msig.has_approved(&id, &bob));

    // 3. Threshold (2-of-3) now met — anyone may execute.
    w.msig.execute(&id);

    let after = w.msig.get_proposal(&id);
    assert_eq!(after.status, ProposalStatus::Executed);
    assert!(w.lending.is_asset_whitelisted(&asset));
}

#[test]
#[should_panic(expected = "Insufficient approvals")]
fn test_execute_fails_before_threshold_met() {
    let w = setup();
    let asset = Address::generate(&w.env);
    let id = w
        .msig
        .propose(&w.signers[0], &AdminAction::WhitelistAsset(w.lending_id.clone(), asset));
    // Only 1 of 3 signers has approved (the proposer) — threshold is 2.
    w.msig.execute(&id);
}

#[test]
fn test_setting_flash_loan_fee_via_multisig() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();

    assert_eq!(w.lending.get_flash_loan_fee_bps(), 9); // default

    let id = w
        .msig
        .propose(&alice, &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 75));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);

    assert_eq!(w.lending.get_flash_loan_fee_bps(), 75);
}

#[test]
fn test_setting_governance_via_multisig() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let governance_addr = Address::generate(&w.env); // stand-in address is enough here

    let id = w
        .msig
        .propose(&alice, &AdminAction::SetGovernance(w.lending_id.clone(), governance_addr.clone()));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);

    assert_eq!(w.lending.get_governance(), governance_addr);
}

#[test]
fn test_setting_oracle_via_multisig() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();

    let rep_admin = Address::generate(&w.env);
    let rep_id = w.env.register(BorrowerReputationContract, (&rep_admin,));
    let rep = BorrowerReputationContractClient::new(&w.env, &rep_id);
    rep.set_multisig_admin(&rep_admin, &w.msig.address);

    let oracle_addr = Address::generate(&w.env);
    let id = w
        .msig
        .propose(&alice, &AdminAction::SetOracle(rep_id.clone(), oracle_addr.clone()));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);

    assert_eq!(rep.get_oracle(), oracle_addr);
}

#[test]
fn test_insurance_fund_add_and_payout_via_multisig() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();

    let dm_admin = Address::generate(&w.env);
    let dm_id = w.env.register(DefaultManagementContract, (&dm_admin, &0_i128));
    let dm = default_management::DefaultManagementContractClient::new(&w.env, &dm_id);
    dm.set_multisig_admin(&dm_admin, &w.msig.address);

    // Fund the pool.
    let add_id = w
        .msig
        .propose(&alice, &AdminAction::AddToInsurance(dm_id.clone(), 1_000_0000000));
    w.msig.approve(&bob, &add_id);
    w.msig.execute(&add_id);
    assert_eq!(dm.get_insurance_balance(), 1_000_0000000);

    // Pay a lender out of the pool ("withdrawing protocol fees").
    let lender = Address::generate(&w.env);
    let payout_id = w.msig.propose(
        &alice,
        &AdminAction::TriggerInsurancePayout(dm_id.clone(), 42, lender.clone(), 300_0000000),
    );
    w.msig.approve(&bob, &payout_id);
    w.msig.execute(&payout_id);

    assert_eq!(dm.get_insurance_balance(), 700_0000000);
    assert_eq!(dm.get_insurance_event_count(), 1);
    let event = dm.get_insurance_event(&1);
    assert_eq!(event.loan_id, 42);
    assert_eq!(event.lender, lender);
    assert_eq!(event.amount_paid, 300_0000000);
}

// ─── The security property this whole issue is about ───────────────────────────

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_direct_call_by_the_original_admin_is_rejected() {
    let w = setup();
    // Even the ORIGINAL single admin — the one who bootstrapped the link in
    // the first place — can no longer call the gated function directly.
    // There is only one path now: propose → N approvals → execute.
    let plain_admin = w.lending.get_admin();
    w.lending.whitelist_asset(&plain_admin, &Address::generate(&w.env));
}

#[test]
#[should_panic(expected = "Multisig admin already configured")]
fn test_multisig_link_cannot_be_reconfigured() {
    let w = setup();
    let admin = w.lending.get_admin();
    let another_msig = Address::generate(&w.env);
    // The admin cannot quietly point the contract at a DIFFERENT multisig
    // (e.g. one they solely control) after the fact.
    w.lending.set_multisig_admin(&admin, &another_msig);
}

// ─── Approval bookkeeping ────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "not an authorised multisig signer")]
fn test_non_signer_cannot_propose() {
    let w = setup();
    let outsider = Address::generate(&w.env);
    w.msig.propose(&outsider, &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 20));
}

#[test]
#[should_panic(expected = "not an authorised multisig signer")]
fn test_non_signer_cannot_approve() {
    let w = setup();
    let outsider = Address::generate(&w.env);
    let id = w
        .msig
        .propose(&w.signers[0], &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 20));
    w.msig.approve(&outsider, &id);
}

#[test]
#[should_panic(expected = "already approved")]
fn test_signer_cannot_approve_twice() {
    let w = setup();
    let id = w
        .msig
        .propose(&w.signers[0], &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 20));
    w.msig.approve(&w.signers[1], &id);
    w.msig.approve(&w.signers[1], &id);
}

#[test]
fn test_revoke_approval_drops_below_threshold() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let id = w
        .msig
        .propose(&alice, &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 20));
    w.msig.approve(&bob, &id);
    assert_eq!(w.msig.get_proposal(&id).approvals.len(), 2);

    w.msig.revoke_approval(&bob, &id);
    assert_eq!(w.msig.get_proposal(&id).approvals.len(), 1);
    assert!(!w.msig.has_approved(&id, &bob));
}

#[test]
#[should_panic(expected = "Insufficient approvals")]
fn test_execute_fails_after_a_revoked_approval() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let id = w
        .msig
        .propose(&alice, &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 20));
    w.msig.approve(&bob, &id);
    w.msig.revoke_approval(&bob, &id);
    w.msig.execute(&id);
}

#[test]
#[should_panic(expected = "Only the proposer can cancel")]
fn test_only_proposer_can_cancel() {
    let w = setup();
    let id = w
        .msig
        .propose(&w.signers[0], &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 20));
    w.msig.cancel(&w.signers[1], &id);
}

#[test]
#[should_panic(expected = "Proposal is not active")]
fn test_cannot_approve_a_cancelled_proposal() {
    let w = setup();
    let id = w
        .msig
        .propose(&w.signers[0], &AdminAction::SetFlashLoanFeeBps(w.lending_id.clone(), 20));
    w.msig.cancel(&w.signers[0], &id);
    w.msig.approve(&w.signers[1], &id);
}

#[test]
#[should_panic(expected = "Proposal is not active")]
fn test_cannot_execute_an_already_executed_proposal_twice() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let asset = Address::generate(&w.env);
    let id = w
        .msig
        .propose(&alice, &AdminAction::WhitelistAsset(w.lending_id.clone(), asset));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);
    w.msig.execute(&id); // replay attempt
}

// ─── Signer-set self-management (also propose → approve → execute) ─────────────────

#[test]
fn test_add_signer_via_self_governance() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let dave = Address::generate(&w.env);

    let id = w.msig.propose(&alice, &AdminAction::AddSigner(dave.clone()));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);

    assert!(w.msig.is_signer(&dave));
    assert_eq!(w.msig.get_signers().len(), 4);
}

#[test]
fn test_remove_signer_via_self_governance() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let carol = w.signers[2].clone();

    let id = w.msig.propose(&alice, &AdminAction::RemoveSigner(carol.clone()));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);

    assert!(!w.msig.is_signer(&carol));
    assert_eq!(w.msig.get_signers().len(), 2);
}

#[test]
#[should_panic(expected = "would make the threshold unreachable")]
fn test_cannot_remove_signer_below_threshold() {
    let w = setup(); // 3 signers, threshold 2
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let carol = w.signers[2].clone();

    // Remove carol → 2 signers, threshold 2, still OK.
    let id1 = w.msig.propose(&alice, &AdminAction::RemoveSigner(carol));
    w.msig.approve(&bob, &id1);
    w.msig.execute(&id1);
    assert_eq!(w.msig.get_signers().len(), 2);

    // Removing bob next would leave 1 signer < threshold 2 — must be rejected.
    let id2 = w.msig.propose(&alice, &AdminAction::RemoveSigner(bob.clone()));
    w.msig.approve(&bob, &id2);
    w.msig.execute(&id2);
}

#[test]
fn test_set_threshold_via_self_governance() {
    let w = setup();
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();

    let id = w.msig.propose(&alice, &AdminAction::SetThreshold(3));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);

    assert_eq!(w.msig.get_threshold(), 3);
}

#[test]
#[should_panic(expected = "Threshold must be between 1 and the number of signers")]
fn test_set_threshold_rejects_value_above_signer_count() {
    let w = setup(); // 3 signers
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();

    let id = w.msig.propose(&alice, &AdminAction::SetThreshold(4));
    w.msig.approve(&bob, &id);
    w.msig.execute(&id);
}

// ─── A raised threshold changes what "enough approvals" means going forward ─────

#[test]
fn test_raising_threshold_requires_more_approvals_for_future_proposals() {
    let w = setup(); // starts at 2-of-3
    let alice = w.signers[0].clone();
    let bob = w.signers[1].clone();
    let carol = w.signers[2].clone();

    // Raise threshold to 3-of-3.
    let raise_id = w.msig.propose(&alice, &AdminAction::SetThreshold(3));
    w.msig.approve(&bob, &raise_id);
    w.msig.execute(&raise_id);
    assert_eq!(w.msig.get_threshold(), 3);

    // A NEW proposal now needs all three signers.
    let asset = Address::generate(&w.env);
    let id = w
        .msig
        .propose(&alice, &AdminAction::WhitelistAsset(w.lending_id.clone(), asset.clone()));
    w.msig.approve(&bob, &id);

    // Still only 2 of 3 — must fail now.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.msig.execute(&id);
    }));
    assert!(result.is_err());
    assert!(!w.lending.is_asset_whitelisted(&asset));

    // The third approval clears it.
    w.msig.approve(&carol, &id);
    w.msig.execute(&id);
    assert!(w.lending.is_asset_whitelisted(&asset));
}
