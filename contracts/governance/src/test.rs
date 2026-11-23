#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

use borrower_reputation::{
    BorrowerReputationContract, BorrowerReputationContractClient, ReputationEvent,
};
use lending::{LendingContract, LendingContractClient};

const VOTING_PERIOD: u64 = 1_000;
const QUORUM: i128 = 100;
const MIN_PROPOSER_POWER: i128 = 50;
const MAX_FEE_BPS: u32 = 1_000;
const TIMELOCK_DELAY: u64 = 86_400; // 24 hours

struct World<'a> {
    env: Env,
    admin: Address,
    rep: BorrowerReputationContractClient<'a>,
    lending: LendingContractClient<'a>,
    gov: GovernanceContractClient<'a>,
}

fn setup<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    // Reputation contract (voting power source).
    let rep_id = env.register(BorrowerReputationContract, (&admin,));
    let rep = BorrowerReputationContractClient::new(&env, &rep_id);

    // Lending contract (fee parameter target).
    let lending_id = env.register(LendingContract, (&admin,));
    let lending = LendingContractClient::new(&env, &lending_id);
    // `set_governance` is multisig-gated (see the `multisig_admin` crate);
    // `admin` stands in as its own "multisig" here since this suite is
    // testing DAO voting, not the multisig approval flow itself.
    lending.set_multisig_admin(&admin, &admin);

    // Governance contract, wired to both.
    let gov_id = env.register(
        GovernanceContract,
        (
            &admin,
            &lending_id,
            &rep_id,
            &VOTING_PERIOD,
            &QUORUM,
            &MIN_PROPOSER_POWER,
            &MAX_FEE_BPS,
            &TIMELOCK_DELAY,
        ),
    );
    let gov = GovernanceContractClient::new(&env, &gov_id);

    // Link: only this governance contract may change the lending fee.
    lending.set_governance(&admin, &gov_id);

    World {
        env,
        admin,
        rep,
        lending,
        gov,
    }
}

/// Give `who` a reputation profile worth `events * 50` points.
fn give_score(w: &World, who: &Address, events: u32) {
    w.rep.init_borrower(who);
    for _ in 0..events {
        w.rep
            .add_reputation_event(&w.admin, who, &ReputationEvent::TestLoanRepaid);
    }
}

fn advance_past_voting(w: &World) {
    let now = w.env.ledger().timestamp();
    w.env.ledger().set_timestamp(now + VOTING_PERIOD + 1);
}

fn advance_past_timelock(w: &World) {
    let now = w.env.ledger().timestamp();
    w.env.ledger().set_timestamp(now + TIMELOCK_DELAY + 1);
}

#[test]
fn test_default_fee_is_100_bps() {
    let w = setup();
    assert_eq!(w.lending.get_platform_fee_bps(), 100);
}

#[test]
fn test_full_fee_change_flow() {
    let w = setup();
    let alice = Address::generate(&w.env); // power 500
    let bob = Address::generate(&w.env); // power 100
    give_score(&w, &alice, 10);
    give_score(&w, &bob, 2);

    assert_eq!(w.gov.get_voting_power(&alice), 500);

    // Alice proposes lowering... actually raising the fee to 2.5 %.
    let id = w.gov.propose_fee_change(&alice, &250);
    assert_eq!(id, 1);

    w.gov.vote(&alice, &id, &true);
    w.gov.vote(&bob, &id, &true);

    let p = w.gov.get_proposal(&id);
    assert_eq!(p.votes_for, 600);
    assert_eq!(p.votes_against, 0);

    advance_past_voting(&w);
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Passed);

    // Fee unchanged until executed.
    assert_eq!(w.lending.get_platform_fee_bps(), 100);

    // Advance past execution timelock delay
    advance_past_timelock(&w);
    w.gov.execute(&id);
    assert_eq!(w.lending.get_platform_fee_bps(), 250);
    assert_eq!(w.gov.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn test_rejected_when_against_wins() {
    let w = setup();
    let alice = Address::generate(&w.env); // 500 against
    let bob = Address::generate(&w.env); // 100 for
    give_score(&w, &alice, 10);
    give_score(&w, &bob, 2);

    let id = w.gov.propose_fee_change(&bob, &300);
    w.gov.vote(&bob, &id, &true); // 100 for
    w.gov.vote(&alice, &id, &false); // 500 against

    advance_past_voting(&w);
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Rejected);
    // Fee stays at default.
    assert_eq!(w.lending.get_platform_fee_bps(), 100);
}

