import { NextRequest, NextResponse } from "next/server";
import { CronTimeoutError, requireCronAuth, withCronTimeout } from "@/lib/auth/cron";
import { runPaymentDueScheduler } from "@/lib/scheduler/payment-due";

/**
 * POST /api/cron/payment-due
 *
 * Triggered by an external scheduler (e.g., Vercel Cron, GitHub Actions, cURL).
 * Secured via CRON_SECRET in the Authorization header.
 */
export async function POST(request: NextRequest) {
  // Verify the caller is the trusted scheduler (fails closed, see lib/auth/cron.ts).
  const denied = requireCronAuth(request, "payment-due");
  if (denied) return denied;

  try {
    const { result, durationMs: duration, timedOut } = await withCronTimeout(
      "payment-due",
      () => runPaymentDueScheduler(),
    );
    console.log(`[payment-due] Run complete in ${duration}ms (timedOut=${timedOut}):`, result);
    return NextResponse.json({ ok: true, timedOut, ...result, duration });
  } catch (err) {
    if (err instanceof CronTimeoutError) {
      console.error("[payment-due] Scheduler run timed out:", err.message);
      return NextResponse.json(
        { ok: false, timedOut: true, error: err.message },
        { status: 504 },
      );
    }
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[payment-due] Scheduler run failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow Vercel's cron invocations (GET-based) as well
export const GET = POST;

// Payment-due webhook and email notifications can span multiple loans.
export const maxDuration = 300;
