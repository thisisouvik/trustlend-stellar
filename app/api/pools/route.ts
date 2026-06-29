import { NextRequest, NextResponse } from "next/server";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { fetchPools } from "@/lib/db/pools";

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
    const supabase = getServiceRoleClient();
    if (!supabase) {
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
    const limit = searchParams.has("limit")
      ? parseInt(searchParams.get("limit") || "10", 10)
      : 10;
    const offset = searchParams.has("offset")
      ? parseInt(searchParams.get("offset") || "0", 10)
      : 0;
    const orderBy = (searchParams.get("orderBy") || "created_at") as
      | "created_at"
      | "available_liquidity";
    const orderDirection = (searchParams.get("orderDirection") || "desc") as
      | "asc"
      | "desc";

    // Fetch pools using optimized function
    const result = await fetchPools(supabase, {
      status: status || undefined,
      limit,
      offset,
      orderBy,
      orderDirection,
    });

    return NextResponse.json(
      {
        success: true,
        pools: result.pools,
        pagination: {
          limit,
          offset,
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
