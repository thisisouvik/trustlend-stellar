#![no_std]
//! TrustLend Multi-Sig Admin
//!
//! Replaces the single-admin bypass on TrustLend's rare, high-impact protocol
//! configuration operations — whitelisting collateral pools, changing fee
//! tables, linking governance/oracle, and moving insurance-fund balances —
//! with an N-of-M multi-signature approval flow.
//!
//! Deliberately NOT applied to high-frequency operational actions (loan
//! activation, payment recording, default marking, escrow disbursement
//! confirmation) — those must stay single-signer/backend-automatable, or the
//! platform's existing cron jobs and liquidation keeper stop functioning.
//! See `docs/contracts/multisig-admin.md` for the full rationale.
//!
//! Flow: `propose` (any registered signer) → `approve` (N distinct signers,
//! asynchronously, over separate transactions) → `execute` (permissionless
//! once the threshold is met) → cross-contract call into the target action.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Address, BytesN, Env, IntoVal, Symbol, Val,
    Vec,
};

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Executed,
    Cancelled,
}

/// The closed set of admin operations this multisig protects. Each variant
/// carries everything `execute` needs to perform the concrete cross-contract
/// call — no generically-serialized args, so every action is independently
/// typed, reviewable, and testable.
///
/// `#[contracttype]` enums only support unit or tuple (unnamed-field)
/// variants, so fields are positional — see the doc comment on each variant
/// for the field order.
#[contracttype]
#[derive(Clone, Debug)]
pub enum AdminAction {
    /// Whitelist a new collateral asset ("adding pools") on the Lending
    /// contract. Fields: `(target, asset)`.
    WhitelistAsset(Address, Address),
    /// Change the flash-loan fee ("interest rate table") on the Lending
    /// contract. Fields: `(target, new_fee_bps)`.
    SetFlashLoanFeeBps(Address, u32),
    /// Link the DAO Governance contract on the Lending contract.
    /// Fields: `(target, governance)`.
    SetGovernance(Address, Address),
    /// Register the authorised Credit Oracle on the Reputation contract.
    /// Fields: `(target, oracle)`.
    SetOracle(Address, Address),
    /// Add funds to the insurance pool on the Default-Management contract.
    /// Fields: `(target, amount)`.
    AddToInsurance(Address, i128),
    /// Withdraw protocol/insurance funds to a lender on the Default-Management
    /// contract. Fields: `(target, loan_id, lender, amount)`.
    TriggerInsurancePayout(Address, u32, Address, i128),
    /// Add a new authorised signer to this multisig. Fields: `(new_signer,)`.
    AddSigner(Address),
    /// Remove a signer from this multisig. Fields: `(signer,)`.
    RemoveSigner(Address),
    /// Change the approval threshold. Fields: `(new_threshold,)`.
    SetThreshold(u32),
    /// Upgrade another contract via cross-contract call. Fields: `(target, new_wasm_hash)`.
    UpgradeContract(Address, BytesN<32>),
}

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u32,
    pub proposer: Address,
    pub action: AdminAction,
    /// Distinct signer addresses that have approved, in approval order.
    pub approvals: Vec<Address>,
    pub created_at: u64,
    pub status: ProposalStatus,
}

#[contracttype]
pub enum DataKey {
    Signers,
    Threshold,
    ProposalCount,
    Proposal(u32),
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct MultiSigAdminContract;

#[contractimpl]
impl MultiSigAdminContract {
    // ── Init ─────────────────────────────────────────────────────────────────────

    pub fn __constructor(env: Env, signers: Vec<Address>, threshold: u32) {
        Self::init_internal(&env, signers, threshold);
    }

    /// Bootstrap the initial signer set + approval threshold. One-time only —
    /// membership changes thereafter go through `propose`/`approve`/`execute`
    /// (`AddSigner` / `RemoveSigner` / `SetThreshold`), same as every other
    /// admin action this contract protects.
    pub fn initialize(env: Env, signers: Vec<Address>, threshold: u32) {
        if signers.is_empty() {
            panic!("At least one signer is required");
        }
        signers.get(0).unwrap().require_auth();
        Self::init_internal(&env, signers, threshold);
    }

