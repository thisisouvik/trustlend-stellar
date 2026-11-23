/**
 * lib/cron/dead-man-switch.ts
 *
 * Execution deadline timer and dead-man switch wrapper for scheduled cron handlers.
 * Prevents serverless runtime termination mid-batch by triggering an AbortSignal
 * ahead of the platform execution limit (e.g. 10s, 60s, or 300s), giving
 * handlers a safety window to flush completed records and record partial status.
 */

export class CronTimeoutError extends Error {
  public readonly jobName: string;
  public readonly elapsedMs: number;
  public readonly timeoutMs: number;

  constructor(jobName: string, elapsedMs: number, timeoutMs: number, message?: string) {
    super(
      message ??
        `[${jobName}] Execution deadline exceeded after ${elapsedMs}ms (timeout limit: ${timeoutMs}ms)`,
    );
    this.name = "CronTimeoutError";
    this.jobName = jobName;
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
  }
}

export interface DeadManSwitchOptions {
  jobName: string;
  timeoutMs: number;
  safetyBufferMs?: number;
  onAbort?: (reason: string) => Promise<void> | void;
}

export class DeadManSwitch {
  public readonly jobName: string;
  public readonly timeoutMs: number;
  public readonly safetyBufferMs: number;
  public readonly effectiveDeadlineMs: number;
  private readonly controller: AbortController;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private aborted = false;
  private abortReason: string | null = null;
  private readonly onAbortHandlers: Array<(reason: string) => Promise<void> | void> = [];

  constructor(options: DeadManSwitchOptions) {
    this.jobName = options.jobName;
    this.timeoutMs = Math.max(50, options.timeoutMs);
    // Buffer defaults to 10% of timeout or 3s, capped below timeout
    const defaultBuffer = Math.min(5000, Math.floor(this.timeoutMs * 0.1));
    this.safetyBufferMs = Math.max(0, options.safetyBufferMs ?? defaultBuffer);
    this.effectiveDeadlineMs = Math.max(25, this.timeoutMs - this.safetyBufferMs);
    this.controller = new AbortController();

    if (options.onAbort) {
      this.onAbortHandlers.push(options.onAbort);
    }
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public start(): this {
    if (this.startedAt > 0) return this;
    this.startedAt = Date.now();

    this.timer = setTimeout(() => {
      this.triggerAbort(
        `Execution deadline reached (${this.effectiveDeadlineMs}ms elapsed, safety buffer ${this.safetyBufferMs}ms)`,
      );
    }, this.effectiveDeadlineMs);

    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    return this;
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public onAbort(handler: (reason: string) => Promise<void> | void): void {
    this.onAbortHandlers.push(handler);
  }

  public triggerAbort(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    this.stop();

    try {
      this.controller.abort(reason);
    } catch {
      // Node/browser compatibility
    }

    for (const handler of this.onAbortHandlers) {
      try {
        const res = handler(reason);
        if (res && typeof res.catch === "function") {
          res.catch((err: unknown) =>
            console.warn(`[dead-man-switch:${this.jobName}] onAbort handler failed:`, err),
          );
        }
      } catch (err) {
        console.warn(`[dead-man-switch:${this.jobName}] onAbort handler error:`, err);
      }
    }
  }

  public isAborted(): boolean {
    return this.aborted || this.controller.signal.aborted;
  }

  public getAbortReason(): string | null {
    return this.abortReason;
  }

  public getElapsedMs(): number {
    return this.startedAt > 0 ? Date.now() - this.startedAt : 0;
  }

  public getRemainingTimeMs(): number {
    if (this.startedAt === 0) return this.effectiveDeadlineMs;
    const elapsed = Date.now() - this.startedAt;
    return Math.max(0, this.effectiveDeadlineMs - elapsed);
  }

  public isTimeExceeded(itemEstimateMs = 500): boolean {
    return this.isAborted() || this.getRemainingTimeMs() < itemEstimateMs;
  }

  public checkOrAbort(itemEstimateMs = 500, label = "batch iteration"): boolean {
    if (this.isAborted()) return true;
    const remaining = this.getRemainingTimeMs();
    if (remaining < itemEstimateMs) {
      this.triggerAbort(
        `Insufficient remaining execution time (${remaining}ms < ${itemEstimateMs}ms estimated for next ${label})`,
      );
      return true;
    }
    return false;
  }
}
