#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, vec, Env};

const REFERENCE_LOAN: i128 = 1_000_0000000; // 1_000 XLM
const BASE_BONUS: i128 = 10_0000000; // 10 TLND (7 decimals)

fn default_config() -> ReferralConfig {
    ReferralConfig {
        base_bonus: BASE_BONUS,
        reference_loan_amount: REFERENCE_LOAN,
        max_size_multiplier_bps: 20_000, // cap at 2x
        min_qualifying_loan: 100_0000000, // 100 XLM
        max_referrals_per_referrer: 0,   // unlimited
    }
}

struct Ctx {
    env: Env,
    contract_id: Address,
    token_id: Address,
    admin: Address,
    lending: Address,
}

fn setup_with(config: ReferralConfig, funding: i128) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let lending = Address::generate(&env);

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(ReferralRewardsContract, ());
    let client = ReferralRewardsContractClient::new(&env, &contract_id);

    client.initialize(&admin, &token_id, &lending, &config);
    client.set_multisig_admin(&admin, &admin);

    if funding > 0 {
        token::StellarAssetClient::new(&env, &token_id).mint(&contract_id, &funding);
    }

    Ctx {
        env,
        contract_id,
        token_id,
        admin,
        lending,
    }
}

fn setup() -> Ctx {
    setup_with(default_config(), 1_000_0000000)
}

fn client<'a>(ctx: &Ctx) -> ReferralRewardsContractClient<'a> {
    ReferralRewardsContractClient::new(&ctx.env, &ctx.contract_id)
}

fn balance_of(ctx: &Ctx, who: &Address) -> i128 {
    token::Client::new(&ctx.env, &ctx.token_id).balance(who)
}

// ─── Initialisation ─────────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_state() {
    let ctx = setup();
    let c = client(&ctx);
    assert_eq!(c.get_admin(), ctx.admin);
    assert_eq!(c.get_reward_token(), ctx.token_id);
    assert_eq!(c.get_lending_contract(), ctx.lending);
    assert_eq!(c.get_total_bonuses_paid(), 0);
    assert_eq!(c.get_total_referrals_registered(), 0);
}

#[test]
#[should_panic(expected = "already initialised")]
fn test_double_initialize_panics() {
    let ctx = setup();
    client(&ctx).initialize(
        &ctx.admin,
        &ctx.token_id,
        &ctx.lending,
        &default_config(),
    );
}

#[test]
#[should_panic(expected = "reference_loan_amount must be positive")]
fn test_invalid_config_rejected() {
    let mut cfg = default_config();
    cfg.reference_loan_amount = 0;
    setup_with(cfg, 0);
}

// ─── Registration ───────────────────────────────────────────────────────────

#[test]
fn test_register_referral_records_pair() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);

    assert_eq!(c.get_referrer_of(&referee), Some(referrer));
    assert_eq!(c.get_total_referrals_registered(), 1);
}

#[test]
#[should_panic(expected = "Cannot refer yourself")]
fn test_self_referral_rejected() {
    let ctx = setup();
    let user = Address::generate(&ctx.env);
    client(&ctx).register_referral(&user, &user);
}

#[test]
#[should_panic(expected = "already has a referrer")]
fn test_referee_cannot_be_reattributed() {
    let ctx = setup();
    let c = client(&ctx);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &Address::generate(&ctx.env));
    // A second referrer must not be able to steal the attribution.
    c.register_referral(&referee, &Address::generate(&ctx.env));
}

#[test]
fn test_unregistered_referee_has_no_referrer() {
    let ctx = setup();
    let stranger = Address::generate(&ctx.env);
    assert_eq!(client(&ctx).get_referrer_of(&stranger), None);
}

// ─── Payout: the happy path ─────────────────────────────────────────────────

#[test]
fn test_bonus_paid_on_qualifying_loan() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    let paid = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);

    // A loan exactly at the reference size earns the full base bonus.
    assert_eq!(paid, BASE_BONUS);
    assert_eq!(balance_of(&ctx, &referrer), BASE_BONUS);
    assert!(c.is_bonus_paid(&referee));
    assert_eq!(c.get_referrer_earnings(&referrer), BASE_BONUS);
    assert_eq!(c.get_paid_referral_count(&referrer), 1);
    assert_eq!(c.get_total_bonuses_paid(), BASE_BONUS);
}

#[test]
fn test_bonus_scales_with_loan_size() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    // Half the reference loan earns half the bonus.
    let paid = c.claim_referral_bonus(&ctx.lending, &referee, &(REFERENCE_LOAN / 2));
    assert_eq!(paid, BASE_BONUS / 2);
}

#[test]
fn test_bonus_capped_at_max_multiplier() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    // 100x the reference loan is capped at the 2x multiplier.
    let paid = c.claim_referral_bonus(&ctx.lending, &referee, &(REFERENCE_LOAN * 100));
    assert_eq!(paid, BASE_BONUS * 2);
}

