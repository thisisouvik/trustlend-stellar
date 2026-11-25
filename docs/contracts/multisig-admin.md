# Multi-Sig Administration Control

> Implements issue **#73 — [Smart Contracts] Implement Multi-Sig administration control for platform upgrades**

Rare, high-impact protocol configuration changes — whitelisting collateral
assets ("adding pools"), changing fee tables, linking governance/oracle, and
moving insurance-fund balances ("withdrawing protocol fees") — used to be a
single admin key away from being changed. They now require **N-of-M approval**
from authorised admin wallets via a new `MultiSigAdminContract`.

---

## 1. Located administrative operations (Task 1)

| Contract | Function | Why it's in scope |
|---|---|---|
| Lending | `whitelist_asset` | "Adding pools" — this codebase's collateral-asset whitelist |
| Lending | `set_flash_loan_fee_bps` | "Setting interest rate tables" |
| Lending | `set_governance` | Linking the DAO — rare, high-impact config |
| Reputation | `set_oracle` | Authorising who can write credit-score data |
| Default Mgmt | `add_to_insurance` / `trigger_insurance_payout` | "Withdrawing protocol fees" — literal fund movement |
| Referral Rewards | `withdraw_unspent` | Protecting reward pool from single-admin drainage (Issue #425) |

**Deliberately NOT gated:** `activate_loan`, `record_payment`, `mark_defaulted`,
`confirm_disbursement`, `record_default`, `add_reputation_event`,
`freeze_account`/`unfreeze_account`. These are high-frequency, backend-automated
loan-lifecycle operations (issue #23's cron, #72's liquidation keeper) — gating
them behind async multi-party approval would break automation entirely, and
they aren't the kind of operation the issue's examples point at.

## 2. Multi-sig approval before configuration shifts (Task 2)

New [`contracts/multisig_admin`](../../contracts/multisig_admin/src/lib.rs) contract:

```
propose(signer, action) -> id     — any signer opens a proposal (counts as their own approval)
approve(signer, id)               — a DISTINCT signer approves, in a SEPARATE transaction
revoke_approval(signer, id)       — withdraw an approval before execution
cancel(proposer, id)              — proposer withdraws their own proposal
execute(id)                       — permissionless once approvals >= threshold
```

`AdminAction` is a closed, typed enum (not a generic "any call") — every
protected operation is explicit and independently reviewable:

```rust
pub enum AdminAction {
    WhitelistAsset(Address, Address),               // target, asset
    SetFlashLoanFeeBps(Address, u32),                // target, new_fee_bps
    SetGovernance(Address, Address),                 // target, governance
    SetOracle(Address, Address),                     // target, oracle
    AddToInsurance(Address, i128),                   // target, amount
    TriggerInsurancePayout(Address, u32, Address, i128), // target, loan_id, lender, amount
    AddSigner(Address), RemoveSigner(Address), SetThreshold(u32), // self-governance
}
```

`execute` cross-calls the target contract (`whitelist_asset`, etc.) with the
MultiSigAdmin contract's own address as caller — the same pattern already used
by the Governance contract (issue #22) to call `set_platform_fee_bps`.

**The bypass is genuinely closed, not just supplemented.** Each target contract
gains a one-time `set_multisig_admin(admin, multisig)` bootstrap. Once called:
- The gated functions check `caller == multisig` — **not** `caller == admin`.
- `set_multisig_admin` panics if called again — the original admin can never
  quietly repoint it at a different multisig they solely control.
- The only way forward is the multisig's own signer governance
  (`AddSigner`/`RemoveSigner`/`SetThreshold`, themselves propose→approve→execute).

## 3. Integration tests (Task 3)

[`contracts/multisig_admin/src/test.rs`](../../contracts/multisig_admin/src/test.rs) —
**27 tests**, using the *real* Lending, Default-Management, and Reputation
contracts (dev-dependencies), not mocks:

- **The core sequence**: distinct wallets Alice → propose, Bob → approve (separate
  transactions) → anyone executes → asset whitelisted on-chain.
- **The security property this issue is about**: even the *original* admin can
  no longer call `whitelist_asset` directly once multisig is linked, and can
  never re-link a different multisig.
- All six protected actions exercised end-to-end (fee change, governance link,
  oracle link, insurance fund add + payout).
- Approval bookkeeping: non-signers rejected, double-approval rejected, revoke,
  cancel (proposer-only), no double-execute.
- Signer self-governance: add/remove signer, threshold change, removing a
  signer below the threshold is rejected, and a *raised* threshold correctly
  requires more approvals for subsequent proposals.

```bash
cd contracts && cargo test -p multisig-admin
```

## 4. Automation impact

`trigger_insurance_payout` is now multisig-gated, so the default-management
cron (issue #23) can no longer execute payouts unattended — it now
**proposes** the payout (its key must be a registered signer) and a human
completes the remaining approvals + `execute`. See
[`lib/scheduler/default-management.ts`](../../lib/scheduler/default-management.ts).

## 5. Verification

Full workspace: **89/89 tests passing** (13+7+12+30+27, unchanged pre-existing
suites + 27 new). Clippy clean (`-D warnings`). Both `wasm32-unknown-unknown`
(CI) and `wasm32v1-none` (deploy) release builds succeed for all 6 contracts.
Frontend: `tsc --noEmit`, ESLint, and the full vitest suite (80 tests) all pass
after the TS client + cron updates.
