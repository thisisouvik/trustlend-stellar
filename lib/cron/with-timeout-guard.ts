/**
 * lib/cron/with-timeout-guard.ts
 *
 * Higher-order wrapper for scheduled cron API endpoints (`app/api/cron/*`).
 * Coordinates authentication, execution dead-man switch, database progress logging,
 * partial batch commitments, failure alerts, and Prometheus metrics.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCronTimeoutConfig, requireCronAuth } from "@/lib/auth/cron";
import { recordCronMetrics } from "@/lib/monitoring/metrics";
import {
  abortCronExecution,
  completeCronExecution,
  failCronExecution,
  recordCronAlert,
  startCronExecution,
  updateCronProgress,
} from "./cron-logger";
import { CronTimeoutError, DeadManSwitch } from "./dead-man-switch";
import type { CronExecutionContext, CronGuardOptions } from "./types";

export function withCronTimeoutGuard<TResult extends Record<string, unknown>>(
  jobName: string,
  handler: (ctx: CronExecutionContext, request: NextRequest) => Promise<TResult>,
  options?: CronGuardOptions,
) {
  return async function wrappedRoute(request: NextRequest): Promise<NextResponse> {
    // 1. Authenticate caller (CRON_SECRET check, fails closed)
    const denied = requireCronAuth(request, jobName);
    if (denied) return denied;

    const start = Date.now();
    const config = getCronTimeoutConfig(jobName, request);
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs;
    const safetyBufferMs = options?.safetyBufferMs ?? config.safetyBufferMs;

    const deadMan = new DeadManSwitch({
      jobName,
      timeoutMs,
      safetyBufferMs,
    }).start();

    // 2. Record initial execution start in DB
    let logId: string | null = null;
    try {
      logId = await startCronExecution(jobName, {
        method: request.method,
        timeoutMs,
        safetyBufferMs,
        effectiveDeadlineMs: deadMan.effectiveDeadlineMs,
      });
    } catch (err) {
      console.warn(`[${jobName}] Could not create start execution log:`, err);
    }

    const ctx: CronExecutionContext = {
      jobName,
      logId,
      signal: deadMan.signal,
      isTimeExceeded: (itemEstimateMs) => deadMan.isTimeExceeded(itemEstimateMs),
      getRemainingTimeMs: () => deadMan.getRemainingTimeMs(),
      checkOrAbort: (itemEstimateMs, label) => deadMan.checkOrAbort(itemEstimateMs, label),
      reportProgress: async (progress) => {
        if (logId) {
          await updateCronProgress(logId, progress).catch(() => {});
        }
      },
    };

    try {
      const result = await handler(ctx, request);
      deadMan.stop();
      const duration = Date.now() - start;

      const isAborted = Boolean((result as Record<string, unknown>).aborted) || deadMan.isAborted();
      const abortReason =
        ((result as Record<string, unknown>).abortReason as string | undefined) ??
        deadMan.getAbortReason();

      if (isAborted) {
        console.warn(
          `[${jobName}] Run gracefully aborted in ${duration}ms due to deadline:`,
          abortReason,
        );
        if (logId) {
          await abortCronExecution(logId, abortReason ?? "Execution deadline exceeded", {
            processed: extractCount(result, ["processed", "scanned"]),
            succeeded: extractCount(result, ["succeeded", "liquidated", "published", "updated"]),
            failed: extractCount(result, ["failed", "errors"]),
            metadata: result,
          }).catch(() => {});

          await recordCronAlert(
            jobName,
            "warn",
            `Cron ${jobName} aborted before timeout limit: ${abortReason ?? "deadline reached"}`,
            { duration, abortReason, result },
            logId,
          ).catch(() => {});
        }

        recordCronMetrics(jobName, "aborted", duration / 1000, abortReason ?? "deadline");

        return NextResponse.json(
          {
            ok: true,
            aborted: true,
            partial: true,
            abortReason: abortReason ?? "Execution deadline reached; partial batch saved.",
            ...result,
            duration,
          },
          { status: 200 },
        );
      }

      console.log(`[${jobName}] Run completed successfully in ${duration}ms:`, result);
      if (logId) {
        await completeCronExecution(logId, {
          processed: extractCount(result, ["processed", "scanned"]),
          succeeded: extractCount(result, ["succeeded", "liquidated", "published", "updated"]),
          failed: extractCount(result, ["failed", "errors"]),
          metadata: result,
        }).catch(() => {});
      }

      recordCronMetrics(jobName, "completed", duration / 1000);
      return NextResponse.json({ ok: true, ...result, duration });
    } catch (err) {
      deadMan.stop();
      const duration = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      const isAbortError = err instanceof CronTimeoutError || deadMan.isAborted();

      if (isAbortError) {
        console.warn(`[${jobName}] Deadline timeout guard caught abort:`, msg);
        if (logId) {
          await abortCronExecution(logId, msg, { metadata: { duration, error: msg } }).catch(() => {});
          await recordCronAlert(
            jobName,
            "warn",
            `Cron ${jobName} execution aborted: ${msg}`,
            { duration, error: msg },
            logId,
          ).catch(() => {});
        }

        recordCronMetrics(jobName, "aborted", duration / 1000, msg);
        return NextResponse.json(
          {
            ok: true,
            aborted: true,
            partial: true,
            abortReason: msg,
            duration,
          },
          { status: 200 },
        );
      }

      console.error(`[${jobName}] Scheduler run failed:`, msg);
      if (logId) {
        await failCronExecution(logId, msg, { metadata: { duration, error: msg } }).catch(() => {});
        await recordCronAlert(
          jobName,
          "error",
          `Cron ${jobName} failed: ${msg}`,
          { duration, error: msg },
          logId,
        ).catch(() => {});
      }

      recordCronMetrics(jobName, "failed", duration / 1000);
      return NextResponse.json({ ok: false, error: msg, duration }, { status: 500 });
    }
  };
}

function extractCount(record: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const val = record[k];
    if (typeof val === "number" && !isNaN(val)) return val;
  }
  return 0;
}
