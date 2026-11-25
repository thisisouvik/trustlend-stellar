import { describe, expect, it, vi } from "vitest";
import {
  CronTimeoutError,
  DeadManSwitch,
} from "@/lib/cron/dead-man-switch";

describe("DeadManSwitch", () => {
  it("initializes with computed effective deadline and safety buffer", () => {
    const sw = new DeadManSwitch({
      jobName: "test-job",
      timeoutMs: 10_000,
      safetyBufferMs: 2_000,
    });

    expect(sw.jobName).toBe("test-job");
    expect(sw.timeoutMs).toBe(10_000);
    expect(sw.safetyBufferMs).toBe(2_000);
    expect(sw.effectiveDeadlineMs).toBe(8_000);
    expect(sw.isAborted()).toBe(false);
    expect(sw.signal.aborted).toBe(false);
  });

  it("calculates remaining time accurately before and after starting", async () => {
    const sw = new DeadManSwitch({
      jobName: "test-job",
      timeoutMs: 5_000,
      safetyBufferMs: 1_000,
    });

    expect(sw.getRemainingTimeMs()).toBe(4_000);

    sw.start();
    expect(sw.getRemainingTimeMs()).toBeLessThanOrEqual(4_000);
    expect(sw.getRemainingTimeMs()).toBeGreaterThan(3_000);
    sw.stop();
  });

  it("triggers abort manually with custom reason and invokes onAbort handlers", () => {
    const onAbort = vi.fn();
    const sw = new DeadManSwitch({
      jobName: "test-job",
      timeoutMs: 10_000,
      safetyBufferMs: 1_000,
      onAbort,
    });

    sw.start();
    expect(sw.isAborted()).toBe(false);

    sw.triggerAbort("Manual test abort");

    expect(sw.isAborted()).toBe(true);
    expect(sw.signal.aborted).toBe(true);
    expect(sw.getAbortReason()).toBe("Manual test abort");
    expect(onAbort).toHaveBeenCalledWith("Manual test abort");
  });

  it("checkOrAbort detects insufficient time for next item", () => {
    const sw = new DeadManSwitch({
      jobName: "test-job",
      timeoutMs: 1_000,
      safetyBufferMs: 800, // effective deadline 200ms
    });

    sw.start();
    // Asking for 500ms when only ~200ms remain should trigger abort
    const aborted = sw.checkOrAbort(500, "slow item");

    expect(aborted).toBe(true);
    expect(sw.isAborted()).toBe(true);
    expect(sw.getAbortReason()).toContain("Insufficient remaining execution time");
    sw.stop();
  });

  it("fires automatically when effective deadline timer elapses", async () => {
    vi.useFakeTimers();
    try {
      const sw = new DeadManSwitch({
        jobName: "quick-job",
        timeoutMs: 300,
        safetyBufferMs: 100, // 200ms effective deadline
      });

      sw.start();
      expect(sw.isAborted()).toBe(false);

      vi.advanceTimersByTime(201);

      expect(sw.isAborted()).toBe(true);
      expect(sw.getAbortReason()).toContain("Execution deadline reached");
      sw.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("CronTimeoutError contains structured metadata", () => {
    const err = new CronTimeoutError("liquidation", 59_000, 60_000);
    expect(err.name).toBe("CronTimeoutError");
    expect(err.jobName).toBe("liquidation");
    expect(err.elapsedMs).toBe(59_000);
    expect(err.timeoutMs).toBe(60_000);
    expect(err.message).toContain("liquidation");
    expect(err.message).toContain("59000ms");
  });
});
