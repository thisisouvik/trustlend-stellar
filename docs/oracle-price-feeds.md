# Collateral Price Feeds

> Oracle contract invocations use the centralized Stellar SDK RPC transport, including simulation and transaction assembly.

> Implements issue **#267 — integrate a reliable Stellar price oracle to fetch
> real-time valuations of user collateral**: XLM and BTC prices every 5 seconds,
> with a fallback mechanism when the oracle is down.

## The problem this solves

Before this change, every collateral valuation ran on a hardcoded constant:

```bash
LIQUIDATION_XLM_PRICE_USD=0.12   # only changed when a human edited it
```

The liquidation keeper decided whether to seize someone's collateral by
comparing their debt against that number. If XLM moved and nobody updated the
variable, the keeper would either liquidate healthy positions or leave genuinely
under-collateralized ones alone. Both are bad; the first is worse.

## Architecture

```
   CoinGecko      Binance      Stellar DEX (Horizon)
       │             │                │
       └─────────────┼────────────────┘
                     │  collectQuotes() — Promise.allSettled,
                     │  one dead source never blocks the others
                     ▼
             ┌───────────────────┐
             │  aggregatePrice() │  reject outliers → median
             └─────────┬─────────┘
                       │
        ┌──────────────┴───────────────┐
        │      fallback chain          │
        │  1. live median              │
        │  2. last known good (cache)  │
        │  3. on-chain TWAP            │
        │  4. refuse to publish        │
        └──────────────┬───────────────┘
                       ▼
        set_asset_oracle_prices() on LendingContract
                       │
                       ▼
        get_asset_price() → median → TWAP → face value
```

The contract already had the on-chain half — `set_asset_oracle_prices`,
`set_asset_twap_price`, and a `median → TWAP → face value` resolution in
`get_asset_price`. **Nothing was ever pushing real prices into it.** This work
supplies the missing off-chain feeder.

## The 5-second requirement

A scheduled cron route alone cannot meet the acceptance criterion (Vercel Hobby
allows one run per day; GitHub Actions bottoms out at five minutes). The 5-second cadence comes from a long-lived
process, mirroring how `liquidation-keeper` handles its own sub-minute mode:

```bash
npm run price:oracle              # 5s loop — this is the one that meets the criterion
npm run price:oracle:once         # single cycle, for coarse schedulers
npm run price:oracle:dry          # aggregate and log, publish nothing
npm run price:oracle -- --interval=15
```

Run it under Docker, systemd or PM2 on any always-on host.

`/api/cron/price-oracle` is also triggered every 5 minutes by
`.github/workflows/keepers.yml` (and once a day by `vercel.json`) as a
**safety net** — if the long-lived keeper dies, prices still refresh every few
minutes rather than going completely stale. It is not a substitute for the
keeper. Note that each cron invocation starts with empty state, so its
in-memory cache fallback is unavailable and it falls straight through to TWAP.

The loop subtracts the time already spent on work before sleeping, so a slow
cycle does not silently stretch the cadence.

## Fallback chain

This is the second acceptance criterion, and the order matters:

| Step | Source | When it applies |
| --- | --- | --- |
| 1 | **Live median** | Any source responded with a fresh, usable quote |
| 2 | **Cache** | Every source failed, but the last good price is within `ORACLE_MAX_STALENESS_MS` |
| 3 | **On-chain TWAP** | Sources failed *and* the cache has aged out |
| 4 | **Refuse to publish** | Nothing usable anywhere |

Step 4 is deliberate. During a total outage a stale price is **more dangerous
than no price**: the market may have moved through a borrower's liquidation
threshold while the feed was frozen, so publishing the last number we happen to
remember can trigger a liquidation at a valuation that no longer exists. The
keeper logs an error, alerts, and leaves the previous on-chain value in place.

Two related safeguards:

- **A cached price never renews its own freshness.** Only a genuinely `live`
  reading refreshes the last-known-good timestamp. Otherwise a stale price
  would keep resetting its own age and never fall through to TWAP.
- **Unusable quotes are dropped before aggregation.** Zero, negative, `NaN` and
  `Infinity` have all been emitted by real price APIs during incidents, and any
  one of them would produce a nonsensical valuation.

## Source aggregation

Three independent adapters, each of which returns `[]` rather than throwing:

| Source | Symbols | Notes |
| --- | --- | --- |
| CoinGecko | XLM, BTC | Optional `COINGECKO_API_KEY` for higher rate limits |
| Binance | XLM, BTC | USDT pairs, treated as 1 USD |
| Stellar DEX | XLM only | Horizon orderbook mid-price vs USDC |

The Stellar DEX source is the only one native to the chain TrustLend runs on,
so the feed keeps working even if every centralised API is unreachable. BTC is
deliberately **not** quoted from the Stellar DEX — its orderbook there is thin
enough that a mid-price would be misleading.

**Outlier rejection**: with three or more sources, any quote deviating more than
`DEFAULT_OUTLIER_TOLERANCE_BPS` (10%) from the group median is discarded, which
catches a decimal-shifted or zeroed feed before it drags the aggregate. With
only two sources there is no majority to appeal to, so both are kept and the
median is their average.

Every request has a hard timeout well under the poll interval, so one hung
source cannot stall a 5-second cycle.

## Publishing policy

Writing every 5 seconds regardless of movement would burn fees for nothing, so
`shouldPublish()` writes only when:

