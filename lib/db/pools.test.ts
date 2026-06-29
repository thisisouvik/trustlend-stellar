/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for optimized pool database queries
 * 
 * Tests verify:
 * - Only ONE query/RPC call is made instead of multiple
 * - Correct data shape and types are returned
 * - Pagination works correctly
 * - Filtering by status works
 * - Error handling
 * 
 * Run with: npm test -- pools.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchPools,
  fetchPoolById,
  fetchActivePoolsWithLiquidity,
  fetchAdminDashboardPools,
  type Pool,
} from "./pools";

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_POOLS: Pool[] = [
  {
    id: "pool-1",
    name: "Alpha Pool",
    description: "Premium lending pool",
    status: "active",
    apr_bps: 1500,
    total_liquidity: 50000,
    available_liquidity: 25000,
    total_borrowed: 25000,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "pool-2",
    name: "Beta Pool",
    description: null,
    status: "active",
    apr_bps: 2000,
    total_liquidity: 100000,
    available_liquidity: 100000,
    total_borrowed: 0,
    created_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  },
  {
    id: "pool-3",
    name: "Gamma Pool",
    description: "Paused pool",
    status: "paused",
    apr_bps: 1000,
    total_liquidity: 30000,
    available_liquidity: 30000,
    total_borrowed: 0,
    created_at: "2024-01-03T00:00:00Z",
    updated_at: "2024-01-03T00:00:00Z",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function createMockSupabaseClient(
  overrides: Partial<SupabaseClient> = {}
): SupabaseClient {
  const mockClient = {
    from: vi.fn(),
    ...overrides,
  } as unknown as SupabaseClient;

  return mockClient;
}

function createMockQuery(data: any[] = [], count: number | null = null) {
  const select = vi.fn();
  const eq = vi.fn();
  const gt = vi.fn();
  const order = vi.fn();
  const limit = vi.fn();
  const range = vi.fn();
  const maybeSingle = vi.fn();

  const queryChain = {
    select,
    eq,
    gt,
    order,
    limit,
    range,
    maybeSingle,
    data,
    error: null,
    count,
  };

  // Setup chainable methods
  select.mockReturnValue({
    ...queryChain,
    eq: eq.mockReturnValue(queryChain),
    gt: gt.mockReturnValue(queryChain),
    order: order.mockReturnValue(queryChain),
    limit: limit.mockReturnValue(queryChain),
    range: range.mockReturnValue(queryChain),
    maybeSingle: maybeSingle.mockReturnValue({ data: data[0] || null, error: null }),
  });

  eq.mockReturnValue({
    ...queryChain,
    gt: gt.mockReturnValue(queryChain),
    order: order.mockReturnValue(queryChain),
    limit: limit.mockReturnValue(queryChain),
    range: range.mockReturnValue(queryChain),
    maybeSingle: maybeSingle.mockReturnValue({ data: data[0] || null, error: null }),
  });

  gt.mockReturnValue({
    ...queryChain,
    order: order.mockReturnValue(queryChain),
    limit: limit.mockReturnValue(queryChain),
    range: range.mockReturnValue(queryChain),
  });

  order.mockReturnValue({
    ...queryChain,
    limit: limit.mockReturnValue(queryChain),
    range: range.mockReturnValue(queryChain),
    maybeSingle: maybeSingle.mockReturnValue({ data: data[0] || null, error: null }),
  });

  limit.mockReturnValue({
    ...queryChain,
    order: order.mockReturnValue(queryChain),
  });

  range.mockReturnValue(queryChain);

  return queryChain as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITES
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchPools", () => {
  it("should make a single query with explicit columns", async () => {
    const mockFrom = vi.fn();
    const mockQuery = createMockQuery(MOCK_POOLS.slice(0, 2), 2);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    const result = await fetchPools(client);

    // Verify only ONE query was made
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith("lending_pools");

    // Verify explicit column selection (no SELECT *)
    expect(mockQuery.select).toHaveBeenCalledWith(
      "id, name, description, status, apr_bps, total_liquidity, available_liquidity, total_borrowed, created_at, updated_at",
      expect.any(Object)
    );

    // Verify pagination was applied
    expect(mockQuery.range).toHaveBeenCalledWith(0, 9); // default limit 10

    // Verify result structure
    expect(result.pools).toHaveLength(2);
    expect(result.pools[0]).toEqual(MOCK_POOLS[0]);
    expect(result.hasMore).toBe(false); // got 2, wanted 10
  });

  it("should apply status filter when provided", async () => {
    const mockFrom = vi.fn();
    const activePools = MOCK_POOLS.filter((p) => p.status === "active");
    const mockQuery = createMockQuery(activePools, activePools.length);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    await fetchPools(client, { status: "active" });

    // Verify status filter was applied
    expect(mockQuery.eq).toHaveBeenCalledWith("status", "active");
  });

  it("should handle pagination correctly", async () => {
    const mockFrom = vi.fn();
    const mockQuery = createMockQuery(MOCK_POOLS.slice(0, 1), 100);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    const result = await fetchPools(client, { limit: 10, offset: 20 });

    // Verify correct range was requested
    expect(mockQuery.range).toHaveBeenCalledWith(20, 29);
    expect(result.hasMore).toBe(true); // More pages available
  });

  it("should throw error on query failure", async () => {
    const mockFrom = vi.fn();
    const errorQuery = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            range: vi.fn().mockResolvedValue({
              data: null,
              error: { message: "Database error" },
            }),
          }),
        }),
      }),
      eq: vi.fn(),
      order: vi.fn(),
      range: vi.fn(),
    };
    mockFrom.mockReturnValue(errorQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    await expect(fetchPools(client)).rejects.toThrow("Failed to fetch pools");
  });

  it("should clamp limit to max 100", async () => {
    const mockFrom = vi.fn();
    const mockQuery = createMockQuery([], 0);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    await fetchPools(client, { limit: 500 });

    // Should clamp to 100
    expect(mockQuery.range).toHaveBeenCalledWith(0, 99);
  });
});

