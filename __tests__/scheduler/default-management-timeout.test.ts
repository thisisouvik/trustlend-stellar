import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../helpers/fake-db";

const mockGetAdminKeypair = vi.fn();
const mockGetLedgerTimeSecs = vi.fn();
const mockInvokeSigned = vi.fn();

vi.mock("@/lib/stellar/server-contract", () => ({
  getAdminKeypair: () => mockGetAdminKeypair(),
  getLedgerTimeSecs: () => mockGetLedgerTimeSecs(),
  invokeSigned: (...args: unknown[]) => mockInvokeSigned(...args),
  addr: (g: string) => ({ addr: g }),
  u32: (n: number) => ({ u32: n }),
  u64: (n: number) => ({ u64: n }),
  i128: (n: bigint) => ({ i128: n }),
  tupleEnumToScVal: (variant: string, fields: unknown[]) => ({ variant, fields }),
  xlmToStroops: (xlm: number) => BigInt(Math.round(xlm * 10_000_000)),
}));

let db: FakeDb | null = null;
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

import { runDefaultManagement } from "@/lib/scheduler/default-management";

const NOW = 1_700_000_000;
const DAY = 86_400;

function makeOverdueLoan(id: string, daysOverdue: number) {
  return {
    id,
    borrowerId: `borrower-${id}`,
    status: "active",
    principalAmount: "1000",
    repaidAmount: "0",
    dueAt: new Date((NOW - daysOverdue * DAY) * 1000),
    defaultedAt: null,
    metadata: {},
  };
}

describe("default-management scheduler timeout and abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLedgerTimeSecs.mockResolvedValue(NOW);
    mockGetAdminKeypair.mockReturnValue(null);
  });

  it("aborts mid-batch on AbortSignal and commits partial loan outcomes", async () => {
    db = createFakeDb();
    // 1. query overdue loans -> returns 3 loans past grace period (10 days overdue)
    db.queue([
      makeOverdueLoan("loan-1", 10),
      makeOverdueLoan("loan-2", 10),
      makeOverdueLoan("loan-3", 10),
    ]);
    // loan-1: funding info
    db.queue([]);
    // loan-1: wallet
    db.queue([{ walletAddress: "G111" }]);
    // loan-1: update metadata
    db.queue([]);

    const controller = new AbortController();

    const onProgress = vi.fn(async (progress) => {
      if (progress.defaulted === 1) {
        controller.abort("Serverless timeout deadline");
      }
    });

    const result = await runDefaultManagement({
      signal: controller.signal,
      onProgress,
    });

    expect(result.aborted).toBe(true);
    expect(result.defaulted).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.remaining).toBe(2);
    expect(result.abortReason).toContain("Execution deadline reached");
  });
});