- there is no on-chain price yet, **or**
- the price moved at least 25 bps (0.25%), **or**
- the last publish was more than 60 seconds ago (heartbeat).

An `unavailable` price is never published, whatever the timings say.

## Integration with liquidation

`runLiquidationKeeper` now asks the oracle for XLM before valuing anything:

```
live oracle price  →  used for every valuation in the run
    ↓ (nothing usable)
LIQUIDATION_XLM_PRICE_USD  →  the old constant, now only a fallback
```

The keeper never aborts a run over a price lookup — it logs and falls back.
Live lookups are disabled automatically under test (`VITEST` / `NODE_ENV=test`)
and via `LIQUIDATION_USE_LIVE_PRICES=false`, so unit tests never touch a real
price API.

## Integration with the borrower health factor (issue #323)

The borrower dashboard's health factor gauge valued debt against a hardcoded
`XLM_PRICE_USD = 0.10`. A health factor computed from a constant reports the
same number whether XLM is at $0.08 or $0.40, so it could never warn a borrower
that a position was approaching liquidation.

`lib/dashboard/collateral-pricing.ts` routes that valuation through the same
feed:

```
live oracle price  →  cache  →  on-chain TWAP   (lib/oracle/live-prices.ts)
    ↓ (nothing usable)
FALLBACK_XLM_PRICE_USD = 0.12  →  matches LIQUIDATION_XLM_PRICE_USD
```

Both surfaces degrade to the same constant, so the dashboard and the keeper
never disagree about what a position is worth.

Unlike liquidation, a dashboard must still render when every source is down, so
the resolver always returns a usable price and reports its provenance instead of
returning `null`:

| Field | Meaning |
|---|---|
| `origin` | `live` / `cache` / `twap` / `unavailable` |
| `usedFallback` | true when no oracle reading was usable |
| `isStale` | true for any non-live origin, or a live price past the 120 s window |
| `label` | human-readable provenance, rendered under the gauge |

The gauge is captioned with the price and its provenance, warning-styled
whenever `isStale` is set, so a borrower is never shown a stale valuation that
looks live. Live lookups are skipped under test and via
`DASHBOARD_USE_LIVE_PRICES=false`.

Collateral remains an assumption (150% of outstanding debt, flagged by
`collateralIsAssumed`) until per-loan collateral is read from on-chain records —
that part of the gauge is unchanged by this issue.

## Wiring it on-chain

The keeper ships with a **dry-run publisher**: it aggregates and logs, but does
not sign transactions. Signing needs an authorised key, so publishing is
deliberately opt-in rather than something that silently starts moving state.

To go live, implement `PricePublisher` against the contract:

```ts
// publish → set_asset_oracle_prices(caller, asset, [price])
// readTwap → read DataKey::OracleTwapPrice for the asset
```

`set_asset_oracle_prices` is **multisig-gated** (`assert_multisig_admin`), so
the signer must be a registered multisig admin, and the asset must already be
whitelisted. Configure the assets first:

```bash
stellar contract invoke --id "$LENDING_ID" -- set_asset_collateral_config \
  --caller "$ADMIN" --asset "$XLM_ASSET" \
  --config '{"collateral_factor_bps":7500,"has_price_oracle":true,"volatility_bps":2000}'
```

`has_price_oracle: true` is what makes `get_asset_price` consult the oracle at
all; with it false the asset is valued at face value regardless of what is
published.

Seed a TWAP as well, so step 3 of the fallback chain is real rather than
theoretical:

```bash
stellar contract invoke --id "$LENDING_ID" -- set_asset_twap_price \
  --caller "$ADMIN" --asset "$XLM_ASSET" --price 1200000
```

## Configuration

See the `Collateral Price Oracle` block in `.env.example`. The ones that matter
most:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORACLE_POLL_INTERVAL_SECS` | `5` | Poll cadence |
| `ORACLE_MAX_STALENESS_MS` | `120000` | Age past which a price is unusable |
| `ORACLE_XLM_ASSET_ADDRESS` | — | Without it, XLM is aggregated but never published |
| `ORACLE_BTC_ASSET_ADDRESS` | — | Same for BTC |
| `ORACLE_DISABLE_*` | `false` | Drop an individual source |

## Tests

- `__tests__/lib/oracle-prices.test.ts` — aggregation, outlier rejection,
  the full fallback chain, fixed-point conversion, publish policy.
- `__tests__/lib/oracle-sources.test.ts` — each adapter against an injected
  fetch, including timeouts, non-OK responses, malformed JSON, and one source
  throwing while others succeed.
- `__tests__/scripts/price-oracle-keeper.test.ts` — config parsing, a full
  cycle for both symbols, every fallback branch, per-symbol failure isolation,
  and cache hygiene.

```bash
npm test -- oracle
```

## Known limitations

- **Publishing is dry-run until a `PricePublisher` is implemented.** The
  aggregation, fallback and policy layers are complete and tested; the on-chain
  write is a documented seam, because it needs a multisig-admin signer that
  cannot be safely defaulted.
- **BTC has no Stellar-native source**, so during a total CEX/API outage BTC
  falls to cache then TWAP faster than XLM does.
- **USDT is treated as 1 USD.** At this scale the median across sources absorbs
  a small depeg, but a severe one would bias the Binance leg.
