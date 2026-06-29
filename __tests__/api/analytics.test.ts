import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/route";
import {
  clearAnalyticsMemoryCacheForTests,
} from "@/lib/analytics-cache";

const mockGetServiceRoleClient = vi.fn();
const mockGetCachedPlatformAnalytics = vi.fn();
const mockSetCachedPlatformAnalytics = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/analytics-cache", () => ({
  getCachedPlatformAnalytics: () => mockGetCachedPlatformAnalytics(),
  setCachedPlatformAnalytics: (...args: unknown[]) => mockSetCachedPlatformAnalytics(...args),
  clearAnalyticsMemoryCacheForTests: vi.fn(),
}));

function createClientStub() {
  return {
    from: (table: string) => ({
      select: () => {
        if (table === "loans") {
          return Promise.resolve({
            data: [
              { principal_amount: 1000, status: "funded" },
              { principal_amount: 2500, status: "active" },
              { principal_amount: 999, status: "requested" },
            ],
            error: null,
          });
        }

        if (table === "pool_positions") {
          return Promise.resolve({
            data: [
              { principal_amount: 4000, earned_interest: 120, status: "active" },
              { principal_amount: 500, earned_interest: 40, status: "closed" },
            ],
            error: null,
          });
        }

        if (table === "loan_repayments") {
          return Promise.resolve({
            data: [
              { amount: 600 },
              { amount: 500 },
            ],
            error: null,
          });
        }

        if (table === "ledger_transactions") {
          return Promise.resolve({
            data: [
              {
                amount: 1200,
                user_id: "u1",
                status: "confirmed",
                created_at: new Date().toISOString(),
              },
              {
                amount: 800,
                user_id: "u2",
                status: "confirmed",
                created_at: new Date().toISOString(),
              },
              {
                amount: 300,
                user_id: "u3",
                status: "pending",
                created_at: new Date().toISOString(),
              },
            ],
            error: null,
          });
        }

        return Promise.resolve({ data: [], error: null });
      },
    }),
  } as unknown as {
    from: (
      table: string,
    ) => {
      select: () => Promise<{ data: unknown[]; error: null }>;
    };
  };
}

describe("GET /api/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAnalyticsMemoryCacheForTests();
    mockGetCachedPlatformAnalytics.mockReset();
    mockSetCachedPlatformAnalytics.mockReset();
  });

  it("returns a cached payload without hitting the database", async () => {
    const cachedPayload = {
      success: true,
      metrics: {
        tvl: 123,
        totalRepaid: 45,
        platformYields: 67,
        activeUsers: 8,
        cumulativeTransactionVolume: 90,
      },
      generatedAt: "2026-06-29T00:00:00.000Z",
    };

    mockGetCachedPlatformAnalytics.mockResolvedValue(cachedPayload);

    const response = await GET({
      nextUrl: new URL("http://localhost/api/analytics"),
    } as NextRequest);

    expect(response.status).toBe(200);
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
    expect(mockSetCachedPlatformAnalytics).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(cachedPayload);
    expect(response.headers.get("x-analytics-cache")).toBe("hit");
  });

  it("returns aggregated platform metrics and stores them in cache", async () => {
    mockGetCachedPlatformAnalytics.mockResolvedValue(null);
    mockGetServiceRoleClient.mockReturnValue(createClientStub());

    const response = await GET({
      nextUrl: new URL("http://localhost/api/analytics"),
    } as NextRequest);

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.metrics).toMatchObject({
      tvl: 7500,
      totalRepaid: 1100,
      platformYields: 160,
      activeUsers: 2,
      cumulativeTransactionVolume: 2000,
    });
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
    expect(response.headers.get("x-analytics-cache")).toBe("miss");
    expect(mockSetCachedPlatformAnalytics).toHaveBeenCalledTimes(1);
  });

  it("returns a service unavailable response when the client cannot be created", async () => {
    mockGetCachedPlatformAnalytics.mockResolvedValue(null);
    mockGetServiceRoleClient.mockReturnValue(null);

    const response = await GET({
      nextUrl: new URL("http://localhost/api/analytics"),
    } as NextRequest);

    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.error).toBe("Analytics service unavailable");
  });
});
