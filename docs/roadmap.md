# TrustLend Roadmap

> The current Soroban client architecture uses Stellar RPC rather than Horizon for account lookup and contract-transaction assembly.

This page tracks where the project is and what comes next. It is a living
document — priorities shift with community feedback, and every item is open for
contribution. Comment on or open an issue if you want to pick something up.

## Shipped

- Soroban contracts for lending, borrower reputation, escrow, default
  management, pooled lending, multisig admin, governance, referral rewards and
  the TLEND token suite, deployed to Stellar testnet with `npm run deploy:testnet`.
- Wallet-native authentication (Sign-In with Stellar / SEP-10) — no passwords,
  no third-party identity provider.
- Borrower, lender and admin dashboards (Next.js 16) with a token-based design
  system, light/dark themes and motion.
- KYC submission and admin review with private document storage.
- On-chain trust score, tiers and credit limits (reputation v1) driving loan
  eligibility and pricing.
- Escrow-assisted disbursement with a revocation window.
- Automated default management with multisig-gated insurance payouts.
- Liquidation keeper backed by a median-of-sources collateral price oracle.
- SEP-24 fiat on/off ramp integration with Stellar anchors.
- Referral programme paid on-chain on the first funded loan, with immutable
  database attribution under concurrent claims.
- Neon Postgres + Drizzle ORM data layer with versioned migrations, nightly
  encrypted backups and a documented restore procedure.
- CI: contract tests + WASM build, type check, lint, unit tests, production
  build, Playwright E2E, formal verification (proptest / Kani), coverage.
- Server-side verification of every client-submitted payment (funding, pool
  deposits, repayments) against Horizon before it is credited; pool
  withdrawals paid out from the platform wallet by the server.
- Full on-chain loan lifecycle: borrower-signed `create_loan_request`
  (mandatory, verified on Soroban RPC), lender-signed `approve_loan`,
  server-signed `activate_loan` / `record_payment`, pool state mirrored to the
  pooled-lending contract. See [onchain-lifecycle.md](onchain-lifecycle.md).
- One-command deployment of all 17 contracts with referral, loyalty, treasury,
  vault, auction, USDC pool and ZK verifier initialised and linked, native XLM
  whitelisted as collateral, and typed clients for each in `lib/contracts/`.

## In progress

- **Dashboard screens for the standalone contracts** — treasury (fee
  collection & distribution), auto-compound vault, liquidation auctions, the
  USDC pool and ZK credit verification have typed clients but no UI yet.
- **Escrow-backed direct funding.** Marketplace loans are paid straight to the
  borrower (escrow id 0); routing them through the escrow contract's
  revocation window is the next step.

## Planned

- Multi-asset lending (USDC and other Stellar assets) end to end.
- Governance UI: proposals, voting and parameter changes from the dashboard.
- Decentralised credit oracles that aggregate off-chain signals (mobile money,
  utility payments) into the trust score.
- Institutional lender tooling: pluggable underwriting models and bulk funding.
- Mobile-first experience and WalletConnect improvements.
- Mainnet launch after an external contract audit.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the workflow. Items in
"In progress" are the best place to help right now; "Planned" items usually
need a short design discussion in an issue first.
