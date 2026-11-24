# Contributing to TrustLend

Thanks for your interest in TrustLend! This guide covers how to set up a
development environment, the conventions we follow, and how to get a change
merged. For the full local-setup walkthrough (Rust/Soroban toolchain, database,
tests) see [docs/getting-started.md](docs/getting-started.md).

## Ways to contribute

- **Report bugs** or **request features** through
  [GitHub Issues](https://github.com/thisisouvik/trustlend-stellar/issues) using
  the provided templates. For anything security-related, follow
  [SECURITY.md](SECURITY.md) instead of opening a public issue.
- **Improve documentation** — everything under [`docs/`](docs/) and the README.
- **Write code** — frontend (Next.js / React), backend routes, or Soroban
  contracts in [`contracts/`](contracts/). Issues labelled `good first issue`
  are a good starting point, and the "contract only" crates listed in the README
  still need frontend wiring.

Before starting on a larger change, open an issue (or comment on an existing
one) so we can agree on the approach first.

## Development setup

```bash
git clone https://github.com/<your-username>/trustlend-stellar.git
cd trustlend-stellar
git remote add upstream https://github.com/thisisouvik/trustlend-stellar.git

npm install                      # also installs the Husky commit hook
cp .env.example .env.local       # set DATABASE_URL, SESSION_SECRET, SIWS_SERVER_SECRET
npm run db:migrate               # apply Drizzle migrations to your Neon database
npm run dev                      # http://localhost:3000
```

Contract work additionally needs a Rust toolchain with the
`wasm32-unknown-unknown` target and the `stellar` CLI — see
[docs/getting-started.md](docs/getting-started.md#4-smart-contract-setup-soroban--rust).

## Branches

Work on a branch created from an up-to-date `main`:

```bash
git checkout main
git pull upstream main
git checkout -b feat/short-description     # or fix/…, docs/…, chore/…
```

Rebase onto `main` (rather than merging) when you need to pick up changes.

## Commit messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/);
a `commit-msg` hook runs commitlint and rejects anything that doesn't match.

```
<type>(<scope>): <short summary>

<optional body explaining what and why>
```

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`, `revert`, plus project-specific `contract`,
  `stellar` and `security`.
- **Scopes** (required): `lending`, `escrow`, `governance`,
  `default-management`, `multisig-admin`, `borrower-reputation`,
  `auto-compound-vault`, `treasury`, `contracts`, `frontend`, `dashboard`,
  `auth`, `kyc`, `api`, `ci`, `db`, `neon`, `drizzle`, `stellar`, `soroban`,
  `docs`, `deps`, `config`, `landing`, `hooks`, `referrals`.

Examples: `feat(lending): add early-repayment discount`,
`fix(auth): reject expired SEP-10 challenges`, `docs(contracts): document escrow revocation window`.
The complete rule set lives in [`commitlint.config.ts`](commitlint.config.ts).

## Before opening a pull request

Run the same checks CI runs:

```bash
npx tsc --noEmit          # type check
npm run lint              # ESLint
npm test                  # Vitest unit tests
npm run build             # Next.js production build

# if you touched contracts/
cd contracts
cargo test
cargo clippy --all-targets -- -D warnings -A clippy::inconsistent_digit_grouping
cargo build --target wasm32-unknown-unknown --release
```

A few conventions to keep in mind:

- Add or update tests for behaviour you change (`__tests__/` for the app,
  `#[cfg(test)]` modules for contracts).
- Schema changes go through Drizzle: edit `lib/db/schema.ts`, run
  `npm run db:generate`, and commit the generated migration in `drizzle/`.
- Use the design tokens in `app/theme.css` and the primitives in
  `components/ui/` for UI work so both light and dark themes keep working.
- Never commit secrets. `.env.local` is git-ignored; `.env.example` documents
  every variable.

## Pull requests

1. Push your branch to your fork and open a PR against `main`.
2. Fill in the PR template: what changed, why, how it was tested, and
   screenshots for UI changes.
3. Keep PRs focused. Unrelated refactors are easier to review as separate PRs.
4. CI must pass. A maintainer will review; please respond to feedback in the
   same PR rather than opening a new one.

Maintainers merge a PR once it passes CI, has at least one approval, has no
outstanding change requests, and is up to date with `main`.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it.
