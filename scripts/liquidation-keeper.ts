#!/usr/bin/env -S npx tsx
// =============================================================================
// TrustLend — Automated Liquidation Keeper (issue #72)
// =============================================================================
// Monitors open loans for under-collateralization and liquidates them on-chain
// before the protocol takes on bad debt. Deployed as a background worker that
// polls every minute via the `/api/cron/liquidation` Vercel Cron endpoint (or
// `npm run liquidation:keeper:service` self-hosted); also runnable as a one-shot
// cron invocation.
//
// Flow:
//   1. Fetch open (Active) loans — from the database (`--source=db`, default) or
//      directly from the LendingContract (`--source=chain`).
//   2. For each loan, read its authoritative on-chain record (collateral +
//      remaining debt), the borrower's reputation score, and the dynamic
//      liquidation threshold the contract itself computes.
//   3. Query asset prices (on-chain Reflector-style oracle if configured, else
//      a static/env-configured price table) to compute the current LTV.
//   4. If LTV >= threshold, submit a liquidation transaction
//      (`lending.mark_defaulted`) signed by the admin key.
//   5. Post a Slack/Discord alert for every liquidation and every failure.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   npm run liquidation:keeper                    # one-shot run (cron-friendly)
//   npm run liquidation:keeper -- --dry-run        # evaluate only, never submit
//   npm run liquidation:keeper -- --source=chain   # bypass the database entirely
//   npm run liquidation:keeper -- --interval=60    # background service, poll every 60s
//   npm run liquidation:keeper:service             # shorthand: poll every minute
//   POST /api/cron/liquidation — deployed worker (GitHub Actions every 5 min +
//   a daily Vercel Cron safety net), see docs/liquidation-keeper.md
//
// ── Required env ─────────────────────────────────────────────────────────────
//   ADMIN_SECRET_KEY, NEXT_PUBLIC_LENDING_CONTRACT_ID,
//   NEXT_PUBLIC_REPUTATION_CONTRACT_ID, NEXT_PUBLIC_ADMIN_ADDRESS
//   (+ DATABASE_URL for --source=db)
// See `.env.example` for the full LIQUIDATION_* configuration surface.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db/client";
import { ledgerTransactions, loans } from "@/lib/db/schema";
import type { Keypair } from "@stellar/stellar-sdk";
import {
  addr,
  getAdminKeypair,
  invokeReadOnly,
  invokeSigned,
  u32,
} from "../lib/stellar/server-contract";

// ─── .env loader (mirrors scripts/oracle-post-credit-score.mjs) ──────────────

function loadEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.resolve(process.cwd(), ".env.local"));
loadEnv(path.resolve(process.cwd(), ".env.contracts"));

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    args[key] = rest.length ? rest.join("=") : true;
  }
  return args;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AssetPriceEntry {
  symbol: string;
  priceUsd: number;
  /** Decimals of the asset's smallest unit (7 for XLM / most Stellar assets). */
  decimals: number;
}

export interface KeeperConfig {
  source: "db" | "chain";
  dryRun: boolean;
  /** Seconds between runs when looping as a background service; null = run once. */
  intervalSecs: number | null;
  lendingContractId: string;
  reputationContractId: string;
  adminAddress: string;
  xlmPriceUsd: number;
  /** Keyed by the collateral asset's G... contract/account address. */
  priceTable: Record<string, AssetPriceEntry>;
  /** Fallback volatility used when an asset has no explicit entry. */
  defaultAssetVolatilityBps: number;
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  databaseUrl?: string;
}

function loadPriceTable(): Record<string, AssetPriceEntry> {
  const raw = process.env.LIQUIDATION_PRICE_TABLE_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, AssetPriceEntry>;
    return parsed;
  } catch (err) {
    console.warn(
      "[liquidation-keeper] Could not parse LIQUIDATION_PRICE_TABLE_JSON — ignoring.",
      err
    );
    return {};
  }
}

