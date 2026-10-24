import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { generateMetricsResponse } from "@/lib/monitoring/metrics";
import { enforceRouteRateLimit } from "@/lib/rate-limit";

function safeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function isAuthorizedMetricsRequest(request: NextRequest): boolean {
  const secret = process.env.METRICS_SECRET?.trim();
  if (!secret) {
    return false;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return false;
  }

  return safeEqual(authHeader, `Bearer ${secret}`);
}

/**
 * GET /api/metrics
 *
 * Returns Prometheus-formatted metrics for scraping.
 * Protected by bearer token authentication (`Authorization: Bearer <METRICS_SECRET>`).
 * Content-Type is set to text/plain so Prometheus can parse the response.
 *
 * Metrics include:
 *  - Default Node.js metrics (memory, event loop lag, GC, etc.)
 *  - HTTP request duration histogram (http_request_duration_seconds)
 *  - HTTP request counter (http_requests_total)
 *  - HTTP error counter (http_errors_total)
 *  - Process memory gauge (process_memory_bytes)
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    if (!isAuthorizedMetricsRequest(request)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const metrics = await generateMetricsResponse();
    return new NextResponse(metrics, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate metrics";
    console.error("[metrics]", message);
    return NextResponse.json(
      { error: "Failed to generate metrics" },
      { status: 500 },
    );
  }
}
