import { NextRequest, NextResponse } from "next/server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import {
  ANALYTICS_CACHE_TTL_SECONDS,
  buildPlatformAnalyticsResponse,
  fetchPlatformAnalytics,
} from "@/lib/analytics";
import {
  getCachedPlatformAnalytics,
  setCachedPlatformAnalytics,
} from "@/lib/analytics-cache";
import { getDb } from "@/lib/db/client";

export const revalidate = 3600; // Match ANALYTICS_CACHE_TTL_SECONDS (1 hour)

function getAnalyticsHeaders(cacheState: "hit" | "miss") {
  return {
    "Cache-Control": `public, max-age=${ANALYTICS_CACHE_TTL_SECONDS}, s-maxage=${ANALYTICS_CACHE_TTL_SECONDS}, stale-while-revalidate=86400`,
    "X-Analytics-Cache": cacheState,
  };
}

export async function GET(request: NextRequest) {
  // ── Rate limit ─────────────────────────────────────────────────────────────
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  const cachedResponse = await getCachedPlatformAnalytics();
  if (cachedResponse) {
    return NextResponse.json(cachedResponse, {
      status: 200,
      headers: getAnalyticsHeaders("hit"),
    });
  }

  const db = getDb();

  if (!db) {
    return NextResponse.json(
      { error: "Analytics service unavailable" },
      { status: 503 }
    );
  }

  try {
    const metrics = await fetchPlatformAnalytics(db);
    const payload = buildPlatformAnalyticsResponse(metrics);

    await setCachedPlatformAnalytics(payload, ANALYTICS_CACHE_TTL_SECONDS);

    return NextResponse.json(payload, {
      status: 200,
      headers: getAnalyticsHeaders("miss"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[analytics] Failed to build response:", message);
    return NextResponse.json({ error: "Failed to load analytics" }, { status: 500 });
  }
}
