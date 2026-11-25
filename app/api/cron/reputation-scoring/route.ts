import { NextRequest, NextResponse } from "next/server";
import { withCronTimeoutGuard } from "@/lib/cron/with-timeout-guard";
import { runDailyReputationRecalculation } from "@/lib/reputation/daily-sync";

/**
 * POST/GET /api/cron/reputation-scoring
 *
 * Runs daily borrower reputation recalculation.
 * Protected by execution deadline dead-man switch and database execution logging.
 */
export const POST = withCronTimeoutGuard(
  "reputation-scoring",
  async (ctx) => {
    const summary = await runDailyReputationRecalculation({
      signal: ctx.signal,
      onProgress: ctx.reportProgress,
    });

    return {
      message: "Daily borrower reputation recalculation completed",
      timestamp: new Date().toISOString(),
      ...summary,
    };
  },
  { timeoutMs: 55_000, safetyBufferMs: 5_000 },
);

export const GET = POST;
export const maxDuration = 60;
