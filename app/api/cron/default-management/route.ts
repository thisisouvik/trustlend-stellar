import { NextRequest, NextResponse } from "next/server";
import { CronTimeoutError, requireCronAuth, withCronTimeout } from "@/lib/auth/cron";
import { runDefaultManagement } from "@/lib/scheduler/default-management";

/**
 * POST/GET /api/cron/default-management
 *
 * Automated Default-Management run (issue #23). Triggered by an external
 * scheduler (Vercel Cron, GitHub Actions, cURL). Iterates over overdue loans
 * and, past the grace period, triggers the on-chain `mark_defaulted` /
 * `record_default` / `trigger_insurance_payout` contract methods.
 *
 * Secured via CRON_SECRET in the Authorization header (`Bearer <secret>`).
 */
export async function POST(request: NextRequest) {
  // Verify the caller is the trusted scheduler (fails closed, see lib/auth/cron.ts).
  const denied = requireCronAuth(request, "default-management");
  if (denied) return denied;

  try {
    const { result, durationMs: duration, timedOut } = await withCronTimeout(
      "default-management",
      () => runDefaultManagement(),
    );
    console.log(
      `[default-management] Run complete in ${duration}ms (timedOut=${timedOut}): ` +
        `scanned=${result.scanned} defaulted=${result.defaulted} ` +
        `payoutsProposed=${result.payoutsProposed} failed=${result.failed}`,
    );
    return NextResponse.json({ ok: true, timedOut, ...result, duration });
  } catch (err) {
    if (err instanceof CronTimeoutError) {
      console.error("[default-management] Scheduler run timed out:", err.message);
      return NextResponse.json(
        { ok: false, timedOut: true, error: err.message },
        { status: 504 },
      );
    }
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[default-management] Scheduler run failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow Vercel's cron invocations (GET-based) as well.
export const GET = POST;

// Default-management contract calls can take a while across many loans.
export const maxDuration = 300;
