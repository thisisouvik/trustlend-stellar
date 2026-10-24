/**
 * lib/auth/cron.ts
 *
 * Shared authorization, execution timeout guard, and dead-man switch tracking
 * for the scheduled endpoints under `app/api/cron/*`.
 * Callers (Vercel Cron, `.github/workflows/keepers.yml`, cURL) must send
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * The check fails closed: when CRON_SECRET is missing, requests are rejected
 * with 500 (server misconfigured) rather than let through, so a deployment
 * that forgot the env var cannot be driven by anonymous callers. The only
 * exception is local development (`NODE_ENV === "development"`), where an
 * unset secret skips the check so the routes can be exercised by hand.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string };

/**
 * Default execution budget (240s) leaves a 60s safety margin below the 300s
 * serverless function ceiling so partial batch state can be flushed cleanly.
 */
export const DEFAULT_CRON_TIMEOUT_MS = 240_000;

export class CronTimeoutError extends Error {
  readonly jobName: string;
  readonly timeoutMs: number;

  constructor(jobName: string, timeoutMs: number) {
    super(`Cron job "${jobName}" exceeded execution timeout of ${timeoutMs}ms`);
    this.name = "CronTimeoutError";
    this.jobName = jobName;
    this.timeoutMs = timeoutMs;
  }
}

export interface CronDeadManSwitchRecord {
  jobName: string;
  lastStartedAt: string;
  lastCompletedAt: string | null;
  lastStatus: "running" | "succeeded" | "timed_out" | "failed";
  lastDurationMs: number | null;
  lastError?: string;
}

export interface CronTimeoutOptions {
  /** Total execution budget in milliseconds before aborting. */
  timeoutMs?: number;
  /**
   * Grace window (ms) between aborting the cooperative `AbortSignal` and
   * forcibly rejecting if the runner does not return partial results.
   */
  graceMs?: number;
}

const heartbeatRegistry = new Map<string, CronDeadManSwitchRecord>();
const activeSignalStack: AbortSignal[] = [];

export function getActiveCronSignal(): AbortSignal | undefined {
  return activeSignalStack[activeSignalStack.length - 1];
}

export function getCronHeartbeat(jobName: string): CronDeadManSwitchRecord | null {
  return heartbeatRegistry.get(jobName) ?? null;
}

export function getAllCronHeartbeats(): Record<string, CronDeadManSwitchRecord> {
  return Object.fromEntries(heartbeatRegistry.entries());
}

export function resetCronHeartbeats(): void {
  heartbeatRegistry.clear();
}

function resolveCronTimeoutMs(overrideMs?: number): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  const envVal = Number(process.env.CRON_EXECUTION_TIMEOUT_MS);
  if (Number.isFinite(envVal) && envVal > 0) {
    return envVal;
  }
  return DEFAULT_CRON_TIMEOUT_MS;
}

/**
 * Executes a scheduled cron job with a cooperative `AbortSignal`, hard
 * deadline enforcement, and dead-man switch heartbeat recording.
 */
export async function withCronTimeout<T>(
  jobName: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: CronTimeoutOptions = {},
): Promise<{ result: T; durationMs: number; timedOut: boolean }> {
  const timeoutMs = resolveCronTimeoutMs(options.timeoutMs);
  const graceMs = options.graceMs ?? 50;
  const controller = new AbortController();
  const startMs = Date.now();
  const startedIso = new Date(startMs).toISOString();

  heartbeatRegistry.set(jobName, {
    jobName,
    lastStartedAt: startedIso,
    lastCompletedAt: null,
    lastStatus: "running",
    lastDurationMs: null,
  });

  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;

  const hardTimeoutPromise = new Promise<never>((_, reject) => {
    softTimer = setTimeout(() => {
      const err = new CronTimeoutError(jobName, timeoutMs);
      controller.abort(err);
      hardTimer = setTimeout(() => {
        reject(err);
      }, graceMs);
    }, timeoutMs);
  });

  activeSignalStack.push(controller.signal);
  try {
    const result = await Promise.race([fn(controller.signal), hardTimeoutPromise]);
    const durationMs = Date.now() - startMs;
    const resultTimedOut =
      controller.signal.aborted ||
      Boolean(
        result &&
          typeof result === "object" &&
          "timedOut" in (result as Record<string, unknown>) &&
          (result as { timedOut?: unknown }).timedOut,
      );

    heartbeatRegistry.set(jobName, {
      jobName,
      lastStartedAt: startedIso,
      lastCompletedAt: new Date().toISOString(),
      lastStatus: resultTimedOut ? "timed_out" : "succeeded",
      lastDurationMs: durationMs,
      ...(resultTimedOut
        ? { lastError: `Cooperative timeout reached after ${durationMs}ms` }
        : {}),
    });

    return { result, durationMs, timedOut: resultTimedOut };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const isTimeout = err instanceof CronTimeoutError;
    const msg = err instanceof Error ? err.message : String(err);

    heartbeatRegistry.set(jobName, {
      jobName,
      lastStartedAt: startedIso,
      lastCompletedAt: new Date().toISOString(),
      lastStatus: isTimeout ? "timed_out" : "failed",
      lastDurationMs: durationMs,
      lastError: msg,
    });

    throw err;
  } finally {
    activeSignalStack.pop();
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}

function configuredSecret(): string | null {
  const secret = process.env.CRON_SECRET?.trim();
  return secret ? secret : null;
}

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison neither short-circuits on the first differing byte nor leaks the
 * secret's length.
 */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** Decides whether a cron request may run, without building a response. */
export function checkCronAuth(request: Request): CronAuthResult {
  const secret = configuredSecret();

  if (!secret) {
    if (process.env.NODE_ENV === "development") {
      return { ok: true };
    }
    return {
      ok: false,
      status: 500,
      error: "Server misconfigured: CRON_SECRET is not set",
    };
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !safeEqual(authHeader, `Bearer ${secret}`)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}

/**
 * Route-handler guard. Returns `null` when the request is authorized, or the
 * error response the handler should return immediately.
 *
 *   const denied = requireCronAuth(request, "liquidation");
 *   if (denied) return denied;
 */
export function requireCronAuth(
  request: Request,
  jobName: string,
): NextResponse | null {
  const result = checkCronAuth(request);
  if (result.ok) return null;

  if (result.status === 500) {
    console.error(
      `[${jobName}] Refusing cron request: CRON_SECRET is not configured. ` +
        "Set CRON_SECRET (or run with NODE_ENV=development for local testing).",
    );
  }

  return NextResponse.json(
    { ok: false, error: result.error },
    { status: result.status },
  );
}