    fn init_internal(env: &Env, signers: Vec<Address>, threshold: u32) {
        if env.storage().instance().has(&DataKey::Signers) {
            panic!("Contract already initialised");
        }
        if signers.is_empty() {
            panic!("At least one signer is required");
        }
        if threshold == 0 || threshold > signers.len() {
            panic!("Threshold must be between 1 and the number of signers");
        }
        for i in 0..signers.len() {
            for j in (i + 1)..signers.len() {
                if signers.get(i) == signers.get(j) {
                    panic!("Duplicate signer in initial set");
                }
            }
        }

        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::ProposalCount, &0u32);
    }

    /// Upgrade this multisig contract's code while preserving its storage.
    /// This requires a successful self-proposal (`UpgradeContract` targeting this contract's ID).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        env.current_contract_address().require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ── Reads ────────────────────────────────────────────────────────────────────

    pub fn get_signers(env: Env) -> Vec<Address> {
        Self::signers(&env)
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .expect("Contract not initialised")
    }

    pub fn is_signer(env: Env, who: Address) -> bool {
        Self::signers(&env).contains(&who)
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Proposal {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found")
    }

    pub fn get_proposal_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    pub fn has_approved(env: Env, proposal_id: u32, signer: Address) -> bool {
        Self::get_proposal(env, proposal_id).approvals.contains(&signer)
    }

    // ── Proposing & approving ─────────────────────────────────────────────────────

    /// Any registered signer may open a proposal. Proposing counts as that
    /// signer's own first approval.
    pub fn propose(env: Env, proposer: Address, action: AdminAction) -> u32 {
        proposer.require_auth();
        Self::assert_signer(&env, &proposer);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let id = count + 1;

        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer.clone());

        let proposal = Proposal {
            id,
            proposer,
            action,
            approvals,
            created_at: env.ledger().timestamp(),
            status: ProposalStatus::Active,
        };
        env.storage().persistent().set(&DataKey::Proposal(id), &proposal);
        env.storage().instance().set(&DataKey::ProposalCount, &id);

        env.events()
            .publish((symbol_short!("msig"), symbol_short!("propose")), id);
        id
    }

    /// Record a distinct signer's approval of an active proposal.
    pub fn approve(env: Env, signer: Address, proposal_id: u32) {
        signer.require_auth();
        Self::assert_signer(&env, &signer);

        let mut proposal = Self::get_proposal(env.clone(), proposal_id);
        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }
        if proposal.approvals.contains(&signer) {
            panic!("Signer has already approved this proposal");
        }

