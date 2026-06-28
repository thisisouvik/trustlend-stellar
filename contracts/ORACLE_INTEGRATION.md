# Decentralized Credit Score Oracle — Integration Design

> Implements issue **#20 — [Smart Contracts] Implement Decentralized Credit Score Oracle integration**
> and the README "Vision" item *Decentralized Credit Oracles*.

TrustLend lends under-collateralized capital based on **on-chain reputation**. That
reputation only grows from on-chain loan history, which is a cold-start problem for
new borrowers. This oracle pattern lets us bridge **verified Web2 / off-chain data**
(utility bills, mobile-money / telecom history, banking cash-flow) into the
`BorrowerReputationContract` so a borrower's **maximum loan limit** can be raised
before they have an on-chain track record.

---

## 1. The pattern (push oracle, single authorized signer)

Soroban contracts cannot make outbound HTTP calls, so off-chain data must be
**pushed in** by a transaction. We use the simplest trustworthy pattern:

```
┌──────────────┐   verify (OAuth, signatures)   ┌────────────────────────┐
│  Web2 source │ ─────────────────────────────► │  Off-chain Oracle (Node)│
│ utility /    │                                │  scripts/oracle-post-    │
│ telecom /    │   normalise → score 0..1000    │  credit-score.mjs        │
│ banking      │ ─────────────────────────────► │  (holds ORACLE_SECRET)   │
└──────────────┘                                └───────────┬────────────┘
                                                            │ submit_credit_score
                                          signed by the authorized oracle key
                                                            ▼
                                          ┌──────────────────────────────┐
                                          │ BorrowerReputationContract     │
                                          │  • assert caller == oracle     │
                                          │  • store OracleCreditData       │
                                          │  • boost calculate_max_loan()   │
                                          └──────────────────────────────┘
```

**Why a single authorized signer (not a multi-feeder median)?**
For this stage it keeps trust auditable and gas minimal: the admin registers exactly
one oracle address via `set_oracle`, and only that address can call
`submit_credit_score`. The design leaves clean seams to evolve toward a decentralized
multi-feeder / median model later (see §6).

---

## 2. On-chain data model

```rust
pub struct OracleCreditData {
    pub credit_score: u32,          // normalised 0..=1000
    pub data_sources: u32,          // # of verified Web2 sources behind the score
    pub loan_limit_boost_bps: u32,  // derived on-chain, capped at 10_000 (+100%)
    pub provider: String,           // "mobile-money" | "plaid" | ...
    pub updated_at: u64,            // ledger timestamp (freshness)
}
```

Stored in **persistent** storage keyed by `DataKey::OracleData(borrower)`.
The authorized oracle address lives in **instance** storage at `DataKey::Oracle`.

## 3. Contract API (added to `borrower_reputation`)

| Function | Auth | Purpose |
|---|---|---|
| `set_oracle(admin, oracle)` | admin | Register / rotate the authorized oracle |
| `get_oracle()` | — | Read the authorized oracle address |
| `submit_credit_score(oracle, borrower, credit_score, data_sources, provider)` | oracle | Ingest verified off-chain data |
| `has_oracle_data(borrower)` | — | Whether oracle data exists |
| `get_oracle_data(borrower)` | — | Read the latest oracle record |
| `calculate_max_loan(borrower)` | — | **Now applies a fresh oracle boost on top of the tier limit** |

### How the limit is boosted

```
base   = tier_max_loan(tier)                     // reputation-based
boost  = base * loan_limit_boost_bps / 10_000    // oracle-based, only if fresh
max    = base + boost
```

- `loan_limit_boost_bps` is derived **on-chain** from `credit_score`
  (`score * 10_000 / 1_000`), so the score→limit mapping is auditable, not
  attacker-supplied.
- A record older than **90 days** (`ORACLE_VALIDITY_SECONDS`) is ignored — stale
  Web2 data cannot keep inflating a limit forever.
- **Frozen** accounts get no boost, and the oracle cannot post for them.
- Interest rate is intentionally left tier-only for now; oracle data affects
  *limits*, exactly as the issue specifies.

### Safety properties

- **Authorization:** `submit_credit_score` requires `oracle.require_auth()` **and**
  asserts the caller equals the registered oracle. A spoofed caller panics.
- **Bounded input:** `credit_score > 1000` is rejected; the boost is capped at +100%.
- **No overflow:** base ≤ 1e12 stroops × boost ≤ 1e4 bps ⇒ ≤ 1e16, well within
  `i128`. (Workspace builds with `overflow-checks = true`.)

## 4. Off-chain oracle script

`scripts/oracle-post-credit-score.mjs` (`npm run oracle:post`) is the authorized
Node poster:

```bash
# Aggregate verified signals → score → post on-chain
npm run oracle:post -- \
  --borrower GB...BORROWER \
  --utility 0.92 --telecom 0.80 --banking 0.75 \
  --provider mobile-money

# Or from a verified-data JSON file
npm run oracle:post -- --borrower GB... --data ./verified.json

# Simulate only (no signing / no submit)
npm run oracle:post -- --borrower GB... --utility 0.9 --dry-run
```

It signs with `ORACLE_SECRET_KEY` (server-only) and targets
`NEXT_PUBLIC_REPUTATION_CONTRACT_ID`. The score is a transparent weighted blend of
normalised `[0,1]` signals (weights in the script); the contract independently
re-derives the loan boost, so the trust boundary stays on-chain.

> The script assumes Web2 verification (OAuth into the provider, payload signature
> checks, KYC binding of the wallet) has already happened upstream — it is the
> *poster*, not the *verifier*.

## 5. Setup

1. Generate an oracle key and fund it on testnet:
   ```bash
   stellar keys generate trustlend-oracle --global
   export ORACLE_ADDRESS=$(stellar keys address trustlend-oracle)
   curl "https://friendbot.stellar.org/?addr=$ORACLE_ADDRESS"
   ```
2. Deploy (the deploy script auto-registers the oracle when `ORACLE_ADDRESS` is set):
   ```bash
   cd contracts && ./scripts/deploy.sh
   ```
   Or register manually:
   ```bash
   stellar contract invoke --id <REPUTATION_ID> --source trustlend-admin --network testnet \
     -- set_oracle --admin <ADMIN_ADDRESS> --oracle <ORACLE_ADDRESS>
   ```
3. Put `NEXT_PUBLIC_ORACLE_ADDRESS` and `ORACLE_SECRET_KEY` in `.env.local`
   (see `.env.example`).

## 6. Future evolution (intentional seams)

- **Multiple feeders + median:** store one record per feeder and take a median /
  trimmed-mean in `calculate_max_loan`, requiring N-of-M agreement.
- **Reflector / SEP-40 price-style oracles** for FX when limits are denominated in
  fiat.
- **Per-provider weighting & decay** stored on-chain and governed by the DAO.
- **Score → interest-rate** influence (kept out of scope here, which only adjusts
  limits per the issue).
