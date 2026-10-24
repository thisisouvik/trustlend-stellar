#![no_std]
//! TrustLend DAO Governance
//!
//! Decentralizes changes to platform parameters — starting with the lending
//! platform fee. Members propose a new fee, vote with **reputation-weighted**
//! voting power (read from the BorrowerReputationContract), and once a proposal
//! passes quorum it can be executed permissionlessly. Execution performs a
//! cross-contract call into the LendingContract's `set_platform_fee_bps`, which
//! only accepts calls from this governance contract — so the fee can change by
//! *vote only*.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Address, BytesN, Env, IntoVal, Symbol,
    Val, Vec,
};

// ─── Types ────────────────────────────────────────────────────────────────────

/// Default execution timelock delay after a proposal passes (24 hours).
pub const DEFAULT_TIMELOCK_DELAY_SECS: u64 = 86_400;

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum ProposalStatus {
    /// Voting is open.
    Active,
    /// Voting closed, quorum met and votes_for > votes_against.
    Passed,
    /// Voting closed, quorum unmet or rejected.
    Rejected,
    /// Passed and enacted on the lending contract.
    Executed,
}

/// What a proposal changes. Extensible — fee governance is the first parameter.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum ProposalKind {
    /// Set the lending platform fee (basis-points of interest).
    SetPlatformFeeBps,
}

/// Historical voting power checkpoint for an account at a specific ledger and timestamp.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub struct PowerCheckpoint {
    pub ledger: u32,
    pub timestamp: u64,
    pub power: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u32,
    pub proposer: Address,
    pub kind: ProposalKind,
    /// Proposed parameter value (for SetPlatformFeeBps: the new fee in bps).
    pub new_value: u32,
    /// Sum of reputation-weighted voting power in favour.
    pub votes_for: i128,
    /// Sum of reputation-weighted voting power against.
    pub votes_against: i128,
    pub created_at: u64,
    /// Ledger sequence snapshotted when the proposal was created (Issue #424).
    pub snapshot_ledger: u32,
    /// Ledger timestamp when voting closes.
    pub end_at: u64,
    /// Earliest ledger timestamp when a Passed proposal may be executed (Issue #424).
    pub eta: u64,
    pub status: ProposalStatus,
}

/// Immutable-ish governance configuration (admin can re-init only once).
#[contracttype]
#[derive(Clone)]
pub struct GovConfig {
    pub admin: Address,
    /// LendingContract whose fee this DAO controls.
    pub lending: Address,
    /// ReputationContract used to weight votes.
    pub reputation: Address,
    /// Voting window length in seconds.
    pub voting_period_secs: u64,
    /// Minimum total voting power (for + against) required for a proposal to pass.
    pub quorum_votes: i128,
    /// Minimum reputation a member needs to open a proposal.
    pub min_proposer_power: i128,
    /// Hard cap on a proposable fee (bps). Mirrors the lending safety cap.
    pub max_fee_bps: u32,
}

