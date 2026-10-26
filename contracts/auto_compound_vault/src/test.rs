#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _, token, Address, Env,
};

fn setup_test() -> (Env, Address, Address, Address, Address, AutoCompoundVaultContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset_token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let lending_id = Address::generate(&env);

    let vault_id = env.register(
        AutoCompoundVaultContract,
        (&admin, &asset_token_id, &lending_id, &100_u32),
    );
    let client = AutoCompoundVaultContractClient::new(&env, &vault_id);

    (env, admin, asset_token_id, lending_id, vault_id, client)
}

#[test]
#[should_panic(expected = "Vault already initialised")]
fn test_vault_cannot_reinitialize_after_constructor() {
    let (env, _admin, asset_token_id, lending_id, _vault_id, client) = setup_test();
    let attacker = Address::generate(&env);
    client.initialize(&attacker, &asset_token_id, &lending_id, &100);
}

#[test]
fn test_vault_initialize_requires_admin_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let asset_token_id = Address::generate(&env);
    let lending_id = Address::generate(&env);
    let vault_id = env.register(
        AutoCompoundVaultContract,
        (&admin, &asset_token_id, &lending_id, &100_u32),
    );
    let client = AutoCompoundVaultContractClient::new(&env, &vault_id);
    let attacker = Address::generate(&env);
    assert!(client
        .try_initialize(&attacker, &asset_token_id, &lending_id, &100)
        .is_err());
}

fn mint_tokens(env: &Env, asset_token: &Address, recipient: &Address, amount: i128) {
    let token_admin_client = token::StellarAssetClient::new(env, asset_token);
    token_admin_client.mint(recipient, &amount);
}

fn balance_of(env: &Env, asset_token: &Address, who: &Address) -> i128 {
    token::Client::new(env, asset_token).balance(who)
}

/// Registers a fresh keeper address allowed to call `harvest`.
fn add_keeper(env: &Env, admin: &Address, client: &AutoCompoundVaultContractClient) -> Address {
    let keeper = Address::generate(env);
    client.set_keeper(admin, &keeper, &true);
    keeper
}

/// Solvency invariant: accounting never exceeds the tokens the vault holds.
fn assert_backed(env: &Env, asset_token: &Address, vault_id: &Address, client: &AutoCompoundVaultContractClient) {
    assert!(
        client.get_total_managed_assets() <= balance_of(env, asset_token, vault_id),
        "TotalManagedAssets exceeds the vault's token balance"
    );
}

#[test]
fn test_initialize_sets_config() {
    let (_env, admin, asset_token, lending_id, _vault_id, client) = setup_test();
    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_asset_token(), asset_token);
    assert_eq!(client.get_lending_contract(), lending_id);
    assert_eq!(client.get_harvest_fee_bps(), 100);
    assert_eq!(client.get_total_shares(), 0);
    assert_eq!(client.get_total_managed_assets(), 0);
    assert_eq!(client.get_exchange_rate(), PRECISION);
}

