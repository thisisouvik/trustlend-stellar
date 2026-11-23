/**
 * app/api/cron/logs/route.ts
 *
 * Query endpoint for scheduled cron execution logs and failure alerts.
 * Enables dead-man switch monitoring, audit trails, and troubleshooting of aborted runs.
 * Secured via CRON_SECRET authorization.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/auth/cron";
import { getDb } from "@/lib/db/client";
import { getCronAlerts, getRecentCronExecutionLogs } from "@/lib/db/queries";

export async function GET(request: NextRequest) {
  const denied = requireCronAuth(request, "cron-logs");
  if (denied) return denied;

  try {
    const db = getDb();
    const searchParams = request.nextUrl.searchParams;
    const jobName = searchParams.get("jobName") ?? undefined;
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));
    const includeAlerts = searchParams.get("includeAlerts") === "true";
    const unresolvedOnly = searchParams.get("unresolvedOnly") === "true";

    const logs = await getRecentCronExecutionLogs(db, jobName, limit);
    const alerts = includeAlerts
      ? await getCronAlerts(db, jobName, unresolvedOnly, limit)
      : undefined;

    return NextResponse.json({
      ok: true,
      count: logs.length,
      logs,
      ...(alerts ? { alerts } : {}),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron-logs] Failed to retrieve cron logs:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
