/**
 * Collateral price oracle keeper (Issue #267).
 *
 * Polls XLM and BTC prices every 5 seconds from several independent sources,
 * aggregates them, and pushes the result on-chain so the lending contract can
 * value collateral against a live market instead of the hardcoded constants
 * the liquidation keeper used to rely on.
 *
 * Vercel Cron cannot go below one minute, so the 5-second cadence needs a
 * long-lived process. This mirrors `scripts/liquidation-keeper.ts`:
 *
 *   npm run price:oracle                  # 5s loop (default)
 *   npm run price:oracle -- --once        # single cycle, for cron
 *   npm run price:oracle -- --dry-run     # fetch and aggregate, publish nothing
 *   npm run price:oracle -- --interval=15 # custom cadence
 *
 * Fallback chain, in order: live median → cached price → on-chain TWAP →
 * refuse to publish. The last step is deliberate — during a total outage a
 * stale price is more dangerous than no price, because it can trigger a
 * liquidation at a valuation the market has already moved away from.
 */

import {
  aggregatePrice,
  shouldPublish,
  toChainPrice,
  TRACKED_SYMBOLS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_MAX_STALENESS_MS,
  type AggregatedPrice,
  type CachedPrice,
  type PriceSymbol,
} from "../lib/oracle/prices";
import {
  collectQuotes,
  createDefaultSources,
  type PriceSource,
} from "../lib/oracle/sources";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface OracleKeeperConfig {
  /** Milliseconds between cycles. */
  intervalMs: number;
  /** Run a single cycle and exit. */
  once: boolean;
  /** Aggregate but never write on-chain. */
  dryRun: boolean;
  maxStalenessMs: number;
  /** Contract addresses of the assets, keyed by symbol. */
  assetAddresses: Partial<Record<PriceSymbol, string>>;
  lendingContractId: string;
  adminAddress: string;
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    args[key] = value === undefined ? true : value;
  }
  return args;
}

export function loadOracleConfig(
  argv: string[] = process.argv.slice(2),
  // Only optional string vars are read, so accept any env-shaped record. Using
  // NodeJS.ProcessEnv here would force callers (tests) to supply NODE_ENV.
  env: Record<string, string | undefined> = process.env,
): OracleKeeperConfig {
  const args = parseArgs(argv);

  const intervalRaw = (args.interval as string) ?? env.ORACLE_POLL_INTERVAL_SECS;
  const intervalSecs = intervalRaw ? Number(intervalRaw) : null;

  return {
    // The issue asks for 5 seconds; anything non-positive falls back to it.
    intervalMs:
      intervalSecs && intervalSecs > 0
        ? intervalSecs * 1000
        : DEFAULT_POLL_INTERVAL_MS,
    once: Boolean(args.once) || env.ORACLE_RUN_ONCE === "true",
    dryRun: Boolean(args["dry-run"]) || env.ORACLE_DRY_RUN === "true",
    maxStalenessMs: Number(
      env.ORACLE_MAX_STALENESS_MS ?? DEFAULT_MAX_STALENESS_MS,
    ),
    assetAddresses: {
      XLM: env.ORACLE_XLM_ASSET_ADDRESS,
      BTC: env.ORACLE_BTC_ASSET_ADDRESS,
    },
    lendingContractId: env.NEXT_PUBLIC_LENDING_CONTRACT_ID ?? "",
    adminAddress: env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "",
    slackWebhookUrl: env.ORACLE_SLACK_WEBHOOK_URL ?? env.LIQUIDATION_SLACK_WEBHOOK_URL,
    discordWebhookUrl:
      env.ORACLE_DISCORD_WEBHOOK_URL ?? env.LIQUIDATION_DISCORD_WEBHOOK_URL,
  };
}

// ─── Alerting ───────────────────────────────────────────────────────────────

export type AlertLevel = "info" | "warn" | "error";

async function postJson(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn("[price-oracle] Alert delivery failed:", err);
  }
}

