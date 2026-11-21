#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Env};

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    let contract_id = env.register(BorrowerReputationContract, (&admin,));
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    client.init_borrower(&borrower);

    (env, contract_id, admin, borrower)
}

#[test]
fn test_initialization() {
    let env = Env::default();
    
    let admin = Address::generate(&env);
    let contract_id = env.register(BorrowerReputationContract, (&admin,));
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_default_tier() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let contract_id = env.register(BorrowerReputationContract, (&admin,));
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let borrower = Address::generate(&env);
    client.init_borrower(&borrower);

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 0);
    assert_eq!(profile.reputation_tier, ReputationTier::None);

    let max_loan = client.calculate_max_loan(&borrower);
    // Based on our None tier logic (score < 50 => max_loan = 10_000_000_000 stroops = 1000 XLM)
    assert_eq!(max_loan, 10_000_000_000); 

    let interest = client.calculate_interest_rate(&borrower);
    // Based on NO history logic => 1500 bps (15%)
    assert_eq!(interest, 1500);
}

#[test]
fn test_high_score_gets_better_rate_and_higher_limit() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    for _ in 0..10 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 500);
    assert_eq!(profile.reputation_tier, ReputationTier::Gold);

    assert_eq!(client.calculate_max_loan(&borrower), 100_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1000);
}

#[test]
fn test_low_score_stays_in_none_tier_with_base_terms() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::LoanLate1Day);
    client.add_reputation_event(&admin, &borrower, &ReputationEvent::LateWarning);

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 0);
    assert_eq!(profile.reputation_tier, ReputationTier::None);

    assert_eq!(client.calculate_max_loan(&borrower), 10_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1500);
}

#[test]
fn test_limits_scale_with_reputation_event_history() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 50);
    assert_eq!(profile.reputation_tier, ReputationTier::Beginner);
    assert_eq!(client.calculate_max_loan(&borrower), 20_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1300);

    for _ in 0..2 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 150);
    assert_eq!(profile.reputation_tier, ReputationTier::Silver);
    assert_eq!(client.calculate_max_loan(&borrower), 50_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1200);

    for _ in 0..7 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 500);
    assert_eq!(profile.reputation_tier, ReputationTier::Gold);
    assert_eq!(client.calculate_max_loan(&borrower), 100_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 1000);

    for _ in 0..10 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 1000);
    assert_eq!(profile.reputation_tier, ReputationTier::Platinum);
    assert_eq!(client.calculate_max_loan(&borrower), 1_000_000_000_000);
    assert_eq!(client.calculate_interest_rate(&borrower), 800);
}

#[test]
fn test_get_reputation_tier_tracks_profile_tier() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    assert_eq!(client.get_reputation_tier(&borrower), 0);

    // 50 → Beginner, 150 → Silver, 500 → Gold, 1000 → Platinum
    for (events, expected) in [(1u32, 1u32), (2, 2), (7, 3), (10, 4)] {
        for _ in 0..events {
            client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
        }
        assert_eq!(client.get_reputation_tier(&borrower), expected);
    }

    client.freeze_account(&admin, &borrower, &String::from_str(&env, "fraud"));
    assert_eq!(client.get_reputation_tier(&borrower), 0);
}

#[test]
fn test_get_reputation_tier_without_profile_fails() {
    let (env, contract_id, _admin, _borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let unknown = Address::generate(&env);
    assert!(client.try_get_reputation_tier(&unknown).is_err());
}

// ─── Oracle integration tests ─────────────────────────────────────────────────

/// Setup that also registers an authorized oracle.
fn setup_with_oracle() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let borrower = Address::generate(&env);

    let contract_id = env.register(BorrowerReputationContract, (&admin,));
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    // `set_oracle` is multisig-gated via `assert_multisig_admin`, which checks
    // the `MultisigAdmins` Vec. We configure a single-admin multisig so the
    // guard passes; this suite focuses on oracle ingestion, not multisig flow.
    let admins = soroban_sdk::vec![&env, admin.clone()];
    client.setup_multisig(&admin, &admins, &1);
    client.set_oracle(&admin, &oracle);
    client.init_borrower(&borrower);

    (env, contract_id, admin, oracle, borrower)
}