#[contracttype]
pub enum DataKey {
    Config,
    ProposalCount,
    Proposal(u32),
    /// Records that `voter` has voted on proposal `id`.
    HasVoted(u32, Address),
    /// Historical voting power checkpoints for an account (Issue #424).
    Checkpoints(Address),
    /// Mandatory execution timelock delay in seconds (Issue #424).
    TimelockDelay,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    // ── Init / config ──────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        lending: Address,
        reputation: Address,
        voting_period_secs: u64,
        quorum_votes: i128,
        min_proposer_power: i128,
        max_fee_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic!("Contract already initialised");
        }
        if voting_period_secs == 0 {
            panic!("voting_period_secs must be positive");
        }
        let config = GovConfig {
            admin,
            lending,
            reputation,
            voting_period_secs,
            quorum_votes,
            min_proposer_power,
            max_fee_bps,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::ProposalCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &DEFAULT_TIMELOCK_DELAY_SECS);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        let config = Self::config(&env);
        if caller != config.admin {
            panic!("Unauthorised caller");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn get_config(env: Env) -> GovConfig {
        Self::config(&env)
    }

    /// Configure the mandatory execution timelock delay in seconds (admin only, Issue #424).
    pub fn set_timelock_delay(env: Env, caller: Address, delay_secs: u64) {
        caller.require_auth();
        let config = Self::config(&env);
        if caller != config.admin {
            panic!("Unauthorised caller");
        }
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &delay_secs);
    }

    /// Current execution timelock delay in seconds (default 86_400 = 24 hours).
    pub fn get_timelock_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TimelockDelay)
            .unwrap_or(DEFAULT_TIMELOCK_DELAY_SECS)
    }

    /// Reputation-weighted voting power of an account (0 if no profile).
    pub fn get_voting_power(env: Env, account: Address) -> i128 {
        Self::voting_power(&env, &account)
    }

    /// Record a voting-power checkpoint for `account` at the current ledger
    /// and timestamp (Issue #424). Callable by anyone prior to proposal creation
    /// so `account`'s historical power is snapshotted on-chain.
    pub fn checkpoint_voting_power(env: Env, account: Address) -> i128 {
        let power = Self::voting_power(&env, &account);
        Self::write_checkpoint(&env, &account, power);
        power
    }

    // ── Proposing ────────────────────────────────────────────────────────────────

    /// Open a proposal to set the platform fee to `new_fee_bps`.
    /// The proposer must hold at least `min_proposer_power` reputation.
    pub fn propose_fee_change(env: Env, proposer: Address, new_fee_bps: u32) -> u32 {
        proposer.require_auth();
        let config = Self::config(&env);

        if new_fee_bps > config.max_fee_bps {
            panic!("Proposed fee exceeds max_fee_bps");
        }
        let power = Self::voting_power(&env, &proposer);
        if power < config.min_proposer_power {
            panic!("Insufficient reputation to propose");
        }

        // Snapshot proposer's voting power at the proposal creation ledger
        Self::write_checkpoint(&env, &proposer, power);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let id = count + 1;

        let now = env.ledger().timestamp();
        let snapshot_ledger = env.ledger().sequence();
        let proposal = Proposal {
            id,
            proposer,
            kind: ProposalKind::SetPlatformFeeBps,
            new_value: new_fee_bps,
            votes_for: 0,
            votes_against: 0,
            created_at: now,
            snapshot_ledger,
            end_at: now + config.voting_period_secs,
            eta: 0,
            status: ProposalStatus::Active,
        };

        env.storage().persistent().set(&DataKey::Proposal(id), &proposal);
        env.storage().instance().set(&DataKey::ProposalCount, &id);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("propose")),
            (id, new_fee_bps),
        );
        id
    }

    // ── Voting ────────────────────────────────────────────────────────────────────

    /// Cast a reputation-weighted vote on an active proposal.
    /// `support = true` votes for, `false` votes against. One vote per account.
    /// Voting power is evaluated at the proposal's creation snapshot (`snapshot_ledger`,
    /// `created_at`) to prevent mid-vote reputation inflation (Issue #424).
    pub fn vote(env: Env, voter: Address, proposal_id: u32, support: bool) {
        voter.require_auth();

        let mut proposal = Self::get_proposal(env.clone(), proposal_id);
        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not open for voting");
        }
        if env.ledger().timestamp() > proposal.end_at {
            panic!("Voting period has ended");
        }

        let vote_key = DataKey::HasVoted(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            panic!("Account has already voted");
        }

        let power =
            Self::voting_power_at(&env, &voter, proposal.snapshot_ledger, proposal.created_at);
        if power <= 0 {
            panic!("No voting power (need reputation)");
        }

        if support {
            proposal.votes_for += power;
        } else {
            proposal.votes_against += power;
        }

        env.storage().persistent().set(&vote_key, &true);
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("vote")),
            (proposal_id, voter, support, power),
        );
    }

    // ── Finalization & execution ────────────────────────────────────────────────

    /// Close voting and tally the result. Callable by anyone after `end_at`.
    pub fn finalize(env: Env, proposal_id: u32) -> ProposalStatus {
        let mut proposal = Self::get_proposal(env.clone(), proposal_id);
        if proposal.status != ProposalStatus::Active {
            panic!("Proposal already finalized");
        }
        if env.ledger().timestamp() <= proposal.end_at {
            panic!("Voting period still open");
        }

        let config = Self::config(&env);
        let total = proposal.votes_for + proposal.votes_against;
        let quorum_met = total >= config.quorum_votes;
        let approved = proposal.votes_for > proposal.votes_against;

        if quorum_met && approved {
            proposal.status = ProposalStatus::Passed;
            let delay = Self::get_timelock_delay(env.clone());
            proposal.eta = env
                .ledger()
                .timestamp()
                .checked_add(delay)
                .expect("Overflow computing timelock eta");
        } else {
            proposal.status = ProposalStatus::Rejected;
        }
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("final")),
            (proposal_id, proposal.status.clone()),
        );
        proposal.status
    }

    /// Enact a passed proposal: cross-contract call into the LendingContract to
    /// change the fee. Permissionless — anyone can trigger execution once passed
    /// and the mandatory timelock delay (`proposal.eta`) has elapsed (Issue #424).
    pub fn execute(env: Env, proposal_id: u32) {
        let mut proposal = Self::get_proposal(env.clone(), proposal_id);
        if proposal.status != ProposalStatus::Passed {
            panic!("Only PASSED proposals can be executed");
        }
        if env.ledger().timestamp() < proposal.eta {
            panic!("Timelock delay has not elapsed");
        }

        let config = Self::config(&env);

        // Cross-contract call: lending.set_platform_fee_bps(self, new_value).
        // The lending contract requires the caller == this governance address;
        // a contract automatically authorises sub-calls made on its own behalf.
        let args: Vec<Val> = vec![
            &env,
            env.current_contract_address().into_val(&env),
            proposal.new_value.into_val(&env),
        ];
        env.invoke_contract::<()>(
            &config.lending,
            &Symbol::new(&env, "set_platform_fee_bps"),
            args,
        );

        proposal.status = ProposalStatus::Executed;
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("execute")),
            (proposal_id, proposal.new_value),
        );
    }

    // ── Queries ──────────────────────────────────────────────────────────────────

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

    pub fn has_voted(env: Env, proposal_id: u32, account: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::HasVoted(proposal_id, account))
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    fn config(env: &Env) -> GovConfig {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("Contract not initialised")
    }

    /// Reputation-weighted voting power via cross-contract read.
    fn voting_power(env: &Env, account: &Address) -> i128 {
        let config = Self::config(env);
        let args: Vec<Val> = vec![env, account.into_val(env)];
        env.invoke_contract::<i128>(
            &config.reputation,
            &Symbol::new(env, "get_reputation_score"),
            args,
        )
    }

    /// Record or update `account`'s voting power checkpoint at the current ledger/timestamp.
    fn write_checkpoint(env: &Env, account: &Address, power: i128) {
        let ledger = env.ledger().sequence();
        let timestamp = env.ledger().timestamp();
        let key = DataKey::Checkpoints(account.clone());
        let checkpoints: Vec<PowerCheckpoint> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(env));

        let mut updated = Vec::new(env);
        let mut replaced = false;
        for cp in checkpoints.iter() {
            if cp.ledger == ledger && cp.timestamp == timestamp {
                updated.push_back(PowerCheckpoint {
                    ledger,
                    timestamp,
                    power,
                });
                replaced = true;
            } else {
                updated.push_back(cp);
            }
        }
        if !replaced {
            updated.push_back(PowerCheckpoint {
                ledger,
                timestamp,
                power,
            });
        }
        env.storage().persistent().set(&key, &updated);
    }

    /// Evaluate `account`'s snapshotted voting power at `(snapshot_ledger, snapshot_timestamp)`.
    ///
    /// - Returns the latest checkpoint recorded at or before `(snapshot_ledger, snapshot_timestamp)`.
    /// - If no prior checkpoint exists and the current ledger/timestamp still matches the
    ///   proposal creation snapshot, records and returns the account's current voting power.
    /// - Otherwise returns `0`, preventing accounts that acquire or inflate reputation after
    ///   proposal creation from manufacturing voting power mid-vote.
    fn voting_power_at(
        env: &Env,
        account: &Address,
        snapshot_ledger: u32,
        snapshot_timestamp: u64,
    ) -> i128 {
        let key = DataKey::Checkpoints(account.clone());
        let checkpoints: Vec<PowerCheckpoint> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(env));

        let mut matched: Option<i128> = None;
        for cp in checkpoints.iter() {
            if cp.ledger <= snapshot_ledger && cp.timestamp <= snapshot_timestamp {
                matched = Some(cp.power);
            }
        }

        if let Some(power) = matched {
            return power;
        }

        if env.ledger().sequence() == snapshot_ledger
            && env.ledger().timestamp() == snapshot_timestamp
        {
            let power = Self::voting_power(env, account);
            if power > 0 {
                Self::write_checkpoint(env, account, power);
            }
            return power;
        }

        0
    }
}

#[cfg(test)]
mod test;
