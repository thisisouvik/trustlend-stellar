# Automated Default-Management & Insurance Payouts

> Soroban contract actions use the application's centralized Stellar SDK RPC transport; automation does not depend on Horizon account lookups.

> Implements issue **#23 — [Backend] Automate the Default Management insurance payouts**

Default handling no longer needs a human admin. A secure, authenticated serverless
cron monitors overdue loans against **ledger time** and, past the grace period,
triggers the on-chain default + insurance contract methods automatically.

---

## 1. Pieces

| File | Role |
|---|---|
| [app/api/cron/default-management/route.ts](../app/api/cron/default-management/route.ts) | Authenticated serverless endpoint (Vercel Cron / cURL) |
| [lib/scheduler/default-management.ts](../lib/scheduler/default-management.ts) | The run: query overdue loans → check ledger time → invoke contracts (idempotent, per-loan error handling) |
| [lib/stellar/server-contract.ts](../lib/stellar/server-contract.ts) | Server-side signed Soroban invoker (admin keypair) + ledger-time reader |
| [vercel.json](../vercel.json) | Schedules the cron daily at `02:00 UTC` |

## 2. Flow

```
Vercel Cron (02:00 UTC)  ──Bearer CRON_SECRET──►  /api/cron/default-management
                                                          │
                                                          ▼
                              runDefaultManagement()  (lib/scheduler)
   1. read latest ledger close time (Horizon)            │
   2. query loans: status in (active,funded) AND due_at < now
   3. for each loan → daysOverdue = (ledgerTime - due_at) / 1 day
        ├─ daysOverdue ≤ GRACE_PERIOD_DAYS  → skip
        ├─ daysOverdue >  GRACE_PERIOD_DAYS and not yet defaulted:
        │     • lending.mark_defaulted(admin, loanId)
        │     • default.record_default(admin, loanId, borrower, amount, daysOverdue)
        │     • DB: status=defaulted, defaulted_at, metadata.defaulted_onchain_at
        └─ daysOverdue ≥ INSURANCE_PAYOUT_DAYS and not yet paid:
              • multisig.propose(admin, TriggerInsurancePayout(default, loanId, lender, amount))
                (signers approve + execute → default.trigger_insurance_payout)
              • DB: metadata.insurance_paid_at
```

## 3. Security (Task 1)

- **Authenticated:** the route rejects any request whose `Authorization` header
  isn't `Bearer ${CRON_SECRET}` (same scheme as the existing `payment-due` cron).
  In Vercel, set `CRON_SECRET` and Vercel Cron sends it automatically. The check
  fails closed (shared helper in [lib/auth/cron.ts](../lib/auth/cron.ts)): with
  `CRON_SECRET` unset the route answers `500` and does nothing, except under
  `NODE_ENV=development`.
- **Signing key isolation:** contract calls are signed server-side with
  `ADMIN_SECRET_KEY`, read only inside [lib/stellar/server-contract.ts](../lib/stellar/server-contract.ts)
  (never `NEXT_PUBLIC_`, never sent to the browser).
- **On-chain authorization:** `mark_defaulted` and `record_default`
  `require_auth()` the admin and assert `caller == admin`, so a leaked endpoint
  alone cannot act without the key. `trigger_insurance_payout` is stricter: once
  the MultiSigAdmin contract is linked, only that contract can call it
  (issue #353), so even the admin key can only *propose* a payout — M-of-N
  signers must approve before the insurance fund moves.

## 4. Ledger-time check (Task 2)

Overdue is evaluated against the **latest ledger close time** (fetched from Horizon
`/ledgers?order=desc&limit=1`), not the server wall-clock — matching how the
contracts reason about time (`env.ledger().timestamp()`). Falls back to system time
if Horizon is unreachable. `mark_defaulted` + `record_default` fire past the grace
period; `trigger_insurance_payout` fires once a loan reaches the Reported phase
(`INSURANCE_PAYOUT_DAYS`, default 60 — mirrors the contract's `days_to_phase`).

## 5. Error handling & logging (Task 3)

- Each loan is processed in its own `try/catch`; one failure never aborts the run.
- Every action is **idempotent**: a loan already `defaulted` (DB flag) is not
  re-marked, and `insurance_paid_at` prevents double payouts. Safe to re-run.
- The run returns a structured summary and logs per loan:
  ```json
  {
    "ok": true, "ledgerTime": "…Z", "scanned": 12, "defaulted": 3,
    "paidOut": 1, "failed": 0, "duration": 1840,
    "outcomes": [{ "loanId": "…", "onchainLoanId": 7, "daysOverdue": 63,
                   "actions": ["mark_defaulted","record_default","db:status=defaulted",
                               "trigger_insurance_payout","db:insurance_paid"] }]
  }
  ```
- **Graceful degradation:** if `ADMIN_SECRET_KEY` / contract IDs are absent, the run
  still updates DB state and reports the on-chain steps as skipped instead of crashing.

## 6. Configuration

```bash
CRON_SECRET=                       # required: shared scheduler secret
ADMIN_SECRET_KEY=                  # required for on-chain calls (S...)
DATABASE_URL=                      # required: Neon connection string
DEFAULT_GRACE_PERIOD_DAYS=7        # optional (default 7)
DEFAULT_INSURANCE_PAYOUT_DAYS=60   # optional (default 60)
# reuses: NEXT_PUBLIC_LENDING_CONTRACT_ID, NEXT_PUBLIC_DEFAULT_CONTRACT_ID,
#         NEXT_PUBLIC_ADMIN_ADDRESS, NEXT_PUBLIC_SOROBAN_RPC_URL,
#         NEXT_PUBLIC_STELLAR_HORIZON_URL
```

## 7. Manual trigger / testing

```bash
curl -X POST https://<your-app>/api/cron/default-management \
  -H "Authorization: Bearer $CRON_SECRET"
```

## 8. Notes & future work

- The on-chain `u32` loan id and lender wallet are resolved from the funding ledger
  entry (`ledger_transactions` `loan_fund` metadata) / loan metadata. Loans funded
  before that metadata existed are handled DB-side and reported as deferred for the
  on-chain step.
- Future: top up the insurance fund from accrued platform fees, and emit borrower/
  lender notifications on default + payout (reusing `lib/notifications`).
