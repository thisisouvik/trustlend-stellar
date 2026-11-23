import { NextRequest, NextResponse } from "next/server";
import { withCronTimeoutGuard } from "@/lib/cron/with-timeout-guard";
import { runDefaultManagement } from "@/lib/scheduler/default-management";

/**
 * POST/GET /api/cron/default-management
 *
 * Automated Default-Management run (issue #23). Triggered by an external
 * scheduler (Vercel Cron, GitHub Actions, cURL). Iterates over overdue loans
 * and, past the grace period, triggers the on-chain `mark_defaulted` /
 * `record_default` / `trigger_insurance_payout` contract methods.
 *
 * Protected with execution deadline dead-man switch and database execution logging.
 */
export const POST = withCronTimeoutGuard(
  "default-management",
  async (ctx) => {
    return await runDefaultManagement({
      signal: ctx.signal,
      onProgress: ctx.reportProgress,
    });
  },
  { timeoutMs: 270_000, safetyBufferMs: 10_000 },
);

// Allow Vercel's cron invocations (GET-based) as well.
export const GET = POST;

// Default-management contract calls can take a while across many loans.
export const maxDuration = 300;