#[test]
fn test_rejected_when_quorum_not_met() {
    let w = setup();
    // Single small voter: power 50 < QUORUM 100.
    let solo = Address::generate(&w.env);
    give_score(&w, &solo, 1);

    let id = w.gov.propose_fee_change(&solo, &200);
    w.gov.vote(&solo, &id, &true); // 50 for, total 50 < quorum

    advance_past_voting(&w);
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Rejected);
}

#[test]
#[should_panic(expected = "Only PASSED")]
fn test_execute_requires_passed() {
    let w = setup();
    let alice = Address::generate(&w.env);
    give_score(&w, &alice, 10);
    let id = w.gov.propose_fee_change(&alice, &250);
    // Not finalized/passed yet.
    w.gov.execute(&id);
}

#[test]
#[should_panic(expected = "already voted")]
fn test_double_vote_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    give_score(&w, &alice, 10);
    let id = w.gov.propose_fee_change(&alice, &250);
    w.gov.vote(&alice, &id, &true);
    w.gov.vote(&alice, &id, &true);
}

#[test]
#[should_panic(expected = "Voting period has ended")]
fn test_vote_after_period_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    give_score(&w, &alice, 10);
    let id = w.gov.propose_fee_change(&alice, &250);
    advance_past_voting(&w);
    w.gov.vote(&alice, &id, &true);
}

#[test]
#[should_panic(expected = "No voting power")]
fn test_vote_without_power_panics() {
    let w = setup();
    let alice = Address::generate(&w.env); // proposer with power
    give_score(&w, &alice, 10);
    let nobody = Address::generate(&w.env); // no reputation profile
    let id = w.gov.propose_fee_change(&alice, &250);
    w.gov.vote(&nobody, &id, &true);
}

#[test]
#[should_panic(expected = "Insufficient reputation to propose")]
fn test_propose_requires_min_power() {
    let w = setup();
    let weak = Address::generate(&w.env); // no profile → power 0 < 50
    w.gov.propose_fee_change(&weak, &250);
}

#[test]
#[should_panic(expected = "exceeds max_fee_bps")]
fn test_propose_above_cap_rejected() {
    let w = setup();
    let alice = Address::generate(&w.env);
    give_score(&w, &alice, 10);
    w.gov.propose_fee_change(&alice, &2_000); // > MAX_FEE_BPS (1000)
}

#[test]
#[should_panic(expected = "only Governance")]
fn test_lending_rejects_non_governance_caller() {
    let w = setup();
    let attacker = Address::generate(&w.env);
    // Direct call bypassing a vote must fail.
    w.lending.set_platform_fee_bps(&attacker, &500);
}

#[test]
#[should_panic(expected = "Governance not configured")]
fn test_lending_fee_change_blocked_without_governance() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let lending_id = env.register(LendingContract, (&admin,));
    let lending = LendingContractClient::new(&env, &lending_id);
    // No set_governance call → no on-chain path to change the fee.
    lending.set_platform_fee_bps(&admin, &200);
}

/// Issue #352: initialization runs in the Soroban constructor, atomically with
/// deployment. There is no `initialize` entrypoint left to front-run, and the
/// constructor cannot be re-invoked on the live contract to seize admin rights.
#[test]
fn test_constructor_initializes_and_cannot_be_reinvoked() {
    use soroban_sdk::{IntoVal, Symbol};
    let w = setup();
    let env = w.env.clone();
    let admin = w.admin.clone();
    assert_eq!(w.gov.get_config().admin, admin);
    let attacker = Address::generate(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        attacker.into_val(&env),
        w.lending.address.into_val(&env),
        w.rep.address.into_val(&env),
        1u64.into_val(&env),
        0i128.into_val(&env),
        0i128.into_val(&env),
        10_000u32.into_val(&env),
        TIMELOCK_DELAY.into_val(&env),
    ];
    for name in ["initialize", "__constructor"] {
        let res = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &w.gov.address,
            &Symbol::new(&env, name),
            args.clone(),
        );
        assert!(res.is_err(), "{name} must not be callable after deployment");
    }
    assert_eq!(w.gov.get_config().admin, admin);
}

