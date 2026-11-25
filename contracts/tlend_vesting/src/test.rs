#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::String;

use tlend_token::{TlendTokenContract, TlendTokenContractClient};

const TOTAL_SUPPLY: i128 = 1_000_000_000;

struct World<'a> {
    env: Env,
    admin: Address,
    token: TlendTokenContractClient<'a>,
    vesting: TlendVestingContractClient<'a>,
}

fn setup<'a>() -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let token_id = env.register(
        TlendTokenContract,
        (&admin, 7_u32, String::from_str(&env, "TrustLend"), String::from_str(&env, "TLEND")),
    );
    let token = TlendTokenContractClient::new(&env, &token_id);
    token.mint(&admin, &TOTAL_SUPPLY);

    let vesting_id = env.register(TlendVestingContract, (&admin, &token_id));
    let vesting = TlendVestingContractClient::new(&env, &vesting_id);

    World { env, admin, token, vesting }
}

fn now(w: &World) -> u64 {
    w.env.ledger().timestamp()
}

fn advance_to(w: &World, ts: u64) {
    w.env.ledger().with_mut(|l| l.timestamp = ts);
}

#[test]
fn test_create_schedule_escrows_tokens() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::Team,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: 1_000,
            revocable: true,
        },
    );

    assert_eq!(w.token.balance(&w.admin), TOTAL_SUPPLY - 1_000);
    assert_eq!(w.token.balance(&w.vesting.address), 1_000);
    assert_eq!(w.vesting.vested_amount(&alice), 0);
}

#[test]
#[should_panic(expected = "already has a vesting schedule")]
fn test_duplicate_schedule_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::EarlyLender,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: 1_000,
            revocable: false,
        },
    );
    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::EarlyLender,
        &500,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: 1_000,
            revocable: false,
        },
    );
}

#[test]
#[should_panic(expected = "cliff_secs cannot exceed duration_secs")]
fn test_cliff_greater_than_duration_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::Team,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 2_000,
            duration_secs: 1_000,
            revocable: false,
        },
    );
}

#[test]
#[should_panic]
fn test_non_admin_cannot_create_schedule() {
    let w = setup();
    let attacker = Address::generate(&w.env);
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &attacker,
        &alice,
        &BeneficiaryCategory::Team,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: 1_000,
            revocable: false,
        },
    );
}

#[test]
#[should_panic(expected = "Nothing to claim")]
fn test_claim_before_cliff_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::EarlyBorrower,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 500,
            duration_secs: 1_000,
            revocable: false,
        },
    );
    // Still before the cliff.
    advance_to(&w, start + 100);
    w.vesting.claim(&alice);
}

#[test]
fn test_partial_then_full_vesting_claims() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);
    let duration = 1_000u64;

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::Team,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: duration,
            revocable: true,
        },
    );

    // Halfway through: ~half should be vested and claimable.
    advance_to(&w, start + duration / 2);
    assert_eq!(w.vesting.vested_amount(&alice), 500);
    let claimed = w.vesting.claim(&alice);
    assert_eq!(claimed, 500);
    assert_eq!(w.token.balance(&alice), 500);
    assert_eq!(w.vesting.claimable_amount(&alice), 0);

    // Past the full duration: remainder should be claimable.
    advance_to(&w, start + duration + 1);
    assert_eq!(w.vesting.vested_amount(&alice), 1_000);
    let claimed2 = w.vesting.claim(&alice);
    assert_eq!(claimed2, 500);
    assert_eq!(w.token.balance(&alice), 1_000);
}

#[test]
fn test_cliff_unlocks_lump_sum() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);
    // 25% cliff of a 1000-second schedule for 1000 tokens => 250 unlocked at cliff.
    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::EarlyLender,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 250,
            duration_secs: 1_000,
            revocable: false,
        },
    );

    advance_to(&w, start + 250);
    assert_eq!(w.vesting.vested_amount(&alice), 250);
}

#[test]
#[should_panic(expected = "Nothing to claim")]
fn test_double_claim_same_instant_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::Team,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: 1_000,
            revocable: false,
        },
    );
    advance_to(&w, start + 500);
    w.vesting.claim(&alice);
    w.vesting.claim(&alice); // nothing new has vested since the last claim
}

#[test]
fn test_revoke_returns_unvested_and_freezes() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::Team,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: 1_000,
            revocable: true,
        },
    );

    advance_to(&w, start + 300); // 30% vested = 300
    let returned = w.vesting.revoke(&w.admin, &alice);
    assert_eq!(returned, 700);
    assert_eq!(w.token.balance(&w.admin), TOTAL_SUPPLY - 1_000 + 700);

    // Vested amount is now frozen at 300, even if more time passes.
    advance_to(&w, start + 10_000);
    assert_eq!(w.vesting.vested_amount(&alice), 300);

    // Beneficiary can still claim what had already vested.
    let claimed = w.vesting.claim(&alice);
    assert_eq!(claimed, 300);
    assert_eq!(w.token.balance(&alice), 300);
}

#[test]
#[should_panic(expected = "Schedule is not revocable")]
fn test_revoke_non_revocable_panics() {
    let w = setup();
    let alice = Address::generate(&w.env);
    let start = now(&w);

    w.vesting.create_vesting_schedule(
        &w.admin,
        &alice,
        &BeneficiaryCategory::EarlyLender,
        &1_000,
        &VestingTerms {
            start_time: start,
            cliff_secs: 0,
            duration_secs: 1_000,
            revocable: false,
        },
    );
    w.vesting.revoke(&w.admin, &alice);
}

#[test]
#[should_panic(expected = "No vesting schedule")]
fn test_claim_without_schedule_panics() {
    let w = setup();
    let nobody = Address::generate(&w.env);
    w.vesting.claim(&nobody);
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
    assert_eq!(w.vesting.get_admin(), admin);
    let attacker = Address::generate(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        attacker.into_val(&env),
        w.token.address.into_val(&env),
    ];
    for name in ["initialize", "__constructor"] {
        let res = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &w.vesting.address,
            &Symbol::new(&env, name),
            args.clone(),
        );
        assert!(res.is_err(), "{name} must not be callable after deployment");
    }
    assert_eq!(w.vesting.get_admin(), admin);
}
