import { NextRequest, NextResponse } from "next/server";
import { withCronTimeoutGuard } from "@/lib/cron/with-timeout-guard";
import { createDefaultSources } from "@/lib/oracle/sources";
import {
  createDryRunPublisher,
  createInitialState,
  loadOracleConfig,
  runOracleCycle,
} from "@/scripts/price-oracle-keeper";

/**
 * POST/GET /api/cron/price-oracle
 *
 * Runs a single price-oracle cycle (Issue #267).
 * Protected with execution deadline dead-man switch and database execution logging.
 */
export const POST = withCronTimeoutGuard(
  "price-oracle",
  async (ctx) => {
    const cfg = loadOracleConfig(["--once"]);
    const sources = createDefaultSources();

    if (sources.length === 0) {
      throw new Error("No price sources enabled");
    }

    // On-chain publishing needs a signer; until ORACLE_SECRET_KEY is wired to
    // a real invoke this reports what it *would* publish rather than pretending
    // to have written it.
    const publisher = createDryRunPublisher();
    const summary = await runOracleCycle(
      cfg,
      sources,
      publisher,
      createInitialState(),
      Date.now(),
      {
        signal: ctx.signal,
        onProgress: ctx.reportProgress,
      },
    );

    return {
      polled: summary.polled,
      published: summary.published,
      skipped: summary.skipped,
      unavailable: summary.unavailable,
      failed: summary.failed,
      aborted: summary.aborted,
      abortReason: summary.abortReason,
      prices: summary.results.map((r) => ({
        symbol: r.symbol,
        priceUsd: r.priceUsd,
        origin: r.origin,
        sources: r.contributingSources,
        ageMs: r.ageMs,
      })),
    };
  },
  { timeoutMs: 50_000, safetyBufferMs: 5_000 },
);

// Vercel cron invokes via GET.
export const GET = POST;

// Polling several upstream APIs can take a few seconds.
export const maxDuration = 60;