#[test]
fn test_first_deposit_mints_equal_shares() {
    let (env, _admin, asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let deposit_amount = 1_000_0000000i128;

    mint_tokens(&env, &asset_token, &alice, deposit_amount);

    let shares = client.deposit(&alice, &deposit_amount);
    assert_eq!(shares, deposit_amount);
    assert_eq!(client.get_shares_of(&alice), deposit_amount);
    assert_eq!(client.get_total_shares(), deposit_amount);
    assert_eq!(client.get_total_managed_assets(), deposit_amount);
    assert_eq!(client.get_user_asset_balance(&alice), deposit_amount);
    assert_eq!(client.get_exchange_rate(), PRECISION);
}

#[test]
fn test_subsequent_deposit_mints_proportional_shares() {
    let (env, _admin, asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    mint_tokens(&env, &asset_token, &bob, 500_0000000i128);

    client.deposit(&alice, &1_000_0000000i128);
    let bob_shares = client.deposit(&bob, &500_0000000i128);

    assert_eq!(bob_shares, 500_0000000i128);
    assert_eq!(client.get_total_shares(), 1_500_0000000i128);
    assert_eq!(client.get_total_managed_assets(), 1_500_0000000i128);
}

#[test]
fn test_harvest_pays_caller_fee_and_compounds_yield() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let harvester = add_keeper(&env, &admin, &client);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    client.deposit(&alice, &1_000_0000000i128);

    // Simulate yield generated and transferred to vault
    let yield_amount = 100_0000000i128; // 100 XLM yield
    mint_tokens(&env, &asset_token, &vault_id, yield_amount);
    assert_eq!(client.get_pending_yield(), yield_amount);

    let reinvested = client.harvest(&harvester);

    // 1% of 100 XLM = 1 XLM fee, 99 XLM reinvested
    let expected_fee = 1_0000000i128;
    let expected_reinvest = 99_0000000i128;

    assert_eq!(reinvested, expected_reinvest);
    assert_eq!(token::Client::new(&env, &asset_token).balance(&harvester), expected_fee);
    assert_eq!(client.get_total_shares(), 1_000_0000000i128);
    assert_eq!(client.get_total_managed_assets(), 1_099_0000000i128);

    // Accounting now matches the tokens actually held, with nothing left over.
    assert_eq!(balance_of(&env, &asset_token, &vault_id), 1_099_0000000i128);
    assert_eq!(client.get_pending_yield(), 0);

    // Exchange rate should appreciate
    let new_rate = client.get_exchange_rate();
    assert!(new_rate > PRECISION);
}

#[test]
fn test_withdraw_principal_and_compounded_interest() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let harvester = add_keeper(&env, &admin, &client);

    let initial_deposit = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &alice, initial_deposit);
    let alice_shares = client.deposit(&alice, &initial_deposit);

    // Harvest yield
    let yield_amount = 200_0000000i128;
    mint_tokens(&env, &asset_token, &vault_id, yield_amount);
    client.harvest(&harvester);

    // Alice withdraws all her shares
    let withdrawn = client.withdraw(&alice, &alice_shares);

    // 1000 deposit + 198 net compounded yield = 1198 XLM
    let expected_payout = 1_198_0000000i128;
    assert_eq!(withdrawn, expected_payout);
    assert_eq!(token::Client::new(&env, &asset_token).balance(&alice), expected_payout);
    assert_eq!(client.get_shares_of(&alice), 0);
    assert_eq!(client.get_total_shares(), 0);
    assert_eq!(client.get_total_managed_assets(), 0);
}

