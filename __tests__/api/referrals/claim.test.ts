import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createFakeDb } from "../../helpers/fake-db";
import { referrals } from "@/lib/db/schema";

const mockRequireAuthenticatedUser = vi.fn();
const mockGetDb = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => mockGetDb(),
}));

import { POST } from "@/app/api/referrals/claim/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/referrals/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/referrals/claim (Issue #432)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "00000000-0000-4000-8000-000000000099" },
      role: "borrower",
    });
  });

  it("executes referral registration inside an atomic db.transaction()", async () => {
    const db = createFakeDb() as ReturnType<typeof createFakeDb> & {
      transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    const transactionSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
    db.transaction = transactionSpy;

    db.queue([
      {
        referral_id: "ref-123",
        referrer_id: "user-referrer",
        status: "pending",
      },
    ]);
    mockGetDb.mockReturnValue(db);

    const res = await POST(makeRequest({ code: "TL-ABCD2345" }));
    expect(res.status).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    const json = await res.json();
    expect(json.referralId).toBe("ref-123");
    expect(json.status).toBe("pending");
  });

  it("returns 409 Conflict when concurrent referral claim hits unique constraint on referee_id", async () => {
    const db = createFakeDb() as ReturnType<typeof createFakeDb> & {
      transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    db.transaction = vi.fn(async () => {
      const conflictErr = new Error(
        'duplicate key value violates unique constraint "referrals_referee_id_key"',
      ) as Error & { code: string };
      conflictErr.code = "23505";
      throw conflictErr;
    });
    mockGetDb.mockReturnValue(db);

    const res = await POST(makeRequest({ code: "TL-ABCD2345" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Referral has already been claimed for this account",
    });
  });

  it("enforces database-level uniqueness on referrals.referee_id in schema", () => {
    const tableConfig = getTableConfig(referrals);
    const refereeCol = tableConfig.columns.find((col) => col.name === "referee_id");
    expect(refereeCol?.isUnique).toBe(true);

    const uniqueRefereeIndex = tableConfig.indexes.find(
      (idx) => idx.config.name === "referrals_referee_id_key" && idx.config.unique,
    );
    expect(uniqueRefereeIndex).toBeDefined();
  });
});
