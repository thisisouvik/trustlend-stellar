import { NextRequest, NextResponse } from "next/server";
import { runPaymentDueScheduler } from "@/lib/scheduler/payment-due";

/**
 * POST /api/cron/payment-due
 *
 * Triggered by an external scheduler (e.g., Vercel Cron, GitHub Actions, cURL).
 * Secured via CRON_SECRET in the Authorization header.
 */
export async function POST(request: NextRequest) {
  // Verify the caller is the trusted scheduler
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const start = Date.now();
  try {
    const result = await runPaymentDueScheduler();
    const duration = Date.now() - start;
    console.log(`[payment-due] Run complete in ${duration}ms:`, result);
    return NextResponse.json({ ok: true, ...result, duration });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[payment-due] Scheduler run failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow Vercel's cron invocations (GET-based) as well
export const GET = POST;