export function loadConfig(argv: string[] = process.argv.slice(2)): KeeperConfig {
  const args = parseArgs(argv);

  const lendingContractId = process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID ?? "";
  const reputationContractId = process.env.NEXT_PUBLIC_REPUTATION_CONTRACT_ID ?? "";
  const adminAddress = process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "";

  const source = (args.source as string) ?? process.env.LIQUIDATION_SOURCE ?? "db";
  if (source !== "db" && source !== "chain") {
    throw new Error(`Invalid --source "${source}" — must be "db" or "chain".`);
  }

  const intervalRaw =
    (args.interval as string) ?? process.env.LIQUIDATION_POLL_INTERVAL_SECS;
  const intervalSecs = intervalRaw ? Number(intervalRaw) : null;

  return {
    source,
    dryRun: Boolean(args["dry-run"]) || process.env.LIQUIDATION_DRY_RUN === "true",
    intervalSecs: intervalSecs && intervalSecs > 0 ? intervalSecs : null,
    lendingContractId,
    reputationContractId,
    adminAddress,
    xlmPriceUsd: Number(process.env.LIQUIDATION_XLM_PRICE_USD ?? 0.12),
    priceTable: loadPriceTable(),
    defaultAssetVolatilityBps: Number(
      process.env.LIQUIDATION_DEFAULT_ASSET_VOLATILITY_BPS ?? 2000
    ),
    slackWebhookUrl: process.env.LIQUIDATION_SLACK_WEBHOOK_URL || undefined,
    discordWebhookUrl: process.env.LIQUIDATION_DISCORD_WEBHOOK_URL || undefined,
    databaseUrl: process.env.DATABASE_URL,
  };
}

// ─── Alerts (Slack / Discord) ─────────────────────────────────────────────────

export type AlertLevel = "info" | "warn" | "error";

