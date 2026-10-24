import { NextRequest, NextResponse } from "next/server";
import { CronTimeoutError, requireCronAuth, withCronTimeout } from "@/lib/auth/cron";
import {
  loadOracleConfig,
  runOracleCycle,
  createInitialState,
  createDryRunPublisher,
} from "@/scripts/price-oracle-keeper";
import { createDefaultSources } from "@/lib/oracle/sources";

/**
 * POST/GET /api/cron/price-oracle
 *
 * Runs a single price-oracle cycle (Issue #267). This is the coarse-grained
 * entry point for schedulers like Vercel Cron.
 *
 * **This route cannot satisfy the 5-second requirement on its own** — Vercel
 * Cron's finest granularity is one minute. The 5-second cadence comes from the
 * long-lived keeper (`npm run price:oracle`), and this route exists as a
 * safety net so prices still refresh if that process is not running.
 *
 * Secured with CRON_SECRET, matching the liquidation and payment-due crons.
 *
 * Note: each invocation starts with empty state, so the in-memory cache
 * fallback is unavailable here — a cycle that finds no live source falls
 * straight through to the on-chain TWAP.
 */
export async function POST(request: NextRequest) {
  // Verify the caller is the trusted scheduler (fails closed, see lib/auth/cron.ts).
  const denied = requireCronAuth(request, "price-oracle");
  if (denied) return denied;

  try {
    const cfg = loadOracleConfig(["--once"]);
    const sources = createDefaultSources();

    if (sources.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No price sources enabled" },
        { status: 503 },
      );
    }

    // On-chain publishing needs a signer; until ORACLE_SECRET_KEY is wired to
    // a real invoke this reports what it *would* publish rather than pretending
    // to have written it.
    const publisher = createDryRunPublisher();
    const { result: summary, durationMs: duration, timedOut } = await withCronTimeout(
      "price-oracle",
      () =>
        runOracleCycle(
          cfg,
          sources,
          publisher,
          createInitialState(),
        ),
      { timeoutMs: 50_000 },
    );

    console.log(
      `[price-oracle] Cron cycle in ${duration}ms (timedOut=${timedOut}): ` +
        `polled=${summary.polled} published=${summary.published} ` +
        `skipped=${summary.skipped} unavailable=${summary.unavailable} failed=${summary.failed}`,
    );

    const results = Array.isArray(summary.results) ? summary.results : [];

    return NextResponse.json({
      ok: true,
      timedOut,
      duration,
      polled: summary.polled,
      published: summary.published,
      skipped: summary.skipped,
      unavailable: summary.unavailable,
      failed: summary.failed,
      prices: results.map((r) => ({
        symbol: r.symbol,
        priceUsd: r.priceUsd,
        origin: r.origin,
        sources: r.contributingSources,
        ageMs: r.ageMs,
      })),
    });
  } catch (err) {
    if (err instanceof CronTimeoutError) {
      console.error("[price-oracle] Cron cycle timed out:", err.message);
      return NextResponse.json(
        { ok: false, timedOut: true, error: err.message },
        { status: 504 },
      );
    }
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[price-oracle] Cron cycle failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Vercel cron invokes via GET.
export const GET = POST;

// Polling several upstream APIs can take a few seconds.
export const maxDuration = 60;
