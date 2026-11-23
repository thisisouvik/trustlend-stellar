# On-Chain Loan Lifecycle & Payment Verification

> Soroban lifecycle calls use Stellar RPC for account lookup, simulation, SDK transaction assembly, submission, and finality polling. Horizon remains only where this document explicitly describes classic-payment verification.

TrustLend moves XLM with classic Stellar payment operations that the user's
wallet signs, and records loan *state* on the Soroban `LendingContract`. This
document describes how the two are tied together and verified server-side.

## Why this exists

Before this work the API routes for funding, pool deposits and repayments
trusted a `txHash` string sent by the browser: any 64-character value credited
the caller. The on-chain contracts were called from the browser on a
best-effort basis, the call could not succeed (the request struct was encoded
incorrectly), and nothing linked a database loan to a contract loan.

Now:

1. every client-submitted payment is checked against Horizon before the
   database is touched ([`lib/stellar/verify-payment.ts`](../lib/stellar/verify-payment.ts)), and
2. every loan lives on the `LendingContract`, with the server signing the
   admin-side transitions ([`lib/stellar/onchain-lifecycle.ts`](../lib/stellar/onchain-lifecycle.ts)).

## Payment verification (Phase 2.1)

`verifyPaymentTransaction()` fetches `/transactions/{hash}` and its operations
from Horizon and requires all of the following:

| Check | Why |
|---|---|
| `successful === true` | Failed transactions are still queryable |
| `source_account` is the wallet linked to the signed-in account (session wallet or profile wallet) | The client-supplied address is only a claim |
| text memo equals `TL-FUND:<loanId>`, `TL-DEPOSIT:<poolId>` or `TL-RPY:<loanId>` (first 12 chars of the id) | Binds one payment to one loan/pool so it cannot be reused |
| native-XLM credits to each expected destination ≥ the claimed amount (1 stroop tolerance) | Amount and recipient are read from the chain, not the request |
| no payment to any other destination | A repayment cannot smuggle funds elsewhere |
| younger than 7 days | Bounds replay of very old transactions (the hash is also unique in the ledger tables) |

Failure codes are passed through to the client: `400` malformed hash, `404`
unknown transaction, `422` mismatch, `502` Horizon unavailable.

| Route | Source | Destination(s) | Memo |
|---|---|---|---|
| `POST /api/loans/fund` | lender wallet | borrower's profile wallet, ≥ `amount` | `TL-FUND:` |
| `POST /api/pools/deposit` | lender wallet | `NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS`, ≥ `amount` | `TL-DEPOSIT:` |
| `POST /api/loans/repay` | borrower wallet | every lender of the loan + `PLATFORM_FEE_WALLET`; total ≥ `amount` | `TL-RPY:` |
| `POST /api/pools/withdraw` | *server-signed* payout from `PLATFORM_WALLET_SECRET` to the lender | — | `TL-WDR:` |

Pool withdrawals previously reduced the position without moving any XLM. They
are now paid from the platform wallet by the server and refused (HTTP 503) when
`PLATFORM_WALLET_SECRET` is not configured.

## Loan lifecycle on the LendingContract (Phase 2.2)

```
borrower wallet      lender wallet         server (ADMIN_SECRET_KEY)
──────────────       ─────────────         ─────────────────────────
create_loan_request ─▶ id, tx ──▶ POST /api/loans/apply
                                   verifyContractInvocation(tx)
                                   get_loan(id) == {borrower, amount, duration, Pending}
                                   loans.metadata.onchain_loan_id = id
                     payment ──▶ POST /api/loans/fund
                     approve_loan(id, 0)   verifyPaymentTransaction
                       (completing lender) verifyContractInvocation(approve tx)
                                           activate_loan(id)            → Active
payment ────────────────────────▶ POST /api/loans/repay
                                   verifyPaymentTransaction
                                   record_payment(id, amount)          → Active | Repaid
                                  cron: mark_defaulted via multisig    → Defaulted
```