export async function sendOracleAlert(
  cfg: Pick<OracleKeeperConfig, "slackWebhookUrl" | "discordWebhookUrl">,
  level: AlertLevel,
  message: string,
): Promise<void> {
  const badge = { info: "✅", warn: "⚠️", error: "❌" }[level];
  const tasks: Promise<unknown>[] = [];

  if (cfg.slackWebhookUrl) {
    tasks.push(
      postJson(cfg.slackWebhookUrl, {
        text: `${badge} *TrustLend Price Oracle*\n${message}`,
      }),
    );
  }
  if (cfg.discordWebhookUrl) {
    tasks.push(
      postJson(cfg.discordWebhookUrl, {
        content: `${badge} **TrustLend Price Oracle**\n${message}`,
      }),
    );
  }

  // One failing webhook must not stop the other, nor the poll loop.
  await Promise.allSettled(tasks);
}

// ─── Publisher seam ─────────────────────────────────────────────────────────

/**
 * How a price reaches the chain. Abstracted so the cycle logic can be tested
 * without a network, and so the real implementation (stellar-sdk invoke of
 * `set_asset_oracle_prices`) can be swapped in without touching the loop.
 */
export interface PricePublisher {
  /** Push a price. Should throw on failure so the cycle can alert. */
  publish(
    symbol: PriceSymbol,
    assetAddress: string,
    chainPrice: bigint,
  ): Promise<void>;
  /** Read the on-chain TWAP fallback, or null when unavailable. */
  readTwap(symbol: PriceSymbol, assetAddress: string): Promise<number | null>;
}

/** A publisher that logs instead of writing. Used by --dry-run. */
export function createDryRunPublisher(): PricePublisher {
  return {
    async publish(symbol, assetAddress, chainPrice) {
      console.log(
        `[price-oracle] [DRY RUN] would publish ${symbol} = ${chainPrice} (7dp) to ${assetAddress}`,
      );
    },
    async readTwap() {
      return null;
    },
  };
}

// ─── Cycle ──────────────────────────────────────────────────────────────────

export interface CycleSummary {
  polled: number;
  published: number;
  skipped: number;
  unavailable: number;
  failed: number;
  /** Aggregated result per symbol, for logging. */
  results: AggregatedPrice[];
  aborted?: boolean;
  abortReason?: string;
}

export interface OracleCycleOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CycleSummary) => Promise<void> | void;
}

/** In-memory cache of the last good price and the last published price. */
export interface KeeperState {
  lastGood: Partial<Record<PriceSymbol, CachedPrice>>;
  lastPublished: Partial<Record<PriceSymbol, CachedPrice>>;
}

export function createInitialState(): KeeperState {
  return { lastGood: {}, lastPublished: {} };
}

/**
 * One full poll → aggregate → publish cycle.
 *
 * Every step is individually error-handled: one bad symbol never aborts the
 * run, matching the liquidation keeper's conventions.
 */
