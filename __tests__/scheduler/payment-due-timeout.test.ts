import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../helpers/fake-db";

let db: FakeDb | null;
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

vi.mock("@/lib/email/resend", () => ({
  isResendConfigured: () => true,
  sendPaymentOverdueEmail: vi.fn().mockResolvedValue({ id: "email-1" }),
}));

import { runPaymentDueScheduler } from "@/lib/scheduler/payment-due";

function makeOverdueLoan(id: string) {
  return {
    id,
    borrowerId: `user-${id}`,
    dueAt: new Date(Date.now() - 86400 * 1000),
    principalAmount: "1000",
    repaidAmount: "200",
    metadata: {},
  };
}

describe("payment-due scheduler timeout and abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("halts execution when signal is aborted mid-batch and returns partial results", async () => {
    db = createFakeDb();
    // overdue loans query returns 3 loans
    db.queue([makeOverdueLoan("loan-1"), makeOverdueLoan("loan-2"), makeOverdueLoan("loan-3")]);
    // update metadata for loan-1
    db.queue([]);

    const controller = new AbortController();

    // After first loan is processed, abort the signal
    const onProgress = vi.fn(async (progress) => {
      if (progress.processed === 1) {
        controller.abort("Simulated execution deadline");
      }
    });

    const result = await runPaymentDueScheduler({
      signal: controller.signal,
      onProgress,
    });

    expect(result.aborted).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.remaining).toBe(2);
    expect(result.abortReason).toContain("Execution deadline");
  });

  it("does not start processing if signal was already aborted before start", async () => {
    db = createFakeDb();
    db.queue([makeOverdueLoan("loan-1"), makeOverdueLoan("loan-2")]);

    const controller = new AbortController();
    controller.abort("Already aborted");

    const result = await runPaymentDueScheduler({
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(2);
  });
});
