# Referral Program

> Implements issue **#266 — referral program for new users**: users get a
> unique referral link, and the bonus is paid out automatically by a smart
> contract when an invited friend takes out a loan.

## How it works

```
  Alice                     TrustLend                      Chain
    │                           │                            │
    │ 1. copies her link        │                            │
    │    /auth?ref=TL7F3KQ2     │                            │
    ├──────────────────────────►│                            │
    │                           │                            │
  Bob (invited)                 │                            │
    │ 2. opens the link,        │                            │
    │    connects wallet        │                            │
    ├──────────────────────────►│ record_referral()          │
    │                           │ referrals row = 'pending'  │
    │                           ├───────────────────────────►│ register_referral
    │                           │                            │ ReferrerOf[Bob]=Alice
    │ 3. requests a loan        │                            │
    │    lenders fund it 100%   │                            │
    ├──────────────────────────►│ activate_loan()            │
    │                           ├───────────────────────────►│ claim_referral_bonus
    │                           │                            │ transfer TLND → Alice
    │                           │ qualify_referral()         │
    │                           │ referrals row = 'qualified'│
    │ 4. Alice is notified      │◄───────────────────────────┤
    │◄──────────────────────────┤                            │
```

The **payout is on-chain and automatic**. `LendingContract::activate_loan`
invokes `ReferralRewardsContract::claim_referral_bonus` in the same
transaction, so no admin ever has to approve or send a bonus by hand.

## The unique link

Each profile carries a `referral_code` such as `TL7F3KQ2`:

- **Prefix** `TL`, then 6 random characters.
- **Alphabet** `23456789ABCDEFGHJKMNPQRSTVWXYZ` — 30 characters with `0`, `O`,
  `1`, `I`, `L` and `U` removed, so a code cannot be misread when it is spoken
  aloud or retyped.
- **Code space** 30⁶ ≈ 729 million, which makes enumerating other people's
  codes impractical.
- Generated with rejection sampling over `crypto.getRandomValues` so the
  distribution is uniform. There is no `Math.random()` fallback — if secure
  randomness is unavailable the generator throws rather than emitting
  predictable codes.

Codes are assigned by a `BEFORE INSERT` trigger on `profiles`, backfilled for
existing users by the migration, and created on demand by
`ensure_referral_code()` for anyone the trigger missed.

Input is normalised before use: lowercase, surrounding whitespace and the
separators people type by hand (`tl-7f3-kq2`) are all accepted, but a stray
extra character is rejected rather than silently stripped.

## The contract

`contracts/referral_rewards` holds the reward pool and all payout rules.

### Bonus formula

```
bonus = base_bonus × min(loan_amount / reference_loan_amount, max_size_multiplier)
```

so a friend borrowing the reference amount earns the full `base_bonus`, half
that amount earns half the bonus, and a very large loan is capped.

### Guarantees

| Rule | Where it is enforced |
| --- | --- |
| A referee is attributed to exactly one referrer, forever | `ReferrerOf` is written once; re-registration panics |
| One bonus per referred friend, however many loans they take | `BonusPaid(referee)` flag, checked and set in the payout path |
| Self-referral earns nothing | Rejected at registration, re-checked at payout |
| Only the lending contract can trigger a payout | `caller != lending → return 0` |
| Dust loans do not qualify | `min_qualifying_loan` |
| One referrer cannot drain the pool | `max_referrals_per_referrer` |
| A drained pool never blocks a loan | pays `min(reward, balance)`, returns 0 instead of panicking |
| A broken referral contract never blocks a loan | lending calls it via `try_invoke_contract` with a `_ => 0` fallback |

The last two matter most: a referral is a bonus, never a precondition. A
borrower's loan must activate even if the referral contract is unset, out of
funds, misconfigured, or panicking.

### Config

`ReferralConfig` is admin-tunable at runtime via `set_config`:

| Field | Meaning |
| --- | --- |
| `base_bonus` | Full bonus, in reward-token stroops |
| `reference_loan_amount` | Loan size that earns the full bonus |
| `max_size_multiplier_bps` | Cap on the size multiplier |
| `min_qualifying_loan` | Smallest loan that earns anything |
| `max_referrals_per_referrer` | Lifetime cap per referrer; `0` = unlimited |

## Database