#[test]
#[should_panic(expected = "Deposit amount must be positive")]
fn test_deposit_zero_panics() {
    let (env, _admin, _asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    client.deposit(&alice, &0);
}

#[test]
#[should_panic(expected = "Insufficient shares balance")]
fn test_withdraw_insufficient_shares_panics() {
    let (env, _admin, asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    mint_tokens(&env, &asset_token, &alice, 1000);
    client.deposit(&alice, &1000);
    client.withdraw(&alice, &2000);
}

#[test]
#[should_panic(expected = "Unauthorised caller")]
fn test_set_harvest_fee_by_non_admin_panics() {
    let (env, _admin, _asset_token, _lending_id, _vault_id, client) = setup_test();
    let attacker = Address::generate(&env);
    client.set_harvest_fee_bps(&attacker, &200);
}

#[test]
#[should_panic(expected = "Harvest fee exceeds max limit")]
fn test_set_harvest_fee_over_max_panics() {
    let (_env, admin, _asset_token, _lending_id, _vault_id, client) = setup_test();
    client.set_harvest_fee_bps(&admin, &1500); // > 1000 max limit
}

// ── Harvest security (issue #334) ────────────────────────────────────────────
// `harvest` used to take a caller-supplied `yield_amount`, pay the fee on it
// from vault funds and add the rest to TotalManagedAssets unbacked. These tests
// pin down that yield is measured from real token balances, that only the
// admin / registered keepers can harvest, and that the vault stays solvent.

#[test]
fn test_attacker_cannot_drain_vault_via_harvest() {
    let (env, _admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let attacker = Address::generate(&env);

    let deposit = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &alice, deposit);
    client.deposit(&alice, &deposit);

    // Dust deposit so total_shares > 0 is the attacker's doing as well.
    mint_tokens(&env, &asset_token, &attacker, 1);
    client.deposit(&attacker, &1);

    let vault_before = balance_of(&env, &asset_token, &vault_id);
    let managed_before = client.get_total_managed_assets();

    assert!(client.try_harvest(&attacker).is_err(), "unregistered caller must not harvest");

    assert_eq!(balance_of(&env, &asset_token, &vault_id), vault_before);
    assert_eq!(balance_of(&env, &asset_token, &attacker), 0);
    assert_eq!(client.get_total_managed_assets(), managed_before);
    assert_eq!(client.get_exchange_rate(), PRECISION);
}

#[test]
#[should_panic(expected = "Unauthorised harvester")]
fn test_harvest_by_non_keeper_panics() {
    let (env, _admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let outsider = Address::generate(&env);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    client.deposit(&alice, &1_000_0000000i128);
    // Even with genuine yield present, outsiders cannot harvest.
    mint_tokens(&env, &asset_token, &vault_id, 10_0000000i128);

    client.harvest(&outsider);
}

#[test]
#[should_panic(expected = "No harvestable yield")]
fn test_keeper_cannot_harvest_without_real_yield() {
    let (env, admin, asset_token, _lending_id, _vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let keeper = add_keeper(&env, &admin, &client);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    client.deposit(&alice, &1_000_0000000i128);

    // No tokens arrived beyond principal: nothing to harvest, no fee to pay.
    client.harvest(&keeper);
}

#[test]
fn test_keeper_fee_is_bounded_by_actual_yield_at_max_fee() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let keeper = add_keeper(&env, &admin, &client);
    client.set_harvest_fee_bps(&admin, &MAX_HARVEST_FEE_BPS);

    let deposit = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &alice, deposit);
    client.deposit(&alice, &deposit);

    let real_yield = 10_0000000i128;
    mint_tokens(&env, &asset_token, &vault_id, real_yield);

    let reinvested = client.harvest(&keeper);

    // 10% of the 10 XLM that actually arrived, never more.
    let fee = real_yield * (MAX_HARVEST_FEE_BPS as i128) / 10_000;
    assert_eq!(balance_of(&env, &asset_token, &keeper), fee);
    assert_eq!(reinvested, real_yield - fee);
    assert_eq!(client.get_total_managed_assets(), deposit + real_yield - fee);
    assert_eq!(balance_of(&env, &asset_token, &vault_id), deposit + real_yield - fee);
    assert_backed(&env, &asset_token, &vault_id, &client);

    // The same yield cannot be harvested (and charged a fee) twice.
    assert!(client.try_harvest(&keeper).is_err());
    assert_eq!(balance_of(&env, &asset_token, &keeper), fee);
    assert_eq!(client.get_total_managed_assets(), deposit + real_yield - fee);

    // Alice can still redeem everything accounted to her.
    let alice_shares = client.get_shares_of(&alice);
    assert_eq!(client.withdraw(&alice, &alice_shares), deposit + real_yield - fee);
    assert_eq!(balance_of(&env, &asset_token, &vault_id), 0);
}

#[test]
fn test_admin_can_harvest_without_keeper_role() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    client.deposit(&alice, &1_000_0000000i128);
    mint_tokens(&env, &asset_token, &vault_id, 50_0000000i128);

    assert!(!client.is_keeper(&admin));
    let reinvested = client.harvest(&admin);

    assert_eq!(reinvested, 49_5000000i128); // 50 XLM − 1% fee
    assert_eq!(client.get_total_managed_assets(), 1_049_5000000i128);
    assert_backed(&env, &asset_token, &vault_id, &client);
}

#[test]
fn test_set_keeper_grants_and_revokes_harvest_access() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let keeper = add_keeper(&env, &admin, &client);
    assert!(client.is_keeper(&keeper));

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    client.deposit(&alice, &1_000_0000000i128);

    mint_tokens(&env, &asset_token, &vault_id, 10_0000000i128);
    client.harvest(&keeper);

    client.set_keeper(&admin, &keeper, &false);
    assert!(!client.is_keeper(&keeper));

    mint_tokens(&env, &asset_token, &vault_id, 10_0000000i128);
    let managed_before = client.get_total_managed_assets();
    assert!(client.try_harvest(&keeper).is_err(), "revoked keeper must not harvest");
    assert_eq!(client.get_total_managed_assets(), managed_before);
}