- **`POST /api/loans/apply`** accepts `preflight: true` so the client can run
  every eligibility check (KYC, credit limit, one active loan) *before* asking
  the wallet to sign. The real request must then carry `onchainLoanId`,
  `onchainTxHash` and `walletAddress`; the server verifies the invocation and
  cross-checks the on-chain record before inserting the row. One contract loan
  maps to exactly one row.
- **Collateral.** `create_loan_request` requires at least one whitelisted
  collateral entry with borrowing power ≥ the principal (75 % LTV by default).
  The borrower form defaults the asset to native XLM's Stellar Asset Contract
  and validates the amount. `npm run deploy:testnet` whitelists native XLM
  through the multisig.
- **Direct funding uses escrow id `0`.** Marketplace loans are paid straight to
  the borrower, so the completing lender approves the loan with escrow id 0;
  the escrow contract is not involved.
- **Partial fills.** The contract records a single lender. With several
  contributors the lender who completes the funding is the on-chain lender;
  every contribution is still recorded per lender in the database.
- **Chain failures after a verified payment never roll back the ledger.** The
  XLM has moved, so the helper records `loans.metadata.onchain_error` and the
  route returns `onchain: { attempted: true, ok: false, error }`. Re-running
  the step is idempotent (an already-active loan is treated as success).
- **Pools.** New pools get an id on the `PooledLendingContract`
  (`set_pool_config`), and every deposit/withdrawal pushes the pool's totals
  with `update_pool_state`. The id is stored in `lending_pools.onchain_pool_id`
  (migration `0002`).

### Loan metadata

| Key | Meaning |
|---|---|
| `onchain_loan_id` | `LoanRecord.id` on the LendingContract |
| `onchain_request_tx` | `create_loan_request` hash (borrower-signed) |
| `onchain_approve_tx` | `approve_loan` hash (lender-signed) |
| `onchain_activate_tx` | `activate_loan` hash (server-signed) |
| `onchain_payment_txs` | `record_payment` hashes (server-signed) |
| `onchain_status` | Last known contract status |
| `onchain_error` | Last failure, cleared on the next success |

## Configuration

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_ONCHAIN_LOAN_LIFECYCLE` | `required` (default when a lending id is set) or `off` |
| `NEXT_PUBLIC_LENDING_CONTRACT_ID`, `NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID` | Contract ids written by `npm run deploy:testnet` |
| `ADMIN_SECRET_KEY` | Signs `activate_loan`, `record_payment`, `update_pool_state`, `set_pool_config` |
| `NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS` / `PLATFORM_FEE_WALLET` | Deposit and fee destination the routes verify against |
| `PLATFORM_WALLET_SECRET` | Pays pool withdrawals |

`stellar keys show trustlend-admin` prints the admin secret after a deploy.

Set `NEXT_PUBLIC_ONCHAIN_LOAN_LIFECYCLE=off` to run database-only (for example
against a stale contract deployment); the routes then skip the contract calls
but still verify every payment.

## Deploying the contracts

`npm run deploy:testnet` builds all 17 crates, deploys them, initialises and
links them (multisig, governance, oracle, referral and loyalty contracts,
treasury, vault, auction, USDC pool, ZK verifier), whitelists native XLM as
collateral and writes every `NEXT_PUBLIC_*_CONTRACT_ID` to `.env.local`.

The contracts already deployed to testnet before this change predate the
current source (their `is_asset_whitelisted`, `get_multisig_admin` and
`get_platform_fee_bps` entry points do not exist and no loan was ever
created), so a fresh deployment is required before switching the lifecycle on
in production.

## Testing

- `__tests__/lib/verify-payment.test.ts` — Horizon verification with a mocked `fetch`
- `__tests__/lib/onchain-lifecycle.test.ts` — invocation verification against real SDK envelopes, struct encoding
- `__tests__/lib/loans-onchain.test.ts` — route glue (activate / record / request verification)
- `__tests__/api/loans/fund.test.ts`, `repay.test.ts`, `__tests__/api/pools/deposit-withdraw.test.ts` — route behaviour with verification mocked
