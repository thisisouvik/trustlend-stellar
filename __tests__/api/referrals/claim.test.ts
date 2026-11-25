import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockRequireAuthenticatedUser = vi.fn();
const mockExecute = vi.fn();
const mockTransaction = vi.fn();
const mockGetPooledDb = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db/client", () => ({
  getPooledDb: () => mockGetPooledDb(),
}));

import { POST } from "@/app/api/referrals/claim/route";

function request(code: unknown) {
  return new NextRequest("http://localhost/api/referrals/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("POST /api/referrals/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthenticatedUser.mockResolvedValue({ user: { id: "referee-1" } });
    mockTransaction.mockImplementation(async (callback) => callback({ execute: mockExecute }));
    mockGetPooledDb.mockReturnValue({ transaction: mockTransaction });
  });

  it("runs a referral claim in one transaction", async () => {
    mockExecute.mockResolvedValue({
      rows: [{ referral_id: "referral-1", referrer_id: "referrer-1", status: "pending" }],
    });

    const response = await POST(request("tlabc234"));

    expect(response.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      referralId: "referral-1",
      status: "pending",
    });
  });

  it("returns the established referral when concurrent claims target different links", async () => {
    // record_referral uses INSERT ... ON CONFLICT (referee_id) DO NOTHING and
    // returns the winning row, making a losing concurrent request idempotent.
    mockExecute.mockResolvedValue({
      rows: [{ referral_id: "referral-winner", referrer_id: "first-referrer", status: "pending" }],
    });

    const response = await POST(request("TLCDEF23"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      referralId: "referral-winner",
      status: "pending",
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("maps an unknown referral code raised inside the transaction to 404", async () => {
    mockExecute.mockRejectedValue(new Error("Unknown referral code"));

    const response = await POST(request("TLZZZZZZ"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "That referral code does not exist" });
  });

  it("returns 503 when no transactional database client is configured", async () => {
    mockGetPooledDb.mockReturnValue(null);

    const response = await POST(request("TLABC234"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Database unavailable" });
  });
});