#[test]
#[should_panic(expected = "Unauthorised caller")]
fn test_set_keeper_by_non_admin_panics() {
    let (env, _admin, _asset_token, _lending_id, _vault_id, client) = setup_test();
    let attacker = Address::generate(&env);
    client.set_keeper(&attacker, &attacker, &true);
}

#[test]
#[should_panic(expected = "No active deposits in vault")]
fn test_harvest_with_no_deposits_panics() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let keeper = add_keeper(&env, &admin, &client);
    mint_tokens(&env, &asset_token, &vault_id, 10_0000000i128);
    client.harvest(&keeper);
}

#[test]
fn test_unharvested_yield_is_not_credited_to_new_depositors() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let keeper = add_keeper(&env, &admin, &client);

    mint_tokens(&env, &asset_token, &alice, 1_000_0000000i128);
    client.deposit(&alice, &1_000_0000000i128);

    // Yield lands in the vault but is not yet harvested.
    mint_tokens(&env, &asset_token, &vault_id, 100_0000000i128);

    // Bob's deposit is credited with exactly what he sent; the pending yield
    // stays pending instead of being booked to his account.
    mint_tokens(&env, &asset_token, &bob, 500_0000000i128);
    client.deposit(&bob, &500_0000000i128);
    assert_eq!(client.get_total_managed_assets(), 1_500_0000000i128);
    assert_eq!(client.get_pending_yield(), 100_0000000i128);

    client.harvest(&keeper);
    assert_eq!(client.get_pending_yield(), 0);
    assert_eq!(client.get_total_managed_assets(), 1_599_0000000i128);
    assert_eq!(balance_of(&env, &asset_token, &vault_id), 1_599_0000000i128);
}

#[test]
fn test_managed_assets_always_backed_by_vault_balance() {
    let (env, admin, asset_token, _lending_id, vault_id, client) = setup_test();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let keeper = add_keeper(&env, &admin, &client);

    mint_tokens(&env, &asset_token, &alice, 2_000_0000000i128);
    mint_tokens(&env, &asset_token, &bob, 2_000_0000000i128);

    client.deposit(&alice, &1_000_0000000i128);
    assert_backed(&env, &asset_token, &vault_id, &client);

    mint_tokens(&env, &asset_token, &vault_id, 37_1234567i128);
    client.harvest(&keeper);
    assert_backed(&env, &asset_token, &vault_id, &client);

    client.deposit(&bob, &750_0000000i128);
    assert_backed(&env, &asset_token, &vault_id, &client);

    let half = client.get_shares_of(&alice) / 2;
    client.withdraw(&alice, &half);
    assert_backed(&env, &asset_token, &vault_id, &client);

    mint_tokens(&env, &asset_token, &vault_id, 3);
    client.harvest(&keeper);
    assert_backed(&env, &asset_token, &vault_id, &client);

    let bob_shares = client.get_shares_of(&bob);
    client.withdraw(&bob, &bob_shares);
    let alice_shares = client.get_shares_of(&alice);
    client.withdraw(&alice, &alice_shares);
    assert_backed(&env, &asset_token, &vault_id, &client);
    assert_eq!(client.get_total_shares(), 0);
}