#[test]
fn test_set_and_get_oracle() {
    let (env, contract_id, _admin, oracle, _borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    assert_eq!(client.get_oracle(), oracle);
}

#[test]
fn test_oracle_score_boosts_max_loan() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Base (None tier) limit = 1,000 XLM.
    assert_eq!(client.calculate_max_loan(&borrower), 10_000_000_000);

    // Oracle posts a max score (1000) → +100 % boost → limit doubles.
    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "mobile-money"),
    );

    let data = client.get_oracle_data(&borrower);
    assert_eq!(data.credit_score, 1000);
    assert_eq!(data.loan_limit_boost_bps, 10_000);
    assert_eq!(data.data_sources, 3);

    assert_eq!(client.calculate_max_loan(&borrower), 20_000_000_000);
    // Interest rate is unaffected by oracle data.
    assert_eq!(client.calculate_interest_rate(&borrower), 1500);
}

#[test]
fn test_oracle_score_partial_boost() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // score 500 → +50 % boost on 1,000 XLM base → 1,500 XLM.
    client.submit_credit_score(
        &oracle,
        &borrower,
        &500,
        &2,
        &String::from_str(&env, "utility"),
    );
    assert_eq!(client.calculate_max_loan(&borrower), 15_000_000_000);
}

#[test]
fn test_stale_oracle_data_is_ignored() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "banking"),
    );
    assert_eq!(client.calculate_max_loan(&borrower), 20_000_000_000);

    // Advance ledger time beyond the 90-day validity window.
    env.ledger().set_timestamp(91 * 24 * 60 * 60);
    assert_eq!(client.calculate_max_loan(&borrower), 10_000_000_000);
}

#[test]
#[should_panic(expected = "not the registered oracle")]
fn test_non_oracle_cannot_submit() {
    let (env, contract_id, _admin, _oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let imposter = Address::generate(&env);
    client.submit_credit_score(
        &imposter,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "spoof"),
    );
}

#[test]
#[should_panic(expected = "exceeds MAX_ORACLE_SCORE")]
fn test_score_above_max_is_rejected() {
    let (env, contract_id, _admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.submit_credit_score(
        &oracle,
        &borrower,
        &1001,
        &3,
        &String::from_str(&env, "bad"),
    );
}

#[test]
#[should_panic(expected = "frozen account")]
fn test_cannot_submit_for_frozen_account() {
    let (env, contract_id, admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.freeze_account(&admin, &borrower, &String::from_str(&env, "fraud"));
    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "mobile-money"),
    );
}

#[test]
fn test_oracle_boost_stacks_on_tier_limit() {
    let (env, contract_id, admin, oracle, borrower) = setup_with_oracle();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Push borrower to Gold tier (base 10,000 XLM).
    for _ in 0..10 {
        client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    }
    assert_eq!(client.calculate_max_loan(&borrower), 100_000_000_000);

    // +100 % oracle boost → 20,000 XLM.
    client.submit_credit_score(
        &oracle,
        &borrower,
        &1000,
        &3,
        &String::from_str(&env, "banking"),
    );
    assert_eq!(client.calculate_max_loan(&borrower), 200_000_000_000);
}

// ─── Pausable / Multi-sig tests ──────────────────────────────────────────────

fn setup_with_multisig() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let signer1 = Address::generate(&env);

    let contract_id = env.register(BorrowerReputationContract, (&admin,));
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    client.init_borrower(&borrower);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1.clone()];
    client.setup_multisig(&admin, &admins, &2);

    (env, contract_id, admin, borrower, signer1)
}

