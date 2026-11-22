import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../../helpers/fake-db";

let db: FakeDb | null = null;
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

import { runDailyReputationRecalculation } from "@/lib/reputation/daily-sync";

function makeBorrower(id: string) {
  return {
    id,
    walletAddress: `G${id}1111111111111111111111111111111111111111111111111111`,
    kycStatus: "verified",
    createdAt: new Date(Date.now() - 30 * 86400 * 1000),
  };
}

describe("reputation daily-sync timeout and abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = createFakeDb();
  });

  it("aborts borrower recalculation loop on AbortSignal and commits partial snapshots", async () => {
    // 1. fetch borrowers (3 borrowers)
    db!.queue([makeBorrower("b1"), makeBorrower("b2"), makeBorrower("b3")]);
    // 2. bulk queries: loans, repayments, snapshots
    db!.queue([]); // loans
    db!.queue([]); // repayments
    db!.queue([]); // snapshots

    // borrower 1 snapshot insert
    db!.queue([]);

    const controller = new AbortController();

    const onProgress = vi.fn(async (progress) => {
      if (progress.updated === 1) {
        controller.abort("Simulated serverless timeout");
      }
    });

    const summary = await runDailyReputationRecalculation({
      signal: controller.signal,
      onProgress,
    });

    expect(summary.aborted).toBe(true);
    expect(summary.updated).toBe(1);
    expect(summary.remaining).toBe(2);
    expect(summary.abortReason).toContain("Execution deadline reached");
  });
});
