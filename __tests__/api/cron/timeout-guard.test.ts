import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CronTimeoutError,
  getCronHeartbeat,
  resetCronHeartbeats,
  withCronTimeout,
} from "@/lib/auth/cron";

describe("withCronTimeout & dead-man switch heartbeats", () => {
  beforeEach(() => {
    resetCronHeartbeats();
  });

  it("records succeeded heartbeat when job finishes within deadline", async () => {
    const { result, timedOut } = await withCronTimeout(
      "payment-due",
      async (signal) => {
        expect(signal.aborted).toBe(false);
        return { processed: 3 };
      },
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({ processed: 3 });
    expect(timedOut).toBe(false);

    const hb = getCronHeartbeat("payment-due");
    expect(hb).not.toBeNull();
    expect(hb?.lastStatus).toBe("succeeded");
    expect(hb?.lastCompletedAt).toBeTruthy();
  });

  it("flushes partial progress cleanly when cooperative AbortSignal fires mid-batch", async () => {
    const { result, timedOut } = await withCronTimeout(
      "default-management",
      async (signal) => {
        let processed = 0;
        for (let i = 0; i < 10; i++) {
          if (signal.aborted) {
            return { processed, timedOut: true };
          }
          processed++;
          await new Promise((r) => setTimeout(r, 15));
        }
        return { processed, timedOut: false };
      },
      { timeoutMs: 25, graceMs: 100 },
    );

    expect(timedOut).toBe(true);
    expect(result.processed).toBeGreaterThan(0);
    expect(result.processed).toBeLessThan(10);

    const hb = getCronHeartbeat("default-management");
    expect(hb?.lastStatus).toBe("timed_out");
  });

  it("rejects with CronTimeoutError and records timed_out when a hung job ignores the signal", async () => {
    await expect(
      withCronTimeout(
        "liquidation",
        () => new Promise(() => {}),
        { timeoutMs: 20, graceMs: 15 },
      ),
    ).rejects.toBeInstanceOf(CronTimeoutError);

    const hb = getCronHeartbeat("liquidation");
    expect(hb?.lastStatus).toBe("timed_out");
    expect(hb?.lastError).toContain("exceeded execution timeout");
  });
});
