/**
 * lib/cron/cron-logger.ts
 *
 * Database logging and alert records for scheduled cron handlers.
 * Tracks job starts, progress heartbeats, completions, aborts, and failure alerts.
 * Fails safely: database outages never crash the cron runner.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { cronAlerts, cronExecutionLogs } from "@/lib/db/schema";
import type { CronAlertLevel, CronBatchProgress } from "./types";

export interface LogSummaryInput {
  processed?: number;
  succeeded?: number;
  failed?: number;
  metadata?: Record<string, unknown>;
}

export async function startCronExecution(
  jobName: string,
  metadata?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const db = getDb();
    if (!db) return null;

    const [inserted] = await db
      .insert(cronExecutionLogs)
      .values({
        jobName,
        status: "running",
        startedAt: new Date(),
        processedCount: 0,
        successCount: 0,
        failureCount: 0,
        aborted: false,
        metadata: metadata ?? {},
      })
      .returning({ id: cronExecutionLogs.id });

    return inserted?.id ?? null;
  } catch (err) {
    console.warn(`[cron-logger:${jobName}] Failed to insert start log:`, err);
    return null;
  }
}

export async function updateCronProgress(
  logId: string,
  progress: Partial<CronBatchProgress>,
): Promise<void> {
  try {
    const db = getDb();
    if (!db || !logId) return;

    await db
      .update(cronExecutionLogs)
      .set({
        processedCount: progress.processed ?? progress.scanned,
        successCount: progress.succeeded,
        failureCount: progress.failed,
        metadata: progress,
      })
      .where(eq(cronExecutionLogs.id, logId));
  } catch (err) {
    console.warn(`[cron-logger] Failed to update progress for log ${logId}:`, err);
  }
}

export async function completeCronExecution(
  logId: string,
  summary: LogSummaryInput,
): Promise<void> {
  try {
    const db = getDb();
    if (!db || !logId) return;

    const [existing] = await db
      .select({ startedAt: cronExecutionLogs.startedAt })
      .from(cronExecutionLogs)
      .where(eq(cronExecutionLogs.id, logId))
      .limit(1);

    const durationMs = existing?.startedAt
      ? Math.max(0, Date.now() - existing.startedAt.getTime())
      : undefined;

    await db
      .update(cronExecutionLogs)
      .set({
        status: "completed",
        completedAt: new Date(),
        durationMs,
        processedCount: summary.processed ?? 0,
        successCount: summary.succeeded ?? 0,
        failureCount: summary.failed ?? 0,
        aborted: false,
        metadata: summary.metadata ?? {},
      })
      .where(eq(cronExecutionLogs.id, logId));
  } catch (err) {
    console.warn(`[cron-logger] Failed to complete execution log ${logId}:`, err);
  }
}

export async function abortCronExecution(
  logId: string,
  reason: string,
  summary?: LogSummaryInput,
): Promise<void> {
  try {
    const db = getDb();
    if (!db || !logId) return;

    const [existing] = await db
      .select({ startedAt: cronExecutionLogs.startedAt })
      .from(cronExecutionLogs)
      .where(eq(cronExecutionLogs.id, logId))
      .limit(1);

    const durationMs = existing?.startedAt
      ? Math.max(0, Date.now() - existing.startedAt.getTime())
      : undefined;

    await db
      .update(cronExecutionLogs)
      .set({
        status: "aborted",
        completedAt: new Date(),
        durationMs,
        processedCount: summary?.processed ?? 0,
        successCount: summary?.succeeded ?? 0,
        failureCount: summary?.failed ?? 0,
        aborted: true,
        abortReason: reason,
        metadata: {
          ...(summary?.metadata ?? {}),
          abortReason: reason,
        },
      })
      .where(eq(cronExecutionLogs.id, logId));
  } catch (err) {
    console.warn(`[cron-logger] Failed to record abort for log ${logId}:`, err);
  }
}

export async function failCronExecution(
  logId: string,
  error: Error | string,
  summary?: LogSummaryInput,
): Promise<void> {
  try {
    const db = getDb();
    if (!db || !logId) return;

    const errorMsg = error instanceof Error ? error.message : String(error);
    const [existing] = await db
      .select({ startedAt: cronExecutionLogs.startedAt })
      .from(cronExecutionLogs)
      .where(eq(cronExecutionLogs.id, logId))
      .limit(1);

    const durationMs = existing?.startedAt
      ? Math.max(0, Date.now() - existing.startedAt.getTime())
      : undefined;

    await db
      .update(cronExecutionLogs)
      .set({
        status: "failed",
        completedAt: new Date(),
        durationMs,
        processedCount: summary?.processed ?? 0,
        successCount: summary?.succeeded ?? 0,
        failureCount: summary?.failed ?? 0,
        error: errorMsg,
        metadata: {
          ...(summary?.metadata ?? {}),
          error: errorMsg,
        },
      })
      .where(eq(cronExecutionLogs.id, logId));
  } catch (err) {
    console.warn(`[cron-logger] Failed to record failure for log ${logId}:`, err);
  }
}

export async function recordCronAlert(
  jobName: string,
  level: CronAlertLevel,
  message: string,
  details?: Record<string, unknown>,
  logId?: string | null,
): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;

    await db.insert(cronAlerts).values({
      jobName,
      logId: logId ?? undefined,
      level,
      message,
      details: details ?? {},
      resolved: false,
    });
  } catch (err) {
    console.warn(`[cron-logger:${jobName}] Failed to insert alert:`, err);
  }
}
