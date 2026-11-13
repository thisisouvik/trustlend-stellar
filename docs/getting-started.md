# Getting Started with TrustLend

Welcome, contributor! This guide walks you through setting up your local development environment for TrustLend — from installing the Soroban CLI and Node dependencies to running the full test suite.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone the Repository](#2-clone-the-repository)
3. [Frontend Setup (Next.js)](#3-frontend-setup-nextjs)
4. [Smart Contract Setup (Soroban / Rust)](#4-smart-contract-setup-soroban--rust)
5. [Running the Test Suite](#5-running-the-test-suite)
6. [Common Tasks & Workflows](#6-common-tasks--workflows)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Prerequisites

Install these tools on your machine before cloning the repo.

| Tool | Version | Purpose |
|---|---|---|
| **Node.js** | ^20 (LTS) | Next.js frontend & tooling |
| **npm** | ^10 | Package manager |
| **Rust** | stable (via `rustup`) | Soroban smart contract compilation |
| **Soroban CLI** | latest | Contract deployment & interaction |
| **Varial Wallet** | latest (browser ext.) | Stellar wallet for testnet interactions (formerly Freighter) |

### Verify Installations

```bash
node --version   # Should be >= 20.x
npm --version    # Should be >= 10.x
rustc --version  # Should be >= 1.80
cargo --version  # Should match rustc
```

### Install Rust

If you don't have Rust installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### Install the `wasm32-unknown-unknown` Target

Soroban contracts compile to WebAssembly. Add the target:

```bash
rustup target add wasm32-unknown-unknown
```

### Install the Soroban CLI

The Soroban CLI (`stellar`) is used to deploy and interact with contracts:

```bash
cargo install stellar-cli --locked
```

> **Note:** This compiles from source and takes a few minutes. On macOS you may need `pkg-config` and `libssl-dev`. On Linux: `sudo apt install pkg-config libssl-dev`.

Verify the CLI:

```bash
stellar --version
```

---

## 2. Clone the Repository

### Fork First

If you plan to contribute, [fork the repository](https://github.com/thisisouvik/trustlend-stellar/fork) on GitHub, then clone your fork:

```bash
git clone https://github.com/<your-username>/trustlend-stellar.git
cd trustlend-stellar
```

Add the original repo as an upstream remote so you can sync changes:

```bash
git remote add upstream https://github.com/thisisouvik/trustlend-stellar.git
```

---

## 3. Frontend Setup (Next.js)

### 3.1 Install Node Dependencies

```bash
npm install
```

This installs all frontend dependencies listed in `package.json` (React 19, Next.js 16, Tailwind CSS 4, Drizzle ORM, Stellar SDK, etc.). The install also triggers Husky's `prepare` script which activates the commit-msg hook for conventional commit enforcement.

### 3.2 Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env.local
```

Open `.env.local` and set the required values. At minimum configure:

```bash
DATABASE_URL=postgres://...            # Neon pooled connection string
SESSION_SECRET=<openssl rand -base64 48>
SIWS_SERVER_SECRET=<stellar keys generate ...>
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

> Refer to `.env.example` for the full list of supported variables and their descriptions.

### 3.3 Set Up the Database (Neon Postgres)

TrustLend stores off-chain state in Postgres on [Neon](https://neon.tech) and
talks to it through [Drizzle ORM](https://orm.drizzle.team). The schema lives in
`lib/db/schema.ts`; SQL migrations are generated from it into `drizzle/`.

1. Create a Neon project and copy the **pooled** connection string into
   `DATABASE_URL` in `.env.local`.
2. Apply the migrations:

   ```bash
   npm run db:migrate
   ```

   This creates every table, trigger and SQL function the app needs (the
   `drizzle/0001_functions_and_triggers.sql` migration holds the row-locked
   loan-funding and referral functions).
3. Optional: `npm run db:studio` opens a browser UI over the database.

When you change `lib/db/schema.ts`, run `npm run db:generate` to produce the
next migration and commit it alongside the schema change.

**Authentication** is Sign-In with Stellar (SEP-10): there are no passwords and
no third-party auth service. A successful wallet signature creates a row in
`users` + `profiles` and sets a signed HttpOnly session cookie
(`SESSION_SECRET`). See [auth-siws.md](auth-siws.md).

**KYC documents** are stored as private files in
[Vercel Blob](https://vercel.com/docs/storage/vercel-blob); set
`BLOB_READ_WRITE_TOKEN` to enable uploads locally.

### 3.4 Start the Development Server

```bash
npm run dev
```

The app starts at **http://localhost:3000** with hot-reloading enabled.

---

## 4. Smart Contract Setup (Soroban / Rust)

The contracts live in the `contracts/` directory — a Cargo workspace with 16 contract crates (plus `mocks/` for test doubles):

| Crate | Path | Purpose |
|---|---|---|
| `lending` | `contracts/lending/` | Loan lifecycle, repayments, flash loans, fees |
| `borrower_reputation` | `contracts/borrower_reputation/` | Trust score, tiers, credit limits |
| `escrow` | `contracts/escrow/` | Escrow-assisted disbursement with revocation window |
| `default_management` | `contracts/default_management/` | Default marking & insurance pool |
| `pooled_lending` | `contracts/pooled_lending/` | Pooled deposits auto-matched to requests |
| `multisig_admin` | `contracts/multisig_admin/` | N-of-M admin approvals |
| `governance` | `contracts/governance/` | Proposals & voting on protocol parameters |
| `referral_rewards` | `contracts/referral_rewards/` | Referral bonuses on first funded loan |
| `tlend_token` / `tlend_vesting` / `tlend_airdrop` | `contracts/tlend_*/` | Protocol token, vesting, Merkle airdrop |
| `treasury` | `contracts/treasury/` | Fee collection & distribution |
| `auto_compound_vault` | `contracts/auto_compound_vault/` | Auto-compounding yield vault |
| `liquidation_auction` | `contracts/liquidation_auction/` | Dutch auction for liquidated collateral |
| `usdc_lending_pool` | `contracts/usdc_lending_pool/` | USDC-denominated lending pool |
| `borrower_loyalty` | `contracts/borrower_loyalty/` | Loyalty rewards for repeat borrowers |
| `zk_credit_verifier` | `contracts/zk_credit_verifier/` | ZK proof verification for off-chain credit data |

### 4.1 Build All Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

This compiles each contract to a `.wasm` binary in `contracts/target/wasm32-unknown-unknown/release/`.

### 4.2 Run Contract Tests

```bash
cd contracts
cargo test
```

This runs **all** unit tests across the entire workspace. Expect **100+ tests** to pass.

To run tests for a specific contract:

```bash
cargo test -p lending          # Lending contract only
cargo test -p governance       # Governance contract only
cargo test -p multisig-admin   # MultiSig admin contract
```

To run property-based tests (proptest) for the lending contract:

```bash
cargo test -p lending --test proptest_tests -- --test-threads=1
```

### 4.3 Deploy Contracts to Testnet

One command builds, deploys, initializes and wires up every contract, then
writes the resulting contract IDs straight into your `.env.local`:

```bash
npm run deploy:testnet
```

That is all you need. The CLI creates the `trustlend-admin` identity and funds
it from friendbot on your behalf if it does not exist yet — no manual keypair
setup first.

Preview exactly what it would do without touching the network:

```bash
npm run deploy:testnet:dry
```

Useful flags (`npm run deploy:testnet -- --help` lists them all):

| Flag | Purpose |
| --- | --- |
| `--only lending,escrow` | Deploy just these contracts |
| `--resume` | Reuse IDs from the last run instead of redeploying |
| `--skip-build` | Reuse the WASM already in `contracts/target` |
| `--out-env .env.staging` | Write to a different env file |
| `--admin-key <name>` | Stellar CLI identity to deploy from (default `trustlend-admin`) |
| `--dry-run` | Print every command without running it |

If a deploy fails partway through, re-run with `--resume`: contract IDs are
recorded after each individual deployment, so you never pay to deploy the same
contract twice.

After deploying, give the server the admin signer so it can activate loans and
record repayments on-chain (see [onchain-lifecycle.md](onchain-lifecycle.md)):

```bash
stellar keys show trustlend-admin     # → ADMIN_SECRET_KEY in .env.local / Vercel
npx tsx scripts/verify-onchain-lifecycle.ts   # optional: walk the full lifecycle on testnet
```

To deploy a single contract by hand instead:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/lending.wasm \
  --source trustlend-admin \
  --network testnet
```

> The older `contracts/scripts/deploy.sh` and `deploy.ps1` still work, but
> `npm run deploy:testnet` supersedes them — it is cross-platform, deploys the
> pooled-lending contract they missed, and updates `.env.local` for you rather
> than leaving you to copy `.env.contracts` across by hand.

---

## 5. Running the Test Suite

TrustLend has two separate test suites: **frontend** (TypeScript / vitest) and **smart contracts** (Rust / `cargo test`).

### 5.1 Frontend Tests (vitest)

```bash
# Run all frontend tests
npx vitest run

# Run with coverage report
npx vitest run --coverage

# Run a specific test file
npx vitest run lib/utils/formatting.test.ts

# Run tests in watch mode (development)
npx vitest
```

### 5.2 Smart Contract Tests (Rust)

```bash
# Run all contract tests
cd contracts && cargo test

# Run tests with output (useful for debugging)
cd contracts && cargo test -- --nocapture

# Run a specific test by name
cd contracts && cargo test test_flash_loan_success_full_repayment
```

### 5.3 Type Checking

```bash
# Frontend TypeScript check
npx tsc --noEmit

# Rust check (without running tests)
cd contracts && cargo check
```

### 5.4 Linting

```bash
# ESLint for frontend
npm run lint

# Clippy for Rust contracts
cd contracts && cargo clippy --all-targets -- -D warnings -A clippy::inconsistent_digit_grouping
```

### 5.5 Full CI Pipeline (What CI Runs)

Our GitHub Actions CI runs these checks on every PR:

| Workflow | What It Does |
|---|---|
| `ci.yml` — **Test Soroban Contracts** | `cargo test` + WASM build |
| `ci.yml` — **Build Next.js** | `tsc --noEmit` → `eslint` → `vitest run` → `next build`; runs `drizzle-kit migrate` and the Vercel production deploy on pushes to `main` |
| `e2e-playwright.yml` | Playwright end-to-end tests |
| `keepers.yml` | Every 5 minutes: triggers the liquidation keeper and price oracle (needs `KEEPER_BASE_URL` + `CRON_SECRET` secrets) |
| `db-backup.yml` | Nightly encrypted Postgres dump to S3 |
| `contract-security.yml` | `cargo clippy` + `cargo audit` |
| `formal-verification.yml` | proptest + Kani model checking |
| `coverage.yml` | `cargo tarpaulin` → Codecov upload |
| `vercel-preview.yml` | Vercel preview deploy + URL comment |

---

## 6. Common Tasks & Workflows

### Adding a New Smart Contract Crate

1. Create `contracts/<crate_name>/` with a `Cargo.toml` and `src/lib.rs`.
2. Add `"<crate_name>"` to the `[workspace].members` list in `contracts/Cargo.toml`.
3. Add `soroban-sdk = { workspace = true }` to the crate's `Cargo.toml`.
4. Run `cargo build` from `contracts/` to verify it compiles.

### Adding a New Frontend Route

1. Create a file in `app/` following Next.js App Router conventions.
2. If the route needs data, write a server action in `app/actions/`.
3. Add any new components in `components/`.
4. Run `npx tsc --noEmit` to check types.

### Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <description>

<body> (optional)

<footer> (optional)
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `contract`, `stellar`, `security`.

Valid scopes include: `lending`, `escrow`, `governance`, `frontend`, `ci`, `db`, `auth`, `kyc`, etc.

> The Husky commit-msg hook enforces this. Invalid commits will be rejected.

### Creating a Pull Request

1. Create a branch from `main` with a descriptive name:
   ```bash
   git checkout -b feat/lending-add-feature
   ```

2. Make your changes and commit:
   ```bash
   git add -A
   git commit -m "feat(lending): add new feature"
   ```

3. Push and open a PR:
   ```bash
   git push -u origin feat/lending-add-feature
   ```
   Then open a PR at `https://github.com/thisisouvik/trustlend-stellar/pulls`

4. Ensure CI passes. Respond to reviewer feedback.

---

## 7. Troubleshooting

### `stellar: command not found`

The Soroban CLI binary is installed at `~/.cargo/bin/stellar`. Make sure `~/.cargo/bin` is in your `PATH`:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

Add this line to your `~/.bashrc` or `~/.zshrc`.

### `cargo test` fails with WASM-related errors

Make sure the `wasm32-unknown-unknown` target is installed:

```bash
rustup target add wasm32-unknown-unknown
```

### `npm install` fails

- Delete `node_modules` and `package-lock.json`, then retry:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```
- Ensure your Node.js version is >= 20.

### Dashboards are empty / sign-in fails

- Verify `DATABASE_URL` in `.env.local` points at your Neon project and that
  `npm run db:migrate` has been run against it.
- `SESSION_SECRET` must be at least 32 characters; `SIWS_SERVER_SECRET` must
  be a valid Stellar secret key.
- The dev server logs `Database is not configured` when `DATABASE_URL` is
  missing — pages then render their empty states rather than crashing.

### Tests are slow

- For Rust tests, `Swatinem/rust-cache` in CI caches dependencies. Locally, `cargo test` reuses the build cache automatically.
- For vitest, run `npx vitest --changed` to only test changed files.

### Husky commit-msg hook is not running

Ensure husky is installed:

```bash
npx husky init
```

This recreates the `.husky/_/` directory and ensures hooks are activated. The `npm install` command runs `husky` automatically via the `prepare` script.

---

## Next Steps

- Read the [Contributing Guidelines](../CONTRIBUTING.md) for the PR workflow.
- Check the [Roadmap](roadmap.md) for upcoming features.
- Browse project documentation: [Flash Loans](contracts/flash-loans.md), [MultiSig Admin](contracts/multisig-admin.md), [Oracle Integration](contracts/oracle-integration.md), [Governance](contracts/governance.md).
- Join the community discussions on GitHub Issues.