#[test]
fn test_rep_setup_multisig() {
    let (env, contract_id, admin, _borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let admins = client.get_multisig_admins();
    assert_eq!(admins.len(), 2);
    assert!(admins.iter().any(|a| a == admin));
    assert!(admins.iter().any(|a| a == signer1));
    assert_eq!(client.get_multisig_threshold(), 2);
    assert!(!client.is_paused());
}

#[test]
fn test_rep_pause_activates_with_threshold() {
    let (env, contract_id, admin, _borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    assert!(!client.is_paused());

    client.pause(&admin);
    assert!(!client.is_paused());

    client.pause(&signer1);
    assert!(client.is_paused());
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_rep_add_reputation_event_blocked_when_paused() {
    let (env, contract_id, admin, borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_rep_freeze_account_blocked_when_paused() {
    let (env, contract_id, admin, borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.freeze_account(&admin, &borrower, &String::from_str(&env, "fraud"));
}

#[test]
fn test_rep_unfreeze_allowed_when_paused() {
    let (env, contract_id, admin, borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Freeze first while unpaused
    client.freeze_account(&admin, &borrower, &String::from_str(&env, "fraud"));
    assert!(client.is_frozen(&borrower));

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // Unfreeze should still work (restoring access)
    client.unfreeze_account(&admin, &borrower);
    assert!(!client.is_frozen(&borrower));
}

#[test]
fn test_rep_oracle_submission_allowed_when_paused() {
    let (env, contract_id, admin, borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Set oracle while unpaused
    let oracle = Address::generate(&env);
    client.set_oracle(&admin, &oracle);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);

    // Oracle submission should still work (independent data feed)
    client.submit_credit_score(
        &oracle,
        &borrower,
        &500,
        &2,
        &String::from_str(&env, "utility"),
    );

    let data = client.get_oracle_data(&borrower);
    assert_eq!(data.credit_score, 500);
}

#[test]
fn test_rep_unpause_restores_operations() {
    let (env, contract_id, admin, borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Pause
    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    // Unpause
    client.unpause(&admin);
    client.unpause(&signer1);
    assert!(!client.is_paused());

    // Reputation events should work again
    client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);
    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, 50);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_rep_non_admin_cannot_pause() {
    let (env, contract_id, _admin, _borrower, _signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.pause(&random);
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_rep_duplicate_pause_signer_rejected() {
    let (env, contract_id, admin, _borrower, _signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&admin); // duplicate
}

#[test]
fn test_rep_multiple_signers_independently() {
    let (env, contract_id, admin, _borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // Pause with admin first
    client.pause(&admin);
    assert!(!client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 1);

    // Then signer1
    client.pause(&signer1);
    assert!(client.is_paused());
}

#[test]
fn test_zk_tier_upgrade_success() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let verifier = Address::generate(&env);
    client.set_zk_verifier(&admin, &verifier);
    assert_eq!(client.get_zk_verifier(), verifier);

    let nullifier = BytesN::from_array(&env, &[88u8; 32]);
    client.apply_zk_tier_upgrade(&verifier, &borrower, &3, &nullifier);

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_tier, ReputationTier::Gold);
    assert_eq!(profile.reputation_score, 500);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is neither admin nor registered ZK verifier")]
fn test_zk_tier_upgrade_unauthorized_panics() {
    let (env, contract_id, _admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let random_caller = Address::generate(&env);
    let nullifier = BytesN::from_array(&env, &[99u8; 32]);
    client.apply_zk_tier_upgrade(&random_caller, &borrower, &2, &nullifier);
}

// ─── Packed Bitmask Flags Tests ──────────────────────────────────────────────

#[test]
fn test_packed_bitmask_flags_lifecycle() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // 1. Initial profile: is_active should be true, is_frozen & is_verified false
    assert!(client.is_active(&borrower));
    assert!(!client.is_frozen(&borrower));
    assert!(!client.is_verified(&borrower));
    assert_eq!(client.get_profile_flags(&borrower), FLAG_IS_ACTIVE);

    // 2. Admin sets KYC verified flag
    client.set_verified(&admin, &borrower, &true);
    assert!(client.is_verified(&borrower));
    assert!(client.is_active(&borrower));
    assert_eq!(
        client.get_profile_flags(&borrower),
        FLAG_IS_ACTIVE | FLAG_IS_VERIFIED
    );

    // 3. Admin freezes the account
    client.freeze_account(&admin, &borrower, &String::from_str(&env, "suspicious"));
    assert!(client.is_frozen(&borrower));
    assert!(!client.is_active(&borrower));
    assert!((client.get_profile_flags(&borrower) & FLAG_IS_FROZEN) != 0);

    // 4. Admin unfreezes the account
    client.unfreeze_account(&admin, &borrower);
    assert!(!client.is_frozen(&borrower));
    assert!(client.is_active(&borrower));

    // 5. Admin clears KYC verification
    client.set_verified(&admin, &borrower, &false);
    assert!(!client.is_verified(&borrower));
    assert_eq!(client.get_profile_flags(&borrower), FLAG_IS_ACTIVE);
}

#[test]
fn test_packed_bitmask_zk_tier_upgrade_flag() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let verifier = Address::generate(&env);
    client.set_zk_verifier(&admin, &verifier);

    let nullifier = BytesN::from_array(&env, &[77u8; 32]);
    client.apply_zk_tier_upgrade(&verifier, &borrower, &2, &nullifier);

    let flags = client.get_profile_flags(&borrower);
    assert!((flags & FLAG_ZK_UPGRADED) != 0);
    assert!((flags & FLAG_IS_ACTIVE) != 0);
}

// ─── i128 Score Arithmetic (issue #420) ──────────────────────────────────────
// `add_reputation_event` used to compute `reputation_score as i32 + delta`,
// which wrapped any score above i32::MAX to a negative value (then clamped to
// 0), silently wiping out long-standing borrowers' reputation.

/// Writes `score` straight into the borrower's stored profile, standing in
/// for a long history of events that would be impractical to replay.
fn seed_score(env: &Env, contract_id: &Address, borrower: &Address, score: i128) {
    env.as_contract(contract_id, || {
        let key = DataKey::BorrowerProfile(borrower.clone());
        let mut profile: BorrowerProfile = env.storage().persistent().get(&key).unwrap();
        profile.reputation_score = score;
        profile.reputation_tier = ReputationTier::Platinum;
        env.storage().persistent().set(&key, &profile);
    });
}

#[test]
fn test_score_above_i32_max_increases_without_truncation() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    let start = i32::MAX as i128 + 1_000;
    seed_score(&env, &contract_id, &borrower, start);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::LoanRepaidOnTime);

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, start + 20);
    assert_eq!(profile.reputation_tier, ReputationTier::Platinum);
    assert_eq!(profile.loan_count, 1);
}

#[test]
fn test_score_above_i32_max_decreases_without_truncation() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // A penalty that crosses back below i32::MAX must not wrap either.
    let start = i32::MAX as i128 + 50;
    seed_score(&env, &contract_id, &borrower, start);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::LoanDefaulted);

    let profile = client.get_profile(&borrower);
    assert_eq!(profile.reputation_score, start - 100);
    assert_eq!(profile.reputation_tier, ReputationTier::Platinum);
    assert_eq!(profile.default_count, 1);
}

#[test]
fn test_score_saturates_at_i128_max() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    seed_score(&env, &contract_id, &borrower, i128::MAX - 10);
    client.add_reputation_event(&admin, &borrower, &ReputationEvent::TestLoanRepaid);

    assert_eq!(client.get_reputation_score(&borrower), i128::MAX);
}

#[test]
fn test_score_never_goes_negative() {
    let (env, contract_id, admin, borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.add_reputation_event(&admin, &borrower, &ReputationEvent::LoanLate1Day);
    assert_eq!(client.get_reputation_score(&borrower), 0);
    assert_eq!(client.get_profile(&borrower).reputation_tier, ReputationTier::None);
}

// ─── Repeated pause / unpause cycles (issue #354) ────────────────────────────

fn pause_cycle_unpause_count(env: &Env, contract_id: &Address) -> u32 {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::UnpauseSignerCount)
            .unwrap_or(0)
    })
}

