import { NextRequest, NextResponse } from "next/server";
import { withCronTimeoutGuard } from "@/lib/cron/with-timeout-guard";
import { runPaymentDueScheduler } from "@/lib/scheduler/payment-due";

/**
 * POST/GET /api/cron/payment-due
 *
 * Triggered by an external scheduler (e.g., Vercel Cron, GitHub Actions, cURL).
 * Secured via CRON_SECRET and protected by execution deadline dead-man switch.
 */
export const POST = withCronTimeoutGuard(
  "payment-due",
  async (ctx) => {
    return await runPaymentDueScheduler({
      signal: ctx.signal,
      onProgress: ctx.reportProgress,
    });
  },
  { timeoutMs: 25_000, safetyBufferMs: 3_000 },
);

// Allow Vercel's cron invocations (GET-based) as well
export const GET = POST;
export const maxDuration = 30;
