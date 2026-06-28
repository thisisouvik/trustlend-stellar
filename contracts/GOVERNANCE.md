# DAO Governance — Platform Fee Module

> Implements issue **#22 — [Smart Contracts] Implement an automated DAO governance module for platform fees**
> and the README "Vision" item *DAO Governance*.

TrustLend's platform fee was a hard-coded `1%` of interest. This module decentralizes
that decision: members **propose**, **vote** (weighted by on-chain reputation), and on
success the fee change is **executed automatically** via a cross-contract call. The
fee can be changed **only** through a passed vote — there is no admin override.

---

## 1. Architecture

```
                      reputation-weighted voting power
   ┌────────────────────────┐  get_reputation_score(addr)  ┌────────────────────────┐
   │ BorrowerReputation      │ ◄─────────────────────────── │ Governance contract     │
   │  get_reputation_score() │                              │  propose / vote /        │
   └────────────────────────┘                              │  finalize / execute      │
                                                            └───────────┬────────────┘
                                          execute() → set_platform_fee_bps(self, bps)
                                                                        │ (caller == governance)
                                                                        ▼
                                                            ┌────────────────────────┐
                                                            │ Lending contract         │
                                                            │  PlatformFeeBps (DAO)    │
                                                            │  set_governance() once   │
                                                            └────────────────────────┘
```

## 2. Lending contract changes

The platform fee is now a stored, DAO-controlled parameter instead of a constant.

| Item | Detail |
|---|---|
| `get_platform_fee_bps()` | Current fee in bps of interest. Defaults to **100 (1 %)**. |
| `set_platform_fee_bps(caller, bps)` | **Only** callable by the linked governance contract (`caller == governance`); capped at `MAX_PLATFORM_FEE_BPS = 1000` (10 %). |
| `set_governance(admin, governance)` | One-time admin bootstrap that wires the DAO. After this, the fee changes by vote only. |
| `get_governance()` | Returns the linked governance address. |
| `create_loan_request` | Fee now computed as `interest * fee_bps / 10_000` (identical to the old `interest / 100` at the default). |

> Before `set_governance` is called, `set_platform_fee_bps` panics with
> *"Governance not configured"* — there is intentionally no other path to change the fee.

## 3. Governance contract API

Voting power = the caller's **reputation score** read from the reputation contract
(`get_reputation_score`), satisfying "based on token holdings **or** reputation scores".

| Function | Auth | Purpose |
|---|---|---|
| `initialize(admin, lending, reputation, voting_period_secs, quorum_votes, min_proposer_power, max_fee_bps)` | once | Configure the DAO |
| `propose_fee_change(proposer, new_fee_bps) -> id` | proposer | Open a proposal (requires ≥ `min_proposer_power` reputation; `new_fee_bps ≤ max_fee_bps`) |
| `vote(voter, proposal_id, support)` | voter | One reputation-weighted vote per account, within the window |
| `finalize(proposal_id) -> status` | anyone | After the window: `Passed` if quorum met **and** `votes_for > votes_against`, else `Rejected` |
| `execute(proposal_id)` | anyone | Enact a `Passed` proposal → cross-calls `lending.set_platform_fee_bps` → `Executed` |
| `get_config` / `get_proposal` / `get_proposal_count` / `get_voting_power` / `has_voted` | — | Reads |

### Proposal lifecycle

```
Active ──(finalize, quorum + majority)──► Passed ──(execute)──► Executed
   └──────(finalize, quorum unmet OR majority against)──────► Rejected
```

### Why this is safe / "automated"

- **Vote-only fee changes:** the lending guard `caller == governance` means a passed
  proposal is the *only* way to move the fee. Verified by
  `test_lending_rejects_non_governance_caller`.
- **Cross-contract auth:** `execute` passes `env.current_contract_address()` as the
  caller; Soroban auto-authorizes a contract for sub-calls made on its own behalf, so
  no key/admin is involved — execution is permissionless once a proposal passes.
- **Sybil/finality guards:** one vote per account, voting window enforced, quorum +
  majority required, and both the proposal and lending layers cap the fee at 10 %.

## 4. Tests

`contracts/governance/src/test.rs` is a **real integration test** — it registers the
actual reputation + lending contracts and drives the full flow end-to-end (12 tests):
happy-path fee change (1 % → 2.5 %), rejection on majority-against, quorum-not-met,
double-vote / closed-window / no-power / under-min-power / over-cap rejections,
execute-before-pass, and the direct non-governance / unconfigured-governance guards.

```bash
cd contracts && cargo test -p governance -p lending -p borrower-reputation
```

## 5. Deploy & wire

`contracts/scripts/deploy.sh` (and `deploy.ps1`) now deploy + initialize governance
(`voting_period 3 days, quorum 500, min proposer power 150 (Silver), fee cap 10 %`),
then call `lending.set_governance(<governance_id>)`. The id is written to
`.env.contracts` as `NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID`.

## 6. Frontend

`lib/contracts/governance.ts` wraps every governance method (propose/vote/finalize/
execute + reads); `lib/contracts/lending.ts` gains `getPlatformFeeBps` / `getGovernance`
/ `setGovernance`. Types live in `types/contracts.ts` (`Proposal`, `ProposalStatus`,
`GovConfig`, `PROPOSAL_STATUS_LABEL`, fee constants).

## 7. Future evolution

- More governable parameters (interest tiers, insurance fee, escrow window) via
  additional `ProposalKind` variants.
- Token-weighted or quadratic voting; time-locked execution; proposal deposits.
- A governance tab in the dashboard built on `lib/contracts/governance.ts`.