fn pause_cycle_has_entry(env: &Env, contract_id: &Address, key: DataKey) -> bool {
    env.as_contract(contract_id, || env.storage().instance().has(&key))
}

#[test]
fn test_pause_cycles_repeat_with_same_signers() {
    let (env, contract_id, admin, _borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    for cycle in 0..3u32 {
        client.pause(&admin);
        assert!(!client.is_paused(), "cycle {cycle}: one approval must not pause");
        client.pause(&signer1);
        assert!(client.is_paused(), "cycle {cycle}: threshold reached");
        assert_eq!(client.get_pause_signer_count(), 0);

        client.unpause(&signer1);
        assert!(client.is_paused(), "cycle {cycle}: one approval must not unpause");
        client.unpause(&admin);
        assert!(!client.is_paused(), "cycle {cycle}: threshold reached");
        assert_eq!(pause_cycle_unpause_count(&env, &contract_id), 0);
    }

    // Completed rounds leave no per-signer approvals behind in storage.
    for round in 0..3u32 {
        for signer in [&admin, &signer1] {
            let pause_key = DataKey::PauseSigner(signer.clone(), round);
            let unpause_key = DataKey::UnpauseSigner(signer.clone(), round);
            assert!(!pause_cycle_has_entry(&env, &contract_id, pause_key));
            assert!(!pause_cycle_has_entry(&env, &contract_id, unpause_key));
        }
    }
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_pause_cycles_dedup_still_enforced_within_a_round() {
    let (env, contract_id, admin, _borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    // One full cycle, then a signer tries to approve the next pause twice.
    client.pause(&admin);
    client.pause(&signer1);
    client.unpause(&admin);
    client.unpause(&signer1);

    client.pause(&admin);
    client.pause(&admin);
}

#[test]
fn test_pause_cycles_setup_multisig_clears_partial_approvals() {
    let (env, contract_id, admin, _borrower, signer1) = setup_with_multisig();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);

    client.pause(&admin);
    assert_eq!(client.get_pause_signer_count(), 1);

    // Reconfiguring the signer set starts a fresh round: the stale approval
    // neither blocks `admin` nor counts toward the new threshold.
    client.setup_multisig(&admin, &soroban_sdk::vec![&env, admin.clone(), signer1.clone()], &2);
    assert_eq!(client.get_pause_signer_count(), 0);

    client.pause(&admin);
    assert!(!client.is_paused());
    client.pause(&signer1);
    assert!(client.is_paused());
}

/// Issue #352: initialization runs in the Soroban constructor, atomically with
/// deployment. There is no `initialize` entrypoint left to front-run, and the
/// constructor cannot be re-invoked on the live contract to seize admin rights.
#[test]
fn test_constructor_initializes_and_cannot_be_reinvoked() {
    use soroban_sdk::{IntoVal, Symbol};
    let (env, contract_id, admin, _borrower) = setup();
    let client = BorrowerReputationContractClient::new(&env, &contract_id);
    assert_eq!(client.get_admin(), admin);
    let attacker = Address::generate(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        attacker.into_val(&env),
    ];
    for name in ["initialize", "__constructor"] {
        let res = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &contract_id,
            &Symbol::new(&env, name),
            args.clone(),
        );
        assert!(res.is_err(), "{name} must not be callable after deployment");
    }
    let stored: Address = env.as_contract(&contract_id, || {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    });
    assert_eq!(stored, admin);
}