describe("fetchPoolById", () => {
  it("should fetch a single pool by ID with one query", async () => {
    const mockFrom = vi.fn();
    const mockQuery = createMockQuery([MOCK_POOLS[0]]);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    const result = await fetchPoolById(client, "pool-1");

    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockQuery.eq).toHaveBeenCalledWith("id", "pool-1");
    expect(result).toEqual(MOCK_POOLS[0]);
  });

  it("should return null if pool not found", async () => {
    const mockFrom = vi.fn();
    const mockQuery = createMockQuery([]);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    const result = await fetchPoolById(client, "nonexistent");

    expect(result).toBeNull();
  });
});

describe("fetchActivePoolsWithLiquidity", () => {
  it("should fetch only active pools with one query", async () => {
    const mockFrom = vi.fn();
    const activePools = MOCK_POOLS.filter((p) => p.status === "active");
    const mockQuery = createMockQuery(activePools);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    const result = await fetchActivePoolsWithLiquidity(client);

    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockQuery.eq).toHaveBeenCalledWith("status", "active");
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.status === "active")).toBe(true);
  });

  it("should filter by minimum liquidity when provided", async () => {
    const mockFrom = vi.fn();
    const highLiquidityPools = MOCK_POOLS.filter(
      (p) => p.status === "active" && p.available_liquidity >= 50000
    );
    const mockQuery = createMockQuery(highLiquidityPools);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    const result = await fetchActivePoolsWithLiquidity(client, 50000);

    expect(mockQuery.gt).toHaveBeenCalledWith("available_liquidity", 50000);
    expect(result.every((p) => p.available_liquidity >= 50000)).toBe(true);
  });

  it("should sort by available liquidity descending", async () => {
    const mockFrom = vi.fn();
    const mockQuery = createMockQuery(MOCK_POOLS);
    mockFrom.mockReturnValue(mockQuery);

    const client = createMockSupabaseClient({ from: mockFrom });

    await fetchActivePoolsWithLiquidity(client);

    expect(mockQuery.order).toHaveBeenCalledWith("available_liquidity", {
      ascending: false,
    });
  });
});

