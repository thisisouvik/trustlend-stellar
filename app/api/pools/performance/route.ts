import { NextRequest, NextResponse } from "next/server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import { isUuid } from "@/lib/http/request-validation";
import {
  PERFORMANCE_RANGES,
  fetchPoolPerformance,
  parsePerformanceRange,
} from "@/lib/pools/performance";


/**
 * GET /api/pools/performance
 *
 * Daily pool volume and liquidity utilization history (issue #333), used by
 * the lender dashboard chart. Public like GET /api/pools: it exposes only
 * pool-level aggregates, never per-user data.
 *
 * QUERY PARAMETERS:
 * - range:  "7d" | "30d" | "90d" (default "30d")
 * - poolId: optional pool UUID; omitted = aggregate across all pools
 *
 * RESPONSE:
 * {
 *   success: true,
 *   range, days, poolId, generatedAt,
 *   points: Array<{ date, totalLiquidity, borrowed, available,
 *                   utilizationRate, newBorrowed, deposits, withdrawals }>,
 *   summary: { currentUtilization, averageUtilization, peakUtilization,
 *              currentLiquidity, currentBorrowed, borrowedVolume, netFlow }
 * }
 *
 * Amounts are XLM; utilizationRate is (borrowed / totalLiquidity) × 100.
 * See lib/pools/performance.ts for how the history is reconstructed.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { searchParams } = request.nextUrl;

    const range = parsePerformanceRange(searchParams.get("range"));
    if (!range) {
      return NextResponse.json(
        { error: `Invalid range. Use one of: ${Object.keys(PERFORMANCE_RANGES).join(", ")}` },
        { status: 400 },
      );
    }

    const poolId = searchParams.get("poolId");
    if (poolId !== null && !isUuid(poolId)) {
      return NextResponse.json({ error: "Invalid poolId" }, { status: 400 });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database service unavailable" }, { status: 503 });
    }

    const performance = await fetchPoolPerformance(db, { range, poolId });

    return NextResponse.json(
      { success: true, ...performance },
      {
        status: 200,
        // Daily buckets: a short shared cache keeps dashboard loads cheap.
        headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
      },
    );
  } catch (error) {
    console.error("[pools/performance] Failed to build utilization history:", error);
    return NextResponse.json({ error: "Failed to load pool performance" }, { status: 500 });
  }
}