        proposal.approvals.push_back(signer.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("msig"), symbol_short!("approve")),
            (proposal_id, signer),
        );
    }

    /// Let a signer withdraw their approval before execution.
    pub fn revoke_approval(env: Env, signer: Address, proposal_id: u32) {
        signer.require_auth();

        let mut proposal = Self::get_proposal(env.clone(), proposal_id);
        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        let idx = proposal.approvals.iter().position(|a| a == signer);
        match idx {
            Some(i) => {
                proposal.approvals.remove(i as u32);
            }
            None => panic!("Signer has not approved this proposal"),
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
    }

    /// The original proposer may cancel their own still-active proposal.
    pub fn cancel(env: Env, caller: Address, proposal_id: u32) {
        caller.require_auth();

        let mut proposal = Self::get_proposal(env.clone(), proposal_id);
        if caller != proposal.proposer {
            panic!("Only the proposer can cancel this proposal");
        }
        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
    }

    // ── Execution ──────────────────────────────────────────────────────────────────

    /// Enact a proposal once it has reached the approval threshold.
    /// Permissionless trigger — anyone may call this, but it only succeeds if
    /// enough DISTINCT registered signers have approved.
    pub fn execute(env: Env, proposal_id: u32) {
        let mut proposal = Self::get_proposal(env.clone(), proposal_id);
        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        let threshold = Self::get_threshold(env.clone());
        if proposal.approvals.len() < threshold {
            panic!("Insufficient approvals to execute this proposal");
        }

        Self::dispatch(&env, &proposal.action);

        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events()
            .publish((symbol_short!("msig"), symbol_short!("exec")), proposal_id);
    }

    // ── Dispatch: typed cross-contract calls ────────────────────────────────────────

    fn dispatch(env: &Env, action: &AdminAction) {
        let me = env.current_contract_address();
        match action {
            AdminAction::WhitelistAsset(target, asset) => {
                let args: Vec<Val> = vec![env, me.into_val(env), asset.into_val(env)];
                env.invoke_contract::<()>(target, &Symbol::new(env, "whitelist_asset"), args);
            }
            AdminAction::SetFlashLoanFeeBps(target, new_fee_bps) => {
                let args: Vec<Val> = vec![env, me.into_val(env), new_fee_bps.into_val(env)];
                env.invoke_contract::<()>(
                    target,
                    &Symbol::new(env, "set_flash_loan_fee_bps"),
                    args,
                );
            }
            AdminAction::SetGovernance(target, governance) => {
                let args: Vec<Val> = vec![env, me.into_val(env), governance.into_val(env)];
                env.invoke_contract::<()>(target, &Symbol::new(env, "set_governance"), args);
            }
            AdminAction::SetOracle(target, oracle) => {
                let args: Vec<Val> = vec![env, me.into_val(env), oracle.into_val(env)];
                env.invoke_contract::<()>(target, &Symbol::new(env, "set_oracle"), args);
            }
            AdminAction::AddToInsurance(target, amount) => {
                let args: Vec<Val> = vec![env, me.into_val(env), amount.into_val(env)];
                env.invoke_contract::<()>(target, &Symbol::new(env, "add_to_insurance"), args);
            }
            AdminAction::TriggerInsurancePayout(target, loan_id, lender, amount) => {
                let args: Vec<Val> = vec![
                    env,
                    me.into_val(env),
                    loan_id.into_val(env),
                    lender.into_val(env),
                    amount.into_val(env),
                ];
                env.invoke_contract::<()>(
                    target,
                    &Symbol::new(env, "trigger_insurance_payout"),
                    args,
                );
            }
            AdminAction::UpgradeContract(target, new_wasm_hash) => {
                let args: Vec<Val> = vec![env, me.into_val(env), new_wasm_hash.into_val(env)];
                env.invoke_contract::<()>(target, &Symbol::new(env, "upgrade"), args);
            }
            AdminAction::AddSigner(new_signer) => Self::do_add_signer(env, new_signer.clone()),
            AdminAction::RemoveSigner(signer) => Self::do_remove_signer(env, signer.clone()),
            AdminAction::SetThreshold(new_threshold) => {
                Self::do_set_threshold(env, *new_threshold)
            }
        }
    }

    // ── Self-management (only reachable via execute() above) ───────────────────────

    fn do_add_signer(env: &Env, new_signer: Address) {
        let mut signers = Self::signers(env);
        if signers.contains(&new_signer) {
            panic!("Signer already present");
        }
        signers.push_back(new_signer);
        env.storage().instance().set(&DataKey::Signers, &signers);
    }

    fn do_remove_signer(env: &Env, signer: Address) {
        let mut signers = Self::signers(env);
        let idx = signers
            .iter()
            .position(|s| s == signer)
            .expect("Signer not found");
        signers.remove(idx as u32);

        let threshold = env
            .storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::Threshold)
            .expect("Contract not initialised");
        if threshold > signers.len() {
            panic!("Removing this signer would make the threshold unreachable");
        }
        env.storage().instance().set(&DataKey::Signers, &signers);
    }

    fn do_set_threshold(env: &Env, new_threshold: u32) {
        let signers = Self::signers(env);
        if new_threshold == 0 || new_threshold > signers.len() {
            panic!("Threshold must be between 1 and the number of signers");
        }
        env.storage().instance().set(&DataKey::Threshold, &new_threshold);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────────

    fn signers(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .expect("Contract not initialised")
    }

    fn assert_signer(env: &Env, who: &Address) {
        if !Self::signers(env).contains(who) {
            panic!("Caller is not an authorised multisig signer");
        }
    }
}

#[cfg(test)]
mod test;