describe("fetchAdminDashboardPools", () => {
  it("should fetch pools and loans in parallel (2 queries, not sequential)", async () => {
    const mockLoans = [
      {
        id: "loan-1",
        status: "requested",
        principal_amount: 5000,
        apr_bps: 1500,
        duration_days: 30,
        requested_at: "2024-01-01T00:00:00Z",
        borrower_id: "user-1",
        profiles: { full_name: "John Doe" },
      },
    ];

    const mockFromPool = vi.fn();
    const mockPoolQuery = createMockQuery(MOCK_POOLS);
    mockFromPool.mockReturnValue(mockPoolQuery);

    const mockFromLoans = vi.fn();
    const mockLoanQuery = createMockQuery(mockLoans);
    mockFromLoans.mockReturnValue(mockLoanQuery);

    const client = createMockSupabaseClient({
      from: (table: string) => {
        if (table === "lending_pools") return mockFromPool();
        if (table === "loans") return mockFromLoans();
      },
    });

    const result = await fetchAdminDashboardPools(client);

    expect(result.pools).toHaveLength(3);
    expect(result.pendingLoans).toHaveLength(1);
    expect(result.pendingLoans[0].borrower_profile?.full_name).toBe("John Doe");
  });

  it("should handle profile relation cardinality (array format)", async () => {
    const mockLoans = [
      {
        id: "loan-1",
        status: "requested",
        principal_amount: 5000,
        apr_bps: 1500,
        duration_days: 30,
        requested_at: "2024-01-01T00:00:00Z",
        borrower_id: "user-1",
        profiles: [{ full_name: "Jane Doe" }], // Array format
      },
    ];

    const mockFromPool = vi.fn();
    const mockPoolQuery = createMockQuery(MOCK_POOLS);
    mockFromPool.mockReturnValue(mockPoolQuery);

    const mockFromLoans = vi.fn();
    const mockLoanQuery = createMockQuery(mockLoans);
    mockFromLoans.mockReturnValue(mockLoanQuery);

    const client = createMockSupabaseClient({
      from: (table: string) => {
        if (table === "lending_pools") return mockFromPool();
        if (table === "loans") return mockFromLoans();
      },
    });

    const result = await fetchAdminDashboardPools(client);

    expect(result.pendingLoans[0].borrower_profile?.full_name).toBe("Jane Doe");
  });

  it("should handle null borrower profile", async () => {
    const mockLoans = [
      {
        id: "loan-1",
        status: "requested",
        principal_amount: 5000,
        apr_bps: 1500,
        duration_days: 30,
        requested_at: "2024-01-01T00:00:00Z",
        borrower_id: "user-1",
        profiles: null,
      },
    ];

    const mockFromPool = vi.fn();
    const mockPoolQuery = createMockQuery(MOCK_POOLS);
    mockFromPool.mockReturnValue(mockPoolQuery);

    const mockFromLoans = vi.fn();
    const mockLoanQuery = createMockQuery(mockLoans);
    mockFromLoans.mockReturnValue(mockLoanQuery);

    const client = createMockSupabaseClient({
      from: (table: string) => {
        if (table === "lending_pools") return mockFromPool();
        if (table === "loans") return mockFromLoans();
      },
    });

    const result = await fetchAdminDashboardPools(client);

    expect(result.pendingLoans[0].borrower_profile).toBeNull();
  });
});

describe("Performance: Query Count Verification", () => {
  it("fetchPools should make exactly 1 query", async () => {
    let queryCount = 0;
    const mockFrom = vi.fn(() => {
      queryCount++;
      return createMockQuery(MOCK_POOLS);
    });

    const client = createMockSupabaseClient({ from: mockFrom });

    await fetchPools(client);

    expect(queryCount).toBe(1);
  });

  it("fetchPoolById should make exactly 1 query", async () => {
    let queryCount = 0;
    const mockFrom = vi.fn(() => {
      queryCount++;
      return createMockQuery([MOCK_POOLS[0]]);
    });

    const client = createMockSupabaseClient({ from: mockFrom });

    await fetchPoolById(client, "pool-1");

    expect(queryCount).toBe(1);
  });

  it("fetchActivePoolsWithLiquidity should make exactly 1 query", async () => {
    let queryCount = 0;
    const mockFrom = vi.fn(() => {
      queryCount++;
      return createMockQuery(MOCK_POOLS.filter((p) => p.status === "active"));
    });

    const client = createMockSupabaseClient({ from: mockFrom });

    await fetchActivePoolsWithLiquidity(client);

    expect(queryCount).toBe(1);
  });

  it("fetchAdminDashboardPools should make exactly 2 queries (parallel)", async () => {
    let queryCount = 0;
    const mockFrom = vi.fn(() => {
      queryCount++;
      return createMockQuery(queryCount === 1 ? MOCK_POOLS : []);
    });

    const client = createMockSupabaseClient({ from: mockFrom });

    await fetchAdminDashboardPools(client);

    // Should be 2 total: 1 for pools, 1 for loans
    expect(queryCount).toBe(2);
  });
});