// ─── Payout: the guards ─────────────────────────────────────────────────────

#[test]
fn test_bonus_paid_only_once_per_referee() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    let first = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);
    // The same borrower taking a second loan earns the referrer nothing more.
    let second = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);

    assert_eq!(first, BASE_BONUS);
    assert_eq!(second, 0);
    assert_eq!(balance_of(&ctx, &referrer), BASE_BONUS);
    assert_eq!(c.get_paid_referral_count(&referrer), 1);
}

#[test]
fn test_no_bonus_without_registration() {
    let ctx = setup();
    let c = client(&ctx);
    let orphan = Address::generate(&ctx.env);

    let paid = c.claim_referral_bonus(&ctx.lending, &orphan, &REFERENCE_LOAN);
    assert_eq!(paid, 0);
    // An unattributed borrower must not be flagged as paid, or a later
    // legitimate registration would be permanently blocked.
    assert!(!c.is_bonus_paid(&orphan));
}

#[test]
fn test_non_lending_caller_gets_nothing() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);
    let attacker = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    // Anyone can *call*, but only the lending contract triggers a payout.
    let paid = c.claim_referral_bonus(&attacker, &referee, &REFERENCE_LOAN);

    assert_eq!(paid, 0);
    assert_eq!(balance_of(&ctx, &referrer), 0);
    assert!(!c.is_bonus_paid(&referee));
}

#[test]
fn test_loan_below_minimum_earns_nothing() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    // Dust loan, below min_qualifying_loan.
    let paid = c.claim_referral_bonus(&ctx.lending, &referee, &1_0000000);

    assert_eq!(paid, 0);
    // Crucially the referee stays unpaid, so a real loan later still pays.
    assert!(!c.is_bonus_paid(&referee));

    let later = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);
    assert_eq!(later, BASE_BONUS);
}

#[test]
fn test_registration_blocked_after_bonus_paid() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);

    // The pair is already recorded, so re-registration hits the
    // "already has a referrer" guard first — verified in its own test.
    assert!(c.is_bonus_paid(&referee));
}

#[test]
fn test_per_referrer_cap_enforced() {
    let mut cfg = default_config();
    cfg.max_referrals_per_referrer = 2;
    let ctx = setup_with(cfg, 1_000_0000000);
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);

    let mut paid_total = 0i128;
    for _ in 0..3 {
        let referee = Address::generate(&ctx.env);
        c.register_referral(&referee, &referrer);
        paid_total += c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);
    }

    // Third referral is over the cap and earns nothing.
    assert_eq!(paid_total, BASE_BONUS * 2);
    assert_eq!(c.get_paid_referral_count(&referrer), 2);
}

// ─── Funding edge cases ─────────────────────────────────────────────────────

#[test]
fn test_empty_pool_pays_nothing_without_panicking() {
    // Zero funding: a referral must not break the caller.
    let ctx = setup_with(default_config(), 0);
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    let paid = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);

    assert_eq!(paid, 0);
    // Not marked paid, so the referrer still earns once the pool is topped up.
    assert!(!c.is_bonus_paid(&referee));
}

#[test]
fn test_partial_pool_pays_what_remains() {
    // Pool holds less than one full bonus.
    let partial = BASE_BONUS / 4;
    let ctx = setup_with(default_config(), partial);
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    let paid = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);

    assert_eq!(paid, partial);
    assert_eq!(balance_of(&ctx, &referrer), partial);
    assert!(c.is_bonus_paid(&referee));
}

// ─── Views & admin ──────────────────────────────────────────────────────────

#[test]
fn test_calculate_bonus_view_matches_payout() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    let preview = c.calculate_bonus_view(&REFERENCE_LOAN);
    c.register_referral(&referee, &referrer);
    let actual = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);

    assert_eq!(preview, actual);
}

#[test]
fn test_calculate_bonus_view_zero_below_minimum() {
    let ctx = setup();
    assert_eq!(client(&ctx).calculate_bonus_view(&1_0000000), 0);
}

#[test]
fn test_set_config_updates_economics() {
    let ctx = setup();
    let c = client(&ctx);
    let mut cfg = default_config();
    cfg.base_bonus = BASE_BONUS * 2;
    c.set_config(&ctx.admin, &cfg);

    assert_eq!(c.get_config().base_bonus, BASE_BONUS * 2);
    assert_eq!(c.calculate_bonus_view(&REFERENCE_LOAN), BASE_BONUS * 2);
}

#[test]
#[should_panic(expected = "Unauthorised")]
fn test_non_admin_cannot_set_config() {
    let ctx = setup();
    let impostor = Address::generate(&ctx.env);
    client(&ctx).set_config(&impostor, &default_config());
}

