# Soroban Event Indexer Migration

TrustLend can read dashboard loan, reputation, and escrow state from a Soroban
event indexer while keeping Supabase as the migration fallback.

## Contracts To Index

Configure Mercury, Ensorcel, or a custom Soroban indexer to subscribe to these
contract IDs:

- `NEXT_PUBLIC_LENDING_CONTRACT_ID`
- `NEXT_PUBLIC_REPUTATION_CONTRACT_ID`
- `NEXT_PUBLIC_ESCROW_CONTRACT_ID`

## Event Topics

The contracts emit the following event topics for read-model indexing:

### Lending

- `(loan, request)` with `(loan_id, borrower, amount, duration_days, interest_rate_bps, total_due, due_at)`
- `(loan, approved)` with `(loan_id, lender, escrow_id)`
- `(loan, revoked)` with `loan_id`
- `(loan, active)` with `loan_id`
- `(loan, payment)` with `(loan_id, amount, remaining_due, status)`
- `(loan, default)` with `loan_id`

### Reputation

- `(oracle, set)` with `oracle`
- `(oracle, score)` with `(borrower, credit_score, boost_bps)`
- `(rep, event)` with `(borrower, event, delta, new_score)`
- `(rep, totals)` with `(borrower, borrowed_delta, repaid_delta)`
- `(rep, freeze)` with `(borrower, is_frozen)`

### Escrow

- `(escrow, deposit)` with `(lender, loan_id, amount)`
- `(escrow, withdraw)` with `(lender, loan_id, amount)`
- `(escrow, transfer)` with `(escrow_id, loan_id, borrower, amount)`

Amounts emitted by Soroban contracts are in stroops. The dashboard converts
indexed loan amounts back to XLM for table display.

## Expected Read Models

The app's server-side adapter is in `lib/indexer/read-model.ts`. It supports
GraphQL or REST and normalizes common snake_case and camelCase field names.

Recommended collections:

- `loans`
- `reputationEvents`
- `escrowEvents`

Recommended loan fields:

- `id` or `loanId`
- `borrowerId` and/or `borrowerAddress`
- `lenderId` and/or `lenderAddress`
- `status`
- `principalAmount` or `amount`
- `repaidAmount`
- `aprBps` or `interestRateBps`
- `durationDays`
- `dueAt`
- `createdAt`
- `escrowId`

Recommended reputation event fields:

- `borrowerId` and/or `borrowerAddress`
- `eventType`
- `pointsDelta`
- `scoreAfter`
- `createdAt`

Recommended escrow event fields:

- `loanId`
- `lenderAddress`
- `borrowerAddress`
- `amount`
- `eventType`
- `txHash`
- `createdAt`

## Runtime Configuration

Use `.env` values:

```env
TRUSTLEND_INDEXER_READ_MODE=fallback
TRUSTLEND_INDEXER_GRAPHQL_URL=https://your-indexer/graphql
TRUSTLEND_INDEXER_REST_URL=
TRUSTLEND_INDEXER_API_KEY=
```

`fallback` mode tries the indexer first and falls back to Supabase if the
indexer is unavailable or still backfilling. Use `required` only after the
subgraph is fully caught up. Use `disabled` to force the old Supabase reads.

If your GraphQL schema differs from the default collection names or filter
syntax, set any of these variables with a full GraphQL document:

- `TRUSTLEND_INDEXER_BORROWER_LOANS_QUERY`
- `TRUSTLEND_INDEXER_LENDER_LOANS_QUERY`
- `TRUSTLEND_INDEXER_ADMIN_LOANS_QUERY`
- `TRUSTLEND_INDEXER_REPUTATION_EVENTS_QUERY`
- `TRUSTLEND_INDEXER_ESCROW_EVENTS_QUERY`

REST deployments should expose:

- `GET /loans`
- `GET /reputation-events`
- `GET /escrow-events`

The adapter passes filters such as `borrowerId`, `borrowerAddress`,
`lenderId`, `lenderAddress`, and `limit` as query parameters.
