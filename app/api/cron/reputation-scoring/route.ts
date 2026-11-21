import { NextRequest, NextResponse } from "next/server";
import { CronTimeoutError, requireCronAuth, withCronTimeout } from "@/lib/auth/cron";
import { runDailyReputationRecalculation } from "@/lib/reputation/daily-sync";

export async function POST(request: NextRequest) {
  // Verify the caller is the trusted scheduler (fails closed, see lib/auth/cron.ts).
  const denied = requireCronAuth(request, "reputation-scoring");
  if (denied) return denied;

  try {
    const { result: summary, durationMs: duration, timedOut } = await withCronTimeout(
      "reputation-scoring",
      () => runDailyReputationRecalculation(),
    );

    return NextResponse.json(
      {
        ok: true,
        timedOut,
        duration,
        message: "Daily borrower reputation recalculation completed",
        timestamp: new Date().toISOString(),
        ...summary,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof CronTimeoutError) {
      console.error("[Cron /api/cron/reputation-scoring] Execution timed out:", error.message);
      return NextResponse.json(
        {
          ok: false,
          timedOut: true,
          error: error.message,
        },
        { status: 504 },
      );
    }
    console.error("[Cron /api/cron/reputation-scoring] Execution error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal cron error",
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}

export const maxDuration = 300;