export async function runOracleCycle(
  cfg: OracleKeeperConfig,
  sources: PriceSource[],
  publisher: PricePublisher,
  state: KeeperState,
  now: number = Date.now(),
  options?: OracleCycleOptions,
): Promise<CycleSummary> {
  const summary: CycleSummary = {
    polled: 0,
    published: 0,
    skipped: 0,
    unavailable: 0,
    failed: 0,
    results: [],
  };

  if (options?.signal?.aborted) {
    summary.aborted = true;
    summary.abortReason = "Execution deadline reached; safely aborted price-oracle cycle";
    return summary;
  }

  const { quotes, failedSources } = await collectQuotes(sources, TRACKED_SYMBOLS);
  summary.polled = quotes.length;

  if (failedSources.length > 0) {
    console.warn(
      `[price-oracle] ${failedSources.length} source(s) unavailable: ${failedSources.join(", ")}`,
    );
  }

  for (const symbol of TRACKED_SYMBOLS) {
    if (options?.signal?.aborted) {
      summary.aborted = true;
      summary.abortReason = "Execution deadline reached; safely aborted price-oracle cycle";
      break;
    }

    try {
      const assetAddress = cfg.assetAddresses[symbol];

      // Read the on-chain TWAP only when we might actually need it.
      let twapUsd: number | null = null;
      const symbolQuotes = quotes.filter((q) => q.symbol === symbol);
      if (symbolQuotes.length === 0 && assetAddress) {
        twapUsd = await publisher
          .readTwap(symbol, assetAddress)
          .catch(() => null);
      }

      const result = aggregatePrice(symbol, quotes, {
        now,
        maxStalenessMs: cfg.maxStalenessMs,
        cached: state.lastGood[symbol] ?? null,
        twapUsd,
      });
      summary.results.push(result);

      if (result.priceUsd === null) {
        summary.unavailable++;
        console.error(`[price-oracle] ${symbol}: ${result.reason}`);
        await sendOracleAlert(
          cfg,
          "error",
          `No usable price for ${symbol}. ${result.reason}`,
        );
        continue;
      }

      // Only a genuinely live price refreshes the cache. Caching a cached or
      // TWAP value would let a stale price renew its own freshness forever.
      if (result.origin === "live") {
        state.lastGood[symbol] = { priceUsd: result.priceUsd, observedAt: now };
      }

      if (!assetAddress) {
        summary.skipped++;
        console.warn(
          `[price-oracle] ${symbol}: no asset address configured — skipping publish.`,
        );
        continue;
      }

      const lastPublished = state.lastPublished[symbol] ?? null;
      if (!shouldPublish(result, lastPublished, { now })) {
        summary.skipped++;
        continue;
      }

      await publisher.publish(symbol, assetAddress, toChainPrice(result.priceUsd));
      state.lastPublished[symbol] = { priceUsd: result.priceUsd, observedAt: now };
      summary.published++;

      console.log(
        `[price-oracle] ${symbol} = $${result.priceUsd} (${result.origin}, ${result.contributingSources.join("+") || "fallback"})`,
      );
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[price-oracle] ${symbol} failed:`, msg);
    }

    if (options?.onProgress) {
      await options.onProgress(summary);
    }
  }

  return summary;
}

// ─── Loop ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOracleKeeper(
  cfg: OracleKeeperConfig,
  sources: PriceSource[],
  publisher: PricePublisher,
): Promise<void> {
  const state = createInitialState();
  let consecutiveOutages = 0;

  console.log(
    `[price-oracle] Starting — tracking ${TRACKED_SYMBOLS.join(", ")} every ${cfg.intervalMs}ms` +
      `${cfg.dryRun ? " (dry run)" : ""} across ${sources.length} source(s).`,
  );

  for (;;) {
    const started = Date.now();
    try {
      const summary = await runOracleCycle(cfg, sources, publisher, state);

      if (summary.unavailable > 0) {
        consecutiveOutages++;
        // Alert once on sustained failure rather than every 5 seconds.
        if (consecutiveOutages === 12) {
          await sendOracleAlert(
            cfg,
            "error",
            `Price feed has been unavailable for ${consecutiveOutages} consecutive cycles.`,
          );
        }
      } else if (consecutiveOutages > 0) {
        await sendOracleAlert(
          cfg,
          "info",
          `Price feed recovered after ${consecutiveOutages} failed cycle(s).`,
        );
        consecutiveOutages = 0;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[price-oracle] Cycle failed:", msg);
      if (cfg.once) process.exitCode = 1;
    }

    if (cfg.once) break;

    // Subtract the work already done so the cadence stays honest under load.
    const elapsed = Date.now() - started;
    await sleep(Math.max(0, cfg.intervalMs - elapsed));
  }
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadOracleConfig();
  const sources = createDefaultSources();

  if (sources.length === 0) {
    console.error("[price-oracle] No price sources enabled — nothing to do.");
    process.exitCode = 1;
    return;
  }

  // Publishing on-chain requires a signer. Until ORACLE_SECRET_KEY is wired to
  // a real stellar-sdk invoke, run in dry-run mode rather than silently doing
  // nothing, so the operator can see the aggregated prices.
  const publisher = createDryRunPublisher();
  if (!cfg.dryRun) {
    console.warn(
      "[price-oracle] On-chain publishing is not configured; running in dry-run mode. " +
        "See docs/oracle-price-feeds.md for the set_asset_oracle_prices wiring.",
    );
  }

  await runOracleKeeper(cfg, sources, publisher);
}

// Only auto-run when invoked directly, so the cron route and tests can import
// this module without starting an endless poll loop. Matches the guard in
// scripts/liquidation-keeper.ts.
const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error("[price-oracle] Fatal error:", err);
    process.exit(1);
  });
}
