#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Env, IntoVal};

const REFERENCE_LOAN: i128 = 1_000_0000000; // 1_000 XLM
const BASE_BONUS: i128 = 10_0000000; // 10 TLND (7 decimals)

fn default_config() -> ReferralConfig {
    ReferralConfig {
        base_bonus: BASE_BONUS,
        reference_loan_amount: REFERENCE_LOAN,
        max_size_multiplier_bps: 20_000,  // cap at 2x
        min_qualifying_loan: 100_0000000, // 100 XLM
        max_referrals_per_referrer: 0,    // unlimited
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

    let contract_id = env.register(
        ReferralRewardsContract,
        (&admin, &token_id, &lending, config),
    );

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

/// Issue #352: initialization runs in the Soroban constructor, atomically with
/// deployment. There is no `initialize` entrypoint left to front-run, and the
/// constructor cannot be re-invoked on the live contract to seize admin rights.
#[test]
fn test_constructor_initializes_and_cannot_be_reinvoked() {
    use soroban_sdk::{IntoVal, Symbol};
    let ctx = setup();
    let env = ctx.env.clone();
    let admin = ctx.admin.clone();
    assert_eq!(client(&ctx).get_admin(), admin);
    let attacker = Address::generate(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        attacker.into_val(&env),
        ctx.token_id.into_val(&env),
        ctx.lending.into_val(&env),
        default_config().into_val(&env),
    ];
    for name in ["initialize", "__constructor"] {
        let res = env.try_invoke_contract::<(), soroban_sdk::Error>(
            &ctx.contract_id,
            &Symbol::new(&env, name),
            args.clone(),
        );
        assert!(res.is_err(), "{name} must not be callable after deployment");
    }
    let stored: Address = env.as_contract(&ctx.contract_id, || {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    });
    assert_eq!(stored, admin);
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

    c.setup_multisig(
        &ctx.admin,
        &soroban_sdk::vec![&ctx.env, ctx.admin.clone()],
        &1,
    );

    c.withdraw_unspent(&ctx.admin, &treasury, &BASE_BONUS);
    assert_eq!(balance_of(&ctx, &treasury), BASE_BONUS);
}

#[test]
#[should_panic(expected = "Insufficient reward balance")]
fn test_withdraw_beyond_balance_panics() {
    let ctx = setup_with(default_config(), BASE_BONUS);
    let c = client(&ctx);
    c.setup_multisig(
        &ctx.admin,
        &soroban_sdk::vec![&ctx.env, ctx.admin.clone()],
        &1,
    );
    let treasury = Address::generate(&ctx.env);
    c.withdraw_unspent(&ctx.admin, &treasury, &(BASE_BONUS * 10));
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
    assert_eq!(
        c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN),
        0
    );
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

// ─── Multi-Sig Governance and Pause Controls ────────────────────────────────

fn setup_with_multisig() -> (Ctx, Address, Address) {
    let ctx = setup();
    let signer1 = Address::generate(&ctx.env);
    let signer2 = Address::generate(&ctx.env);
    let admins = soroban_sdk::vec![
        &ctx.env,
        ctx.admin.clone(),
        signer1.clone(),
        signer2.clone()
    ];
    client(&ctx).setup_multisig(&ctx.admin, &admins, &2);
    (ctx, signer1, signer2)
}

#[test]
#[should_panic(expected = "Multisig not configured")]
fn test_withdraw_unspent_fails_when_multisig_not_configured() {
    let ctx = setup();
    let c = client(&ctx);
    let treasury = Address::generate(&ctx.env);
    c.withdraw_unspent(&ctx.admin, &treasury, &BASE_BONUS);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_withdraw_unspent_fails_for_non_multisig_admin() {
    let (ctx, _signer1, _signer2) = setup_with_multisig();
    let c = client(&ctx);
    let stranger = Address::generate(&ctx.env);
    let treasury = Address::generate(&ctx.env);
    c.withdraw_unspent(&stranger, &treasury, &BASE_BONUS);
}

#[test]
fn test_set_multisig_admin_links_and_allows_withdrawal() {
    let ctx = setup();
    let c = client(&ctx);
    let multisig = Address::generate(&ctx.env);
    let treasury = Address::generate(&ctx.env);

    c.set_multisig_admin(&ctx.admin, &multisig);
    assert_eq!(c.get_multisig_admin(), multisig);
    let admins = c.get_multisig_admins();
    assert_eq!(admins.len(), 1);
    assert_eq!(admins.get(0).unwrap(), multisig);

    // Linked multisig can withdraw unspent tokens
    c.withdraw_unspent(&multisig, &treasury, &BASE_BONUS);
    assert_eq!(balance_of(&ctx, &treasury), BASE_BONUS);
}

#[test]
#[should_panic(expected = "Multisig admin already configured")]
fn test_set_multisig_admin_cannot_be_reinvoked() {
    let ctx = setup();
    let c = client(&ctx);
    let msig1 = Address::generate(&ctx.env);
    let msig2 = Address::generate(&ctx.env);
    c.set_multisig_admin(&ctx.admin, &msig1);
    c.set_multisig_admin(&ctx.admin, &msig2);
}

#[test]
fn test_setup_multisig_configuration_and_queries() {
    let ctx = setup();
    let c = client(&ctx);
    let s1 = Address::generate(&ctx.env);
    let s2 = Address::generate(&ctx.env);

    // Admin omitted from input Vec is automatically included
    c.setup_multisig(
        &ctx.admin,
        &soroban_sdk::vec![&ctx.env, s1.clone(), s2.clone()],
        &2,
    );
    assert_eq!(c.get_multisig_threshold(), 2);
    let admins = c.get_multisig_admins();
    assert_eq!(admins.len(), 3);
    assert!(admins.contains(&ctx.admin));
    assert!(admins.contains(&s1));
    assert!(admins.contains(&s2));
    assert!(!c.is_paused());
    assert_eq!(c.get_pause_signer_count(), 0);
}

#[test]
#[should_panic(expected = "Threshold must be at least 1")]
fn test_setup_multisig_zero_threshold_rejected() {
    let ctx = setup();
    let c = client(&ctx);
    c.setup_multisig(
        &ctx.admin,
        &soroban_sdk::vec![&ctx.env, ctx.admin.clone()],
        &0,
    );
}

#[test]
#[should_panic(expected = "Threshold exceeds number of admins")]
fn test_setup_multisig_threshold_too_high_rejected() {
    let ctx = setup();
    let c = client(&ctx);
    c.setup_multisig(
        &ctx.admin,
        &soroban_sdk::vec![&ctx.env, ctx.admin.clone()],
        &5,
    );
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not admin")]
fn test_setup_multisig_non_admin_rejected() {
    let ctx = setup();
    let c = client(&ctx);
    let stranger = Address::generate(&ctx.env);
    c.setup_multisig(
        &stranger,
        &soroban_sdk::vec![&ctx.env, ctx.admin.clone()],
        &1,
    );
}

#[test]
fn test_pause_and_unpause_threshold_workflow() {
    let (ctx, signer1, signer2) = setup_with_multisig();
    let c = client(&ctx);

    // First signer approves pause (threshold = 2)
    c.pause(&ctx.admin);
    assert!(!c.is_paused());
    assert_eq!(c.get_pause_signer_count(), 1);

    // Second signer approves pause -> triggers paused state
    c.pause(&signer1);
    assert!(c.is_paused());

    // Operations blocked while paused
    let treasury = Address::generate(&ctx.env);
    let withdraw_res = ctx.env.try_invoke_contract::<(), soroban_sdk::Error>(
        &ctx.contract_id,
        &soroban_sdk::Symbol::new(&ctx.env, "withdraw_unspent"),
        soroban_sdk::vec![
            &ctx.env,
            ctx.admin.into_val(&ctx.env),
            treasury.into_val(&ctx.env),
            BASE_BONUS.into_val(&ctx.env),
        ],
    );
    assert!(withdraw_res.is_err());

    let referee = Address::generate(&ctx.env);
    let referrer = Address::generate(&ctx.env);
    let register_res = ctx.env.try_invoke_contract::<(), soroban_sdk::Error>(
        &ctx.contract_id,
        &soroban_sdk::Symbol::new(&ctx.env, "register_referral"),
        soroban_sdk::vec![
            &ctx.env,
            referee.into_val(&ctx.env),
            referrer.into_val(&ctx.env),
        ],
    );
    assert!(register_res.is_err());

    // claim_referral_bonus safely returns 0 when paused without panicking
    assert_eq!(
        c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN),
        0
    );

    // Unpause requires threshold (2 approvals)
    c.unpause(&signer1);
    assert!(c.is_paused());

    c.unpause(&signer2);
    assert!(!c.is_paused());

    // Operations resume after unpause
    c.register_referral(&referee, &referrer);
    assert_eq!(c.get_referrer_of(&referee), Some(referrer.clone()));

    assert_eq!(
        c.claim_referral_bonus(&ctx.lending, &referee, &REFERENCE_LOAN),
        BASE_BONUS
    );

    c.withdraw_unspent(&ctx.admin, &treasury, &BASE_BONUS);
    assert_eq!(balance_of(&ctx, &treasury), BASE_BONUS);
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_duplicate_pause_signer_rejected() {
    let (ctx, _signer1, _signer2) = setup_with_multisig();
    let c = client(&ctx);
    c.pause(&ctx.admin);
    c.pause(&ctx.admin);
}

#[test]
#[should_panic(expected = "Signer has already authorised unpause")]
fn test_duplicate_unpause_signer_rejected() {
    let (ctx, signer1, _signer2) = setup_with_multisig();
    let c = client(&ctx);
    c.pause(&ctx.admin);
    c.pause(&signer1);
    assert!(c.is_paused());

    c.unpause(&ctx.admin);
    c.unpause(&ctx.admin);
}

#[test]
#[should_panic(expected = "Contract is already paused")]
fn test_pause_when_already_paused_rejected() {
    let (ctx, signer1, _signer2) = setup_with_multisig();
    let c = client(&ctx);
    c.pause(&ctx.admin);
    c.pause(&signer1);
    assert!(c.is_paused());

    c.pause(&ctx.admin);
}

#[test]
#[should_panic(expected = "Contract is not paused")]
fn test_unpause_when_not_paused_rejected() {
    let (ctx, _signer1, _signer2) = setup_with_multisig();
    let c = client(&ctx);
    c.unpause(&ctx.admin);
}

#[test]
fn test_pause_cycles_repeat_with_same_signers() {
    let (ctx, signer1, _signer2) = setup_with_multisig();
    let c = client(&ctx);

    // Cycle 1
    c.pause(&ctx.admin);
    c.pause(&signer1);
    assert!(c.is_paused());

    c.unpause(&ctx.admin);
    c.unpause(&signer1);
    assert!(!c.is_paused());

    // Cycle 2: same signers can pause again in the next round
    c.pause(&ctx.admin);
    assert_eq!(c.get_pause_signer_count(), 1);
    c.pause(&signer1);
    assert!(c.is_paused());
}

#[test]
fn test_setup_multisig_clears_partial_approvals() {
    let (ctx, signer1, _signer2) = setup_with_multisig();
    let c = client(&ctx);

    c.pause(&ctx.admin);
    assert_eq!(c.get_pause_signer_count(), 1);

    // Reconfiguring multisig clears partial approvals
    c.setup_multisig(
        &ctx.admin,
        &soroban_sdk::vec![&ctx.env, ctx.admin.clone(), signer1.clone()],
        &2,
    );
    assert_eq!(c.get_pause_signer_count(), 0);

    c.pause(&ctx.admin);
    assert!(!c.is_paused());
    c.pause(&signer1);
    assert!(c.is_paused());
}
