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
    let rep_id = env.register(BorrowerReputationContract, ());
    let rep = BorrowerReputationContractClient::new(&env, &rep_id);
    rep.initialize(&admin);

    // Lending contract (fee parameter target).
    let lending_id = env.register(LendingContract, ());
    let lending = LendingContractClient::new(&env, &lending_id);
    lending.initialize(&admin);

    // Governance contract, wired to both.
    let gov_id = env.register(GovernanceContract, ());
    let gov = GovernanceContractClient::new(&env, &gov_id);
    gov.initialize(
        &admin,
        &lending_id,
        &rep_id,
        &VOTING_PERIOD,
        &QUORUM,
        &MIN_PROPOSER_POWER,
        &MAX_FEE_BPS,
    );

    // Link: only this governance contract may change the lending fee.
    lending.set_governance(&admin, &gov_id);

    World { env, admin, rep, lending, gov }
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
    let lending_id = env.register(LendingContract, ());
    let lending = LendingContractClient::new(&env, &lending_id);
    lending.initialize(&admin);
    // No set_governance call → no on-chain path to change the fee.
    lending.set_platform_fee_bps(&admin, &200);
}
