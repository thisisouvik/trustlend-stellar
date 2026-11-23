import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../../helpers/fake-db";

let fakeDb: FakeDb | null = null;
vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

import {
  abortCronExecution,
  completeCronExecution,
  failCronExecution,
  recordCronAlert,
  startCronExecution,
  updateCronProgress,
} from "@/lib/cron/cron-logger";

describe("cron-logger", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
  });

  it("starts cron execution by inserting a running log", async () => {
    fakeDb!.queue([{ id: "log-123" }]);

    const logId = await startCronExecution("payment-due", { source: "test" });

    expect(logId).toBe("log-123");
    expect(fakeDb!.calls.some((c) => c.method === "insert")).toBe(true);
  });

  it("updates batch progress into the execution log", async () => {
    fakeDb!.queue([]);

    await updateCronProgress("log-123", {
      processed: 5,
      succeeded: 4,
      failed: 1,
    });

    expect(fakeDb!.calls.some((c) => c.method === "update")).toBe(true);
  });

  it("completes cron execution with final summary and duration", async () => {
    fakeDb!.queue([{ startedAt: new Date(Date.now() - 500) }]); // select
    fakeDb!.queue([]); // update

    await completeCronExecution("log-123", {
      processed: 10,
      succeeded: 10,
      failed: 0,
      metadata: { items: 10 },
    });

    expect(fakeDb!.calls.some((c) => c.method === "update")).toBe(true);
  });

  it("records graceful abort with abortReason and partial progress", async () => {
    fakeDb!.queue([{ startedAt: new Date(Date.now() - 1000) }]); // select
    fakeDb!.queue([]); // update

    await abortCronExecution("log-123", "Deadline reached mid-batch", {
      processed: 6,
      succeeded: 5,
      failed: 1,
    });

    expect(fakeDb!.calls.some((c) => c.method === "update")).toBe(true);
  });

  it("records execution failure with error details", async () => {
    fakeDb!.queue([{ startedAt: new Date(Date.now() - 200) }]); // select
    fakeDb!.queue([]); // update

    await failCronExecution("log-123", new Error("Horizon RPC down"));

    expect(fakeDb!.calls.some((c) => c.method === "update")).toBe(true);
  });

  it("records cron alert in the cron_alerts table", async () => {
    fakeDb!.queue([]);

    await recordCronAlert(
      "price-oracle",
      "error",
      "No usable price sources available",
      { failedSources: ["binance", "coinbase"] },
      "log-123",
    );

    expect(fakeDb!.calls.some((c) => c.method === "insert")).toBe(true);
  });

  it("handles null database gracefully without throwing", async () => {
    fakeDb = null;

    const logId = await startCronExecution("test", {});
    expect(logId).toBeNull();

    await expect(updateCronProgress("log-1", { processed: 1 })).resolves.not.toThrow();
    await expect(completeCronExecution("log-1", {})).resolves.not.toThrow();
    await expect(abortCronExecution("log-1", "test")).resolves.not.toThrow();
    await expect(failCronExecution("log-1", "test")).resolves.not.toThrow();
    await expect(recordCronAlert("test", "error", "alert")).resolves.not.toThrow();
  });
});
