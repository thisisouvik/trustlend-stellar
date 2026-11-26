/**
 * lib/cron/types.ts
 *
 * Core types for scheduled cron execution, timeout guards, dead-man switches,
 * batch progress tracking, and execution logging.
 */

export type CronJobName =
  | "payment-due"
  | "default-management"
  | "liquidation"
  | "price-oracle"
  | "reputation-scoring"
  | (string & {});

export type CronExecutionStatus = "running" | "completed" | "aborted" | "failed";

export type CronAlertLevel = "info" | "warn" | "error" | "critical";

export interface CronTimeoutConfig {
  /** Total maximum allowed execution duration in milliseconds. */
  timeoutMs: number;
  /** Buffer time in milliseconds before serverless limit to safely flush partial state. */
  safetyBufferMs: number;
}

export interface CronBatchProgress {
  scanned?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  aborted?: boolean;
  abortReason?: string;
  remaining?: number;
  [key: string]: unknown;
}

export interface CronExecutionContext {
  jobName: string;
  logId: string | null;
  signal: AbortSignal;
  /** Returns true if remaining execution time is less than itemEstimateMs or switch is aborted. */
  isTimeExceeded: (itemEstimateMs?: number) => boolean;
  /** Returns remaining milliseconds before the safe execution deadline. */
  getRemainingTimeMs: () => number;
  /** Checks if remaining time is insufficient; if so, triggers abort and returns true. */
  checkOrAbort: (itemEstimateMs?: number, label?: string) => boolean;
  /** Flushes incremental batch progress to DB and logs. */
  reportProgress: (progress: Partial<CronBatchProgress> | object) => Promise<void>;
}

export interface CronGuardOptions {
  timeoutMs?: number;
  safetyBufferMs?: number;
  recordMetrics?: boolean;
}
