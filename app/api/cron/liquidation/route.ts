import { NextRequest, NextResponse } from "next/server";
import { withCronTimeoutGuard } from "@/lib/cron/with-timeout-guard";
import { getAdminKeypair } from "@/lib/stellar/server-contract";
import { loadConfig, runLiquidationKeeper } from "@/scripts/liquidation-keeper";

/**
 * POST/GET /api/cron/liquidation
 *
 * Automated Liquidation Bot (issue #259). Triggered by scheduler.
 * Evaluates loans for liquidation with execution deadline dead-man switches
 * and database execution logging.
 */
export const POST = withCronTimeoutGuard(
  "liquidation",
  async (ctx) => {
    const cfg = loadConfig([]);
    const signer = getAdminKeypair();
    return await runLiquidationKeeper(cfg, signer, {
      signal: ctx.signal,
      onProgress: ctx.reportProgress,
    });
  },
  { timeoutMs: 270_000, safetyBufferMs: 10_000 },
);

// Allow Vercel's cron invocations (GET-based) as well.
export const GET = POST;

// Liquidation checks span many loans; allow long-running invocations.
export const maxDuration = 300;
