import { NextResponse } from "next/server";
import {
  ANALYTICS_CACHE_TTL_SECONDS,
  buildPlatformAnalyticsResponse,
  fetchPlatformAnalytics,
} from "@/lib/analytics";
import {
  getCachedPlatformAnalytics,
  setCachedPlatformAnalytics,
} from "@/lib/analytics-cache";
import { getServiceRoleClient } from "@/lib/supabase/server";

export const revalidate = ANALYTICS_CACHE_TTL_SECONDS;

function getAnalyticsHeaders(cacheState: "hit" | "miss") {
  return {
    "Cache-Control": `public, max-age=${ANALYTICS_CACHE_TTL_SECONDS}, s-maxage=${ANALYTICS_CACHE_TTL_SECONDS}, stale-while-revalidate=86400`,
    "X-Analytics-Cache": cacheState,
  };
}

export async function GET() {
  const cachedResponse = await getCachedPlatformAnalytics();
  if (cachedResponse) {
    return NextResponse.json(cachedResponse, {
      status: 200,
      headers: getAnalyticsHeaders("hit"),
    });
  }

  const supabase = getServiceRoleClient();

  if (!supabase) {
    return NextResponse.json(
      { error: "Analytics service unavailable" },
      { status: 503 }
    );
  }

  try {
    const metrics = await fetchPlatformAnalytics(supabase);
    const payload = buildPlatformAnalyticsResponse(metrics);

    await setCachedPlatformAnalytics(payload, ANALYTICS_CACHE_TTL_SECONDS);

    return NextResponse.json(payload, {
      status: 200,
      headers: getAnalyticsHeaders("miss"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
