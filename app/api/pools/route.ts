import { NextRequest, NextResponse } from "next/server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import { fetchPools } from "@/lib/db/pools";
import { parseBoundedInteger } from "@/lib/http/request-validation";

/**
 * GET /api/pools
 * 
 * Fetch lending pools with optional filtering and pagination.
 * 
 * OPTIMIZATION (Issue #39):
 * - Uses optimized fetchPools function from lib/db/pools.ts
 * - Single query instead of waterfall queries
 * - Explicit column selection (no SELECT *)
 * - Pagination support with limit/offset
 * - Proper ordering with index support
 * 
 * QUERY PARAMETERS:
 * - status: optional pool status filter ('active', 'paused', 'closed')
 * - limit: page size (default: 10, max: 100)
 * - offset: pagination offset (default: 0)
 * - orderBy: sort column ('created_at' or 'available_liquidity', default: 'created_at')
 * - orderDirection: sort direction ('asc' or 'desc', default: 'desc')
 * 
 * RESPONSE:
 * {
 *   success: boolean,
 *   pools: Pool[],
 *   pagination: {
 *     limit: number,
 *     offset: number,
 *     hasMore: boolean,
 *     estimatedTotal: number
 *   }
 * }
 */
export async function GET(request: NextRequest) {
  try {
    // ── Rate limit ───────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: "Database service unavailable" },
        { status: 500 }
      );
    }

    const { searchParams } = request.nextUrl;
    
    // Parse and validate query parameters
    const status = searchParams.get("status") as
      | "active"
      | "paused"
      | "closed"
      | null;
    const safeLimit = parseBoundedInteger(searchParams.get("limit"), 10, 1, 100);
    const safeOffset = parseBoundedInteger(searchParams.get("offset"), 0, 0, 1_000_000);
    if (safeLimit === null || safeOffset === null) {
      return NextResponse.json({ error: "Invalid pagination parameters" }, { status: 400 });
    }
    const orderBy = (searchParams.get("orderBy") || "created_at") as
      | "created_at"
      | "available_liquidity";
    const orderDirection = (searchParams.get("orderDirection") || "desc") as
      | "asc"
      | "desc";

    // Fetch pools using optimized function
    const result = await fetchPools(db, {
      status: status || undefined,
      limit: safeLimit,
      offset: safeOffset,
      orderBy,
      orderDirection,
    });

    return NextResponse.json(
      {
        success: true,
        pools: result.pools,
        pagination: {
          limit: safeLimit,
          offset: safeOffset,
          hasMore: result.hasMore,
          estimatedTotal: result.estimatedTotalCount,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