#[test]
#[should_panic(expected = "Proposal timelock has not expired")]
fn test_execute_before_timelock_expires_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    give_score(&w, &alice, 10);
    let id = w.gov.propose_fee_change(&alice, &250);
    w.gov.vote(&alice, &id, &true);
    advance_past_voting(&w);
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Passed);

    // Attempting to execute before timelock expiry must panic
    w.gov.execute(&id);
}

#[test]
fn test_timelock_expiry_helper_query() {
    let w = setup();
    let alice = Address::generate(&w.env);
    give_score(&w, &alice, 10);
    let id = w.gov.propose_fee_change(&alice, &250);
    assert!(!w.gov.is_timelock_expired(&id));

    w.gov.vote(&alice, &id, &true);
    advance_past_voting(&w);
    assert_eq!(w.gov.finalize(&id), ProposalStatus::Passed);

    // Timelock not yet expired immediately after finalize
    assert!(!w.gov.is_timelock_expired(&id));

    // Advance past timelock
    advance_past_timelock(&w);
    assert!(w.gov.is_timelock_expired(&id));

    // After execution, status is Executed, is_timelock_expired returns false
    w.gov.execute(&id);
    assert!(!w.gov.is_timelock_expired(&id));
}

#[test]
fn test_voting_power_checkpointing_blocks_flash_reputation() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let bob = Address::generate(&w.env);

    // Set initial ledger 100
    w.env.ledger().with_mut(|l| l.sequence_number = 100);
    give_score(&w, &alice, 2); // 100 power
    give_score(&w, &bob, 1); // 50 power

    // Alice creates proposal at ledger 100
    let id = w.gov.propose_fee_change(&alice, &250);
    let p = w.gov.get_proposal(&id);
    assert_eq!(p.snapshot_ledger, 100);

    // Later at ledger 150 (during active voting period), Bob tries flash-reputation manipulation:
    // inflates his reputation score by 200 points (to 250)
    w.env.ledger().with_mut(|l| l.sequence_number = 150);
    for _ in 0..4 {
        w.rep
            .add_reputation_event(&w.admin, &bob, &ReputationEvent::TestLoanRepaid);
    }
    assert_eq!(w.rep.get_reputation_score(&bob), 250);
    assert_eq!(w.gov.get_voting_power(&bob), 250);

    // But his snapshot power at proposal creation ledger 100 is still 50!
    assert_eq!(w.gov.get_voting_power_at(&bob, &p.snapshot_ledger), 50);

    // Bob votes on proposal: voting power must be 50, not 250!
    w.gov.vote(&bob, &id, &true);
    let p_after = w.gov.get_proposal(&id);
    assert_eq!(p_after.votes_for, 50);
}

#[test]
#[should_panic(expected = "No voting power")]
fn test_zero_snapshot_voting_power_rejected() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let eve = Address::generate(&w.env);

    // Ledger 100: Alice has reputation, Eve does not
    w.env.ledger().with_mut(|l| l.sequence_number = 100);
    give_score(&w, &alice, 2);
    let id = w.gov.propose_fee_change(&alice, &250);

    // Ledger 150: Eve tries to gain score after proposal creation to manipulate vote
    w.env.ledger().with_mut(|l| l.sequence_number = 150);
    give_score(&w, &eve, 5); // 250 score at ledger 150
    assert_eq!(w.rep.get_reputation_score(&eve), 250);

    // Voting on proposal snapshotted at ledger 100 must fail because Eve had 0 at ledger 100
    w.gov.vote(&eve, &id, &true);
}

#[test]
#[should_panic(expected = "timelock_delay_secs must be positive")]
fn test_constructor_rejects_zero_timelock() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let lending_id = Address::generate(&env);
    let rep_id = Address::generate(&env);
    env.register(
        GovernanceContract,
        (
            &admin,
            &lending_id,
            &rep_id,
            &VOTING_PERIOD,
            &QUORUM,
            &MIN_PROPOSER_POWER,
            &MAX_FEE_BPS,
            &0u64,
        ),
    );
}
