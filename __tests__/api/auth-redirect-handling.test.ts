import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockRequireApiAdmin,
  mockRequireAuthenticatedUser,
  MockUnauthorizedError,
  makeRedirectError,
} = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status: 401 | 403;

    constructor(message = "Not authenticated", status?: 401 | 403) {
      super(message);
      this.name = "UnauthorizedError";
      this.status = status ?? (message === "Not authenticated" ? 401 : 403);
    }
  }

  function makeRedirectError(url = "/auth") {
    const err = new Error("NEXT_REDIRECT") as Error & { digest: string };
    err.digest = `NEXT_REDIRECT;replace;${url};307;`;
    return err;
  }

  return {
    mockRequireApiAdmin: vi.fn(),
    mockRequireAuthenticatedUser: vi.fn(),
    MockUnauthorizedError,
    makeRedirectError,
  };
});

vi.mock("@/lib/auth/session", () => ({
  requireApiAdmin: () => mockRequireApiAdmin(),
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
  UnauthorizedError: MockUnauthorizedError,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

import { GET as getRiskParams, POST as postRiskParams } from "@/app/api/admin/risk-parameters/route";
import { GET as getBorrowerTransactions } from "@/app/api/borrower/transactions/route";
import { GET as getLenderTransactions } from "@/app/api/lender/transactions/route";
import { POST as postSep31Deposit } from "@/app/api/pools/sep31-deposit/route";

describe("API Route Auth & NEXT_REDIRECT Handling (Issue #429)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("/api/admin/risk-parameters", () => {
    it("returns 401 JSON when caller is unauthenticated", async () => {
      mockRequireApiAdmin.mockRejectedValueOnce(new MockUnauthorizedError("Not authenticated", 401));

      const res = await getRiskParams(new NextRequest("http://localhost/api/admin/risk-parameters"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: "Authentication required",
      });
    });

    it("returns 403 JSON when caller is not an admin on POST", async () => {
      mockRequireApiAdmin.mockRejectedValueOnce(new MockUnauthorizedError("Admin access required.", 403));

      const res = await postRiskParams(
        new NextRequest("http://localhost/api/admin/risk-parameters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        success: false,
        error: "Admin access required",
      });
    });

    it("rethrows NEXT_REDIRECT instead of returning 500", async () => {
      mockRequireApiAdmin.mockRejectedValueOnce(makeRedirectError("/auth"));

      await expect(
        postRiskParams(
          new NextRequest("http://localhost/api/admin/risk-parameters", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT");
    });
  });

  describe("Borrower, Lender, and Pool API routes", () => {
    it("rethrows NEXT_REDIRECT in GET /api/borrower/transactions instead of returning 500", async () => {
      mockRequireAuthenticatedUser.mockRejectedValueOnce(makeRedirectError("/auth"));

      await expect(
        getBorrowerTransactions(new NextRequest("http://localhost/api/borrower/transactions")),
      ).rejects.toThrow("NEXT_REDIRECT");
    });

    it("rethrows NEXT_REDIRECT in GET /api/lender/transactions instead of returning 500", async () => {
      mockRequireAuthenticatedUser.mockRejectedValueOnce(makeRedirectError("/auth"));

      await expect(
        getLenderTransactions(new NextRequest("http://localhost/api/lender/transactions")),
      ).rejects.toThrow("NEXT_REDIRECT");
    });

    it("rethrows NEXT_REDIRECT in POST /api/pools/sep31-deposit instead of returning 500", async () => {
      mockRequireAuthenticatedUser.mockRejectedValueOnce(makeRedirectError("/auth"));

      await expect(
        postSep31Deposit(
          new NextRequest("http://localhost/api/pools/sep31-deposit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT");
    });
  });
});