The Drizzle schema (`lib/db/schema.ts`, applied by `drizzle/0000_init.sql` and `drizzle/0001_functions_and_triggers.sql`) adds:

- `profiles.referral_code` — unique, indexed, backfilled.
- `public.referrals` — one row per invited user, with `status` moving
  `pending → qualified → paid`. `referee_id` is `UNIQUE`, mirroring the
  contract's immutable attribution, and a `CHECK` blocks self-referral.
- `record_referral()`, `qualify_referral()`, `settle_referral_payout()`,
  `get_referral_stats()`, `ensure_referral_code()`.

All write paths are `SECURITY DEFINER`. **No direct insert or update policy is
granted to authenticated users**, so nobody can attribute themselves to a
referrer or mark their own bonus as paid. RLS on reads lets a referrer see who
they invited and an invited user see their own edge.

The chain remains the source of truth for whether a bonus was actually
transferred; the table mirrors it so the dashboard can render progress without
an RPC round-trip per row.

## Application wiring

| Piece | Path |
| --- | --- |
| Code generation and link building | `lib/referrals/codes.ts` |
| Origin resolution for absolute links | `lib/referrals/site-url.ts` |
| Qualification hook | `lib/referrals/qualify.ts` |
| Link + stats API | `app/api/referrals/route.ts` |
| Attribution API | `app/api/referrals/claim/route.ts` |
| Dashboard UI | `components/dashboard/ReferralWidget.tsx` |
| Invite-code capture | `components/dashboard/ReferralCapture.tsx` |
| Page | `app/dashboard/borrower/referrals/page.tsx` |

Because authentication is wallet-based (SIWS), a visitor arriving on an invite
link does not sign up in one step. The code is stashed in `sessionStorage` on
`/auth`, then claimed from the dashboard once a session exists.
`sessionStorage` rather than `localStorage` is deliberate: a code should not
outlive the browsing session and silently attribute an unrelated later signup.

## Deployment

`stellar contract build` picks up the new crate automatically. The contract is
initialised by its constructor, so its configuration is passed to the deploy
itself — there is no separate `initialize` call that could be front-run
(issue #352). Deploy it, then wire the remaining links:

```bash
# 1. Deploy + initialise the referral contract in one transaction
REFERRAL_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/referral_rewards.wasm \
  --source "$ADMIN_KEY" --network testnet \
  -- \
  --admin "$ADMIN" \
  --reward_token "$TLND_TOKEN_ID" \
  --lending_contract "$LENDING_ID" \
  --config '{"base_bonus":"100000000","reference_loan_amount":"10000000000","max_size_multiplier_bps":20000,"min_qualifying_loan":"1000000000","max_referrals_per_referrer":0}')

# 2. Point the lending contract at it (enables automatic payouts)
stellar contract invoke --id "$LENDING_ID" -- set_referral_contract \
  --admin "$ADMIN" --referral "$REFERRAL_ID"

# 3. Fund the reward pool — without this every bonus resolves to 0
stellar contract invoke --id "$TLND_TOKEN_ID" -- transfer \
  --from "$TREASURY" --to "$REFERRAL_ID" --amount 1000000000000
```

Leaving `set_referral_contract` unset simply disables referral payouts; loans
continue to work normally.

**Top the pool up.** An empty pool pays 0 and leaves the referee *unflagged*,
so the referrer still earns once it is refilled — but the bonus is not
retroactively backfilled by any job. Monitor the balance.

## Tests

- `contracts/referral_rewards/src/test.rs` — 26 tests: bonus maths and caps,
  one-bonus-per-referee, self-referral, re-attribution, non-lending callers,
  the per-referrer cap, empty and partially funded pools, admin controls.
- `contracts/lending/src/test.rs` — 8 integration tests proving the payout is
  automatic end-to-end (`test_activation_pays_referrer_automatically`), that an
  unreferred borrower pays nothing, that a second loan earns no second bonus,
  and that activation still succeeds with an empty pool or a broken referral
  contract.
- `__tests__/lib/referral-codes.test.ts` — code generation, alphabet safety,
  normalisation, link building and extraction.
- `__tests__/lib/referral-site-url.test.ts` — origin resolution precedence.

```bash
cd contracts && cargo test -p referral-rewards -p lending
npm test -- referral
```