export async function sendAlert(
  cfg: Pick<KeeperConfig, "slackWebhookUrl" | "discordWebhookUrl">,
  level: AlertLevel,
  message: string
): Promise<void> {
  const badge = { info: "✅", warn: "⚠️", error: "❌" }[level];
  const tasks: Promise<unknown>[] = [];

  if (cfg.slackWebhookUrl) {
    tasks.push(
      postJson(cfg.slackWebhookUrl, { text: `${badge} *TrustLend Liquidation Keeper*\n${message}` })
    );
  }
  if (cfg.discordWebhookUrl) {
    tasks.push(
      postJson(cfg.discordWebhookUrl, {
        content: `${badge} **TrustLend Liquidation Keeper**\n${message}`,
      })
    );
  }
  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[liquidation-keeper] Alert delivery failed:", r.reason);
    }
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Webhook ${url} responded ${res.status}`);
  }
}

// ─── Pricing / LTV (pure — unit-testable) ─────────────────────────────────────

export function resolveAssetPrice(
  cfg: Pick<KeeperConfig, "priceTable" | "xlmPriceUsd">,
  assetAddress: string
): AssetPriceEntry | null {
  if (assetAddress === "XLM" || assetAddress === "native") {
    return { symbol: "XLM", priceUsd: cfg.xlmPriceUsd, decimals: 7 };
  }
  return cfg.priceTable[assetAddress] ?? null;
}

/**
 * Current loan-to-value ratio in basis-points: (outstanding debt in USD /
 * collateral value in USD) × 10_000. Debt is always denominated in XLM
 * (stroops); collateral can be any whitelisted priced asset.
 *
 * Returns `Number.MAX_SAFE_INTEGER` when collateral value is zero or negative
 * — i.e. maximally under-collateralized, always a liquidation candidate.
 */
export function computeLtvBps(params: {
  remainingDueStroops: bigint;
  xlmPriceUsd: number;
  collateralAmount: bigint;
  collateralDecimals: number;
  collateralPriceUsd: number;
}): number {
  const debtUsd = (Number(params.remainingDueStroops) / 1e7) * params.xlmPriceUsd;
  const collateralUsd =
    (Number(params.collateralAmount) / 10 ** params.collateralDecimals) *
    params.collateralPriceUsd;

  if (collateralUsd <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.round((debtUsd / collateralUsd) * 10_000);
}

/** A loan must be liquidated once its LTV reaches or exceeds the threshold. */
export function shouldLiquidate(ltvBps: number, thresholdBps: number): boolean {
  return ltvBps >= thresholdBps;
}

// ─── On-chain reads ───────────────────────────────────────────────────────────

interface OnchainLoan {
  id: number;
  borrower: string;
  status: string;
  remainingDue: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
}

function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") return Object.keys(val as object)[0];
  return String(val);
}

async function getOnchainLoan(
  cfg: KeeperConfig,
  loanId: number
): Promise<OnchainLoan> {
  const raw = (await invokeReadOnly({
    contractId: cfg.lendingContractId,
    method: "get_loan",
    args: [u32(loanId)],
    sourceAddress: cfg.adminAddress,
  })) as Record<string, unknown>;

  return {
    id: Number(raw.id),
    borrower: raw.borrower as string,
    status: extractEnumVariant(raw.status),
    remainingDue: BigInt(raw.remaining_due as string | number),
    collateralAsset: raw.collateral_asset as string,
    collateralAmount: BigInt(raw.collateral_amount as string | number),
  };
}

async function getLoanCount(cfg: KeeperConfig): Promise<number> {
  const result = await invokeReadOnly({
    contractId: cfg.lendingContractId,
    method: "get_loan_count",
    args: [],
    sourceAddress: cfg.adminAddress,
  });
  return Number(result);
}

async function getReputationScore(cfg: KeeperConfig, borrower: string): Promise<number> {
  const result = await invokeReadOnly({
    contractId: cfg.reputationContractId,
    method: "get_reputation_score",
    args: [addr(borrower)],
    sourceAddress: cfg.adminAddress,
  });
  return Number(result);
}

async function getLiquidationThresholdBps(
  cfg: KeeperConfig,
  reputationScore: number,
  assetVolatilityBps: number
): Promise<number> {
  const result = await invokeReadOnly({
    contractId: cfg.lendingContractId,
    method: "calculate_liquidation_threshold",
    args: [u32(reputationScore), u32(assetVolatilityBps)],
    sourceAddress: cfg.adminAddress,
  });
  return Number(result);
}

/**
 * Check if a loan is eligible for liquidation (Issue #157).
 * Returns true if the grace period has expired and the loan can be liquidated.
 */
async function checkLiquidationEligibility(
  cfg: KeeperConfig,
  loanId: number
): Promise<boolean> {
  const result = await invokeReadOnly({
    contractId: cfg.lendingContractId,
    method: "check_liquidation_eligibility",
    args: [u32(loanId)],
    sourceAddress: cfg.adminAddress,
  });
  return Boolean(result);
}

// ─── Candidate discovery ──────────────────────────────────────────────────────

/** Resolve an on-chain loan id for a database loan row from its funding ledger entry. */
async function resolveOnchainLoanId(db: Db, dbLoanId: string): Promise<number | null> {
  const [data] = await db
    .select({ metadata: ledgerTransactions.metadata })
    .from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.refType, "loan_fund"), eq(ledgerTransactions.refId, dbLoanId)))
    .limit(1);

  const raw = data?.metadata;
  const meta: Record<string, unknown> | null =
    typeof raw === "string" ? safeJsonParse(raw) : (raw as Record<string, unknown> | null);
  if (!meta) return null;

  const candidate = Number(meta.onchainLoanId ?? meta.onchain_loan_id);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : null;
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchCandidatesFromDb(cfg: KeeperConfig): Promise<number[]> {
  const db = cfg.databaseUrl ? getDb() : null;
  if (!db) {
    throw new Error(
      "The database is not configured (DATABASE_URL) — use --source=chain to bypass it."
    );
  }

  const rows = await db
    .select({ id: loans.id })
    .from(loans)
    .where(inArray(loans.status, ["active", "funded"]));

  const onchainIds: number[] = [];
  for (const row of rows) {
    const onchainId = await resolveOnchainLoanId(db, row.id);
    if (onchainId) onchainIds.push(onchainId);
  }
  return onchainIds;
}

async function fetchCandidatesFromChain(cfg: KeeperConfig): Promise<number[]> {
  const count = await getLoanCount(cfg);
  const ids: number[] = [];
  for (let id = 1; id <= count; id++) ids.push(id);
  return ids;
}

// ─── Main run ─────────────────────────────────────────────────────────────────

export interface KeeperSummary {
  scanned: number;
  liquidated: number;
  healthy: number;
  skipped: number;
  failed: number;
  aborted?: boolean;
  abortReason?: string;
  remaining?: number;
}

export interface LiquidationKeeperOptions {
  signal?: AbortSignal;
  onProgress?: (progress: KeeperSummary) => Promise<void> | void;
}

export async function runLiquidationKeeper(
  cfg: KeeperConfig,
  signer: Keypair | null,
  options?: LiquidationKeeperOptions,
): Promise<KeeperSummary> {
  const summary: KeeperSummary = { scanned: 0, liquidated: 0, healthy: 0, skipped: 0, failed: 0 };

  if (!cfg.lendingContractId || !cfg.reputationContractId || !cfg.adminAddress) {
    throw new Error(
      "Missing NEXT_PUBLIC_LENDING_CONTRACT_ID / NEXT_PUBLIC_REPUTATION_CONTRACT_ID / NEXT_PUBLIC_ADMIN_ADDRESS"
    );
  }

  // Refresh XLM from the live oracle before valuing anything (Issue #267).
  // Liquidating against a hardcoded price can seize collateral the market
  // says is healthy, so a live reading takes precedence over the env constant.
  // If the oracle has nothing usable we keep the configured value rather than
  // aborting the run — the existing behaviour, explicitly logged.
  // Disabled under test (and wherever LIQUIDATION_USE_LIVE_PRICES=false) so a
  // unit test never reaches out to a real price API.
  const useLivePrices =
    process.env.LIQUIDATION_USE_LIVE_PRICES !== "false" &&
    process.env.NODE_ENV !== "test" &&
    process.env.VITEST === undefined;

  let liveXlmPriceUsd: number | null = null;
  if (useLivePrices) {
    try {
      const { getLivePriceUsd } = await import("../lib/oracle/live-prices");
      const livePrice = await getLivePriceUsd("XLM");
      if (livePrice !== null && livePrice > 0) {
        liveXlmPriceUsd = livePrice;
        console.log(`[liquidation-keeper] Using live XLM price $${livePrice}`);
      } else {
        console.warn(
          `[liquidation-keeper] Oracle returned no usable XLM price — ` +
            `falling back to the configured $${cfg.xlmPriceUsd}.`
        );
      }
    } catch (err) {
      console.warn(
        "[liquidation-keeper] Live price lookup failed; using configured price.",
        err instanceof Error ? err.message : err
      );
    }
  }

  // Every valuation below uses this, so the live price applies uniformly.
  const pricedCfg: KeeperConfig =
    liveXlmPriceUsd !== null ? { ...cfg, xlmPriceUsd: liveXlmPriceUsd } : cfg;

  const candidateIds =
    cfg.source === "db" ? await fetchCandidatesFromDb(cfg) : await fetchCandidatesFromChain(cfg);
  summary.scanned = candidateIds.length;

  for (let i = 0; i < candidateIds.length; i++) {
    if (options?.signal?.aborted) {
      summary.aborted = true;
      summary.abortReason = "Execution deadline reached; safely aborted liquidation evaluation batch";
      summary.remaining = candidateIds.length - i;
      console.warn(
        `[liquidation-keeper] Aborted before candidate loan #${candidateIds[i]}. Remaining candidates: ${summary.remaining}`,
      );
      break;
    }

    const loanId = candidateIds[i];
    try {
      const loan = await getOnchainLoan(cfg, loanId);
      if (loan.status !== "Active") {
        summary.skipped++;
        continue;
      }

      const collateralPrice = resolveAssetPrice(pricedCfg, loan.collateralAsset);
      if (!collateralPrice) {
        summary.skipped++;
        console.warn(
          `[liquidation-keeper] Loan #${loanId}: no price configured for collateral asset ${loan.collateralAsset} — skipping.`
        );
        continue;
      }

      const reputationScore = await getReputationScore(cfg, loan.borrower);
      const thresholdBps = await getLiquidationThresholdBps(
        cfg,
        reputationScore,
        cfg.defaultAssetVolatilityBps
      );
      const ltvBps = computeLtvBps({
        remainingDueStroops: loan.remainingDue,
        xlmPriceUsd: pricedCfg.xlmPriceUsd,
        collateralAmount: loan.collateralAmount,
        collateralDecimals: collateralPrice.decimals,
        collateralPriceUsd: collateralPrice.priceUsd,
      });

      if (!shouldLiquidate(ltvBps, thresholdBps)) {
        summary.healthy++;
        continue;
      }

      // Check grace period eligibility (Issue #157)
      // If health factor is below 1.0, borrower gets 12 hours to top up collateral
      const isEligible = await checkLiquidationEligibility(cfg, loanId);
      if (!isEligible) {
        summary.skipped++;
        console.log(
          `[liquidation-keeper] Loan #${loanId}: undercollateralized but grace period active — skipping.`
        );
        continue;
      }

      const detail = `Loan #${loanId} (borrower ${loan.borrower.slice(0, 6)}…) — LTV ${(ltvBps / 100).toFixed(2)}% >= threshold ${(thresholdBps / 100).toFixed(2)}%`;

      if (cfg.dryRun) {
        console.log(`[liquidation-keeper] [DRY RUN] Would liquidate: ${detail}`);
        summary.liquidated++;
        continue;
      }
      if (!signer) {
        throw new Error("ADMIN_SECRET_KEY is not configured — cannot submit liquidation tx");
      }

      const result = await invokeSigned({
        contractId: cfg.lendingContractId,
        method: "mark_defaulted",
        args: [addr(cfg.adminAddress), u32(loanId)],
        signer,
      });

      summary.liquidated++;
      console.log(`[liquidation-keeper] Liquidated: ${detail} (tx=${result.hash})`);
      await sendAlert(cfg, "info", `${detail}\ntx: ${result.hash}`);
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[liquidation-keeper] Loan #${loanId} failed:`, msg);
      await sendAlert(cfg, "error", `Liquidation check failed for loan #${loanId}: ${msg}`);
    } finally {
      if (options?.onProgress) {
        await options.onProgress(summary);
      }
    }
  }

  return summary;
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const signer = getAdminKeypair();

  console.log(
    `[liquidation-keeper] Starting — source=${cfg.source} dryRun=${cfg.dryRun} ` +
      `interval=${cfg.intervalSecs ? `${cfg.intervalSecs}s` : "one-shot"}`
  );

  for (;;) {
    const start = Date.now();
    try {
      const summary = await runLiquidationKeeper(cfg, signer);
      console.log(
        `[liquidation-keeper] Run complete in ${Date.now() - start}ms:`,
        JSON.stringify(summary)
      );
      if (summary.failed > 0) {
        await sendAlert(
          cfg,
          "warn",
          `Run finished with ${summary.failed} failed check(s) out of ${summary.scanned} scanned.`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[liquidation-keeper] Run failed:", msg);
      await sendAlert(cfg, "error", `Keeper run failed entirely: ${msg}`);
      if (!cfg.intervalSecs) process.exitCode = 1;
    }

    if (!cfg.intervalSecs) break;
    await sleep(cfg.intervalSecs * 1000);
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error("[liquidation-keeper] Fatal error:", err);
    process.exit(1);
  });
}