#[test]
fn test_admin_can_withdraw_unspent() {
    let ctx = setup();
    let c = client(&ctx);
    let treasury = Address::generate(&ctx.env);

    c.withdraw_unspent(&ctx.admin, &treasury, &BASE_BONUS);
    assert_eq!(balance_of(&ctx, &treasury), BASE_BONUS);
}

#[test]
#[should_panic(expected = "Insufficient reward balance")]
fn test_withdraw_beyond_balance_panics() {
    let ctx = setup_with(default_config(), BASE_BONUS);
    let treasury = Address::generate(&ctx.env);
    client(&ctx).withdraw_unspent(&ctx.admin, &treasury, &(BASE_BONUS * 10));
}

#[test]
fn test_set_lending_contract_reroutes_payout_authority() {
    let ctx = setup();
    let c = client(&ctx);
    let new_lending = Address::generate(&ctx.env);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.set_lending_contract(&ctx.admin, &new_lending);
    c.register_referral(&referee, &referrer);

    // The old lending address no longer triggers payouts.
    assert_eq!(c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN), 0);
    assert_eq!(
        c.claim_referral_bonus(&new_lending, &referee, &REFERENCE_LOAN),
        BASE_BONUS
    );
}

// ─── Multi-referral accounting ──────────────────────────────────────────────

#[test]
fn test_referrer_accumulates_across_referees() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);

    for _ in 0..3 {
        let referee = Address::generate(&ctx.env);
        c.register_referral(&referee, &referrer);
        c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);
    }

    assert_eq!(c.get_referrer_earnings(&referrer), BASE_BONUS * 3);
    assert_eq!(c.get_paid_referral_count(&referrer), 3);
    assert_eq!(c.get_total_bonuses_paid(), BASE_BONUS * 3);
    assert_eq!(balance_of(&ctx, &referrer), BASE_BONUS * 3);
}

// ─── Multi-sig & Pause Controls (Issue #425) ────────────────────────────────

#[test]
fn test_setup_multisig_and_threshold_pause_unpause() {
    let ctx = setup();
    let c = client(&ctx);
    let signer1 = Address::generate(&ctx.env);
    let signer2 = Address::generate(&ctx.env);

    let admins = vec![&ctx.env, ctx.admin.clone(), signer1.clone(), signer2.clone()];
    c.setup_multisig(&ctx.admin, &admins, &2);

    assert_eq!(c.get_multisig_admins().len(), 3);
    assert_eq!(c.get_multisig_threshold(), 2);
    assert!(!c.is_paused());

    c.pause(&ctx.admin);
    assert!(!c.is_paused());
    assert_eq!(c.get_pause_signer_count(), 1);

    c.pause(&signer1);
    assert!(c.is_paused());
    assert_eq!(c.get_pause_signer_count(), 0);

    c.unpause(&ctx.admin);
    assert!(c.is_paused());
    c.unpause(&signer2);
    assert!(!c.is_paused());
}

#[test]
#[should_panic(expected = "Multisig not configured")]
fn test_withdraw_unspent_requires_multisig_configured() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let lending = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(ReferralRewardsContract, ());
    let c = ReferralRewardsContractClient::new(&env, &contract_id);

    c.initialize(&admin, &token_id, &lending, &default_config());
    token::StellarAssetClient::new(&env, &token_id).mint(&contract_id, &BASE_BONUS);

    let treasury = Address::generate(&env);
    // No multisig configured -> withdraw_unspent must fail closed
    c.withdraw_unspent(&admin, &treasury, &BASE_BONUS);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_withdraw_unspent_rejects_non_multisig_caller() {
    let ctx = setup();
    let c = client(&ctx);
    let stranger = Address::generate(&ctx.env);
    let treasury = Address::generate(&ctx.env);

    c.withdraw_unspent(&stranger, &treasury, &BASE_BONUS);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_withdraw_unspent_blocked_when_paused() {
    let ctx = setup();
    let c = client(&ctx);
    let treasury = Address::generate(&ctx.env);

    c.pause(&ctx.admin);
    assert!(c.is_paused());

    c.withdraw_unspent(&ctx.admin, &treasury, &BASE_BONUS);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_register_referral_blocked_when_paused() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.pause(&ctx.admin);
    c.register_referral(&referee, &referrer);
}

#[test]
fn test_claim_referral_bonus_returns_zero_when_paused_and_pays_after_unpause() {
    let ctx = setup();
    let c = client(&ctx);
    let referrer = Address::generate(&ctx.env);
    let referee = Address::generate(&ctx.env);

    c.register_referral(&referee, &referrer);
    c.pause(&ctx.admin);
    assert!(c.is_paused());

    // Must return 0 without panicking when paused so loan activation is not broken
    let paid_while_paused = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);
    assert_eq!(paid_while_paused, 0);
    assert!(!c.is_bonus_paid(&referee));

    c.unpause(&ctx.admin);
    let paid_after_unpause = c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN);
    assert_eq!(paid_after_unpause, BASE_BONUS);
    assert!(c.is_bonus_paid(&referee));
}
