# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- `POST /api/sponsor` no longer fee-bumps arbitrary transactions (#330). It
  signed a FeeBumpTransaction with `ADMIN_SECRET_KEY` for any caller and any
  inner transaction, so unauthenticated requests could drain the treasury's
  XLM. It now requires an authenticated borrower session, only sponsors a
  signed, single `InvokeContract` call to an official TrustLend contract
  sourced from the borrower's own wallet, caps the inner fee
  (`SPONSOR_MAX_INNER_FEE_STROOPS`), and enforces per-user and per-wallet
  sponsorship budgets on top of the per-IP limit. Rejections return 4xx with
  a reason code and are logged.
- `fast-uri` [GHSA-83f7-4hh3-vchq](https://github.com/advisories/GHSA-83f7-4hh3-vchq)
  (`mailto:` header injection, Dependabot alert #117) is verified patched:
  the `overrides` pin resolves the only copy to `4.2.2` (fixed in `4.1.1`) and
  `npm audit` no longer reports it. Its only path is dev tooling
  (`@commitlint/config-validator` → `ajv@8`), so nothing shipped was exposed.
  A new test fails CI if the override is removed or the lockfile ever
  resolves a vulnerable copy again.
- Protocol fee collection now moves real tokens and is access controlled.
  `lending::collect_fees` previously zeroed `UncollectedFees` for any caller
  without transferring anything. It is now callable only by the configured
  treasury (new `set_treasury`) or the admin, always pays the configured
  treasury, and transfers the fees in the new `set_fee_token` token —
  failing if the contract does not hold them. `sweep_tokens` can no longer
  take uncollected fees. `treasury::collect_protocol_fees` is admin-only,
  accepts only the lending contract registered with the new
  `set_lending_contract`, and credits `TokenBalance` with the tokens it
  actually received, rejecting mismatched reports; when the admin collects
  on the lending contract directly, it notifies the treasury through the
  new `record_protocol_fees` so balances stay in sync. The testnet deploy
  script links both contracts with XLM as the fee token (#338).
- `auto_compound_vault::harvest` no longer trusts a caller-supplied
  `yield_amount`, which let anyone with a dust deposit pay themselves the
  vault's entire balance as a "harvest fee" and inflate `TotalManagedAssets`
  with unbacked yield. Yield is now measured as the vault's token balance
  above `TotalManagedAssets`, and only the admin or keepers registered with
  the new `set_keeper` can harvest. `deposit` credits the balance actually
  received, so `TotalManagedAssets` is always backed by tokens the vault
  holds. **Breaking:** `harvest(caller, yield_amount)` is now
  `harvest(caller)` (#334).
- `lending::create_loan_request` no longer trusts the caller-supplied
  `max_loan_amount` and `reputation_tier`, which let a borrower exceed their
  credit limit and claim Platinum loyalty rewards on repayment. The limit and
  tier now come from the BorrowerReputationContract (`calculate_max_loan`,
  including any oracle boost, and the new `get_reputation_tier`), linked with
  the new admin-only `set_reputation_contract`. The two request fields are
  kept for wire compatibility but ignored. Loan requests fail closed when no
  reputation contract is linked or the borrower has no on-chain profile; the
  deploy scripts link it automatically. The snapshotted tier is readable via
  `get_loan_reputation_tier` (#335).
- Funding, pool-deposit and repayment APIs verify the submitted Stellar
  transaction against Horizon (success, signer, loan-bound memo, amount and
  destination) before crediting anything; previously any hash was accepted.
- Pool withdrawals are paid from the platform wallet by the server
  (`PLATFORM_WALLET_SECRET`) and refused when it cannot sign; previously the
  position was reduced without any XLM moving.
- Cron endpoints (`/api/cron/*`) fail closed: when `CRON_SECRET` is unset they
  reject every call with 500 instead of running unauthenticated. The
  unauthenticated bypass is limited to `NODE_ENV=development`, and all routes
  share one constant-time check in `lib/auth/cron.ts` (#331).
- Babel [GHSA-968p-4wvh-cqc8](https://github.com/advisories/GHSA-968p-4wvh-cqc8)
  (CVE-2025-27789, Dependabot alert #42: quadratic-time `.replace` helper
  generated for named capturing groups) is verified patched. The affected
  packages resolve to `@babel/helpers` 8.0.7 and `@babel/runtime` 7.29.7
  (fixed in 7.26.10 / 8.0.0-alpha.17), `@babel/runtime-corejs2/3` are not
  installed, and `npm audit` no longer reports it. A new test fails CI if any
  resolved copy becomes vulnerable again.

### Added
- Lender dashboard "Pool Utilization" chart: a responsive 30-day area chart
  of `(borrowed / totalLiquidity) × 100` with a hover / touch / keyboard
  tooltip (utilization %, borrowed XLM, pool capacity), backed by the new
  `GET /api/pools/performance?range=7d|30d|90d[&poolId=]` endpoint (#333).
- End-to-end on-chain loan lifecycle: mandatory, verified
  `create_loan_request`; lender-signed `approve_loan`; server-signed
  `activate_loan`, `record_payment` and pooled-lending state sync;
  `NEXT_PUBLIC_ONCHAIN_LOAN_LIFECYCLE` switch; `lending_pools.onchain_pool_id`
  (migration 0002). See docs/onchain-lifecycle.md.
- `npm run deploy:testnet` now deploys and initialises all 17 contracts,
  links referral / loyalty rewards to lending, whitelists native XLM as
  collateral and accepts `--out-env`. Typed clients for treasury, loyalty,
  referral rewards, auto-compound vault, liquidation auction, USDC pool and
  ZK credit verifier.
- `scripts/verify-onchain-lifecycle.ts` walks the full lifecycle against a
  live testnet deployment.
- Token-based design system (`app/theme.css`, `components/ui/`) with light,
  dark and system themes, shared framer-motion presets and animated stat
  components; landing, auth and dashboard shell rebuilt on it (#314).
- Neon Postgres + Drizzle ORM data layer with versioned migrations in
  `drizzle/`, `npm run db:*` scripts and a CI migration step on `main` (#313).
- Sign-In with Stellar (SEP-10) sessions issued as signed HttpOnly cookies;
  private KYC document storage on Vercel Blob (#313).
- GitHub Actions keeper workflow that triggers the liquidation keeper and price
  oracle every 5 minutes, working around Vercel's daily-cron limit (#312).
- SEP-24 fiat on/off ramp integration with Stellar anchors (#309).
- Grace period before liquidations can be triggered (#308).
- Collateral price oracle (#267): XLM and BTC prices from CoinGecko, Binance
  and the Stellar DEX, aggregated by median with outlier rejection and pushed
  on-chain; the liquidation keeper values positions with the live price. See
  [docs/oracle-price-feeds.md](docs/oracle-price-feeds.md).
- Referral programme (#266): unique invite links with the referrer's bonus paid
  by the `referral_rewards` contract during `activate_loan`. See
  [docs/referral-program.md](docs/referral-program.md).
- Borrowing user guide and FAQ at `/docs/borrowing` (#265) and keyboard
  accessible glossary tooltips for financial terms (#264).
- Initial open-source release setup: README, LICENSE, CONTRIBUTING,
  CODE_OF_CONDUCT, SECURITY, issue and pull request templates.

### Changed
- README rewritten for open-source readers; rate-limiting and payment-due
  scheduler details moved to `docs/rate-limiting.md` and
  `docs/payment-due-scheduler.md`; roadmap and contributing guide refreshed.
- Vercel cron jobs reduced to daily schedules (Hobby plan limit) (#312).
- Hard-coded colours across dashboards replaced with theme tokens so every
  screen renders in both themes (#314).

### Removed
- Supabase client, auth, RLS policies and SQL scripts, replaced by Neon +
  Drizzle (#313).
- Dead code, the indexer stack, stale documentation and unused assets (#311).

### Fixed
- Admin overview "Recent Users" rendered only the first user
  (`profiles.slice(0, 1)`); it now lists all fetched users with a
  "View all users" link, and its user / borrower / lender counts come from
  platform-wide aggregates instead of the 10 fetched rows. The admin users
  page is paginated (`?page=`), and KYC / risk badges use distinct tones
  (`rejected` and `high` were shown as warnings) (#332).
- `create_loan_request` and `set_pool_config` were called with plain JS
  objects instead of Soroban structs (and without `reputation_tier`), so the
  browser-side contract calls could never succeed.
- All contract crates were `rlib`-only, so `stellar contract build` produced
  WASM for one of seventeen contracts; they are `cdylib` again.
- Chart area fills rendered black because a CSS variable was used as an SVG
  gradient id (#314).
- Contract CI job: `usdc_lending_pool` arithmetic widths, token transfer
  calls and clippy warnings (#312).
