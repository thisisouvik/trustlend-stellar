import client from "prom-client";

// ── Registry ──────────────────────────────────────────────────────────────────
const register = new client.Registry();

// ── Default Node.js metrics (memory, event loop, GC, etc.) ──────────────────
client.collectDefaultMetrics({ register });

// ── Custom HTTP metrics ───────────────────────────────────────────────────────
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "path", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "path", "status"] as const,
  registers: [register],
});

export const httpErrorsTotal = new client.Counter({
  name: "http_errors_total",
  help: "Total number of HTTP error responses (status >= 400)",
  labelNames: ["method", "path", "status_code"] as const,
  registers: [register],
});

// ── Scheduled Cron metrics ──────────────────────────────────────────────────
export const cronExecutionsTotal = new client.Counter({
  name: "cron_executions_total",
  help: "Total number of scheduled cron job executions",
  labelNames: ["job_name", "status"] as const,
  registers: [register],
});

export const cronExecutionDuration = new client.Histogram({
  name: "cron_execution_duration_seconds",
  help: "Duration of scheduled cron job executions in seconds",
  labelNames: ["job_name", "status"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const cronAbortsTotal = new client.Counter({
  name: "cron_aborts_total",
  help: "Total number of scheduled cron jobs aborted by dead-man switch",
  labelNames: ["job_name", "reason"] as const,
  registers: [register],
});

export function recordCronMetrics(
  jobName: string,
  status: "completed" | "aborted" | "failed",
  durationSeconds: number,
  abortReason?: string,
): void {
  cronExecutionsTotal.inc({ job_name: jobName, status });
  cronExecutionDuration.observe({ job_name: jobName, status }, durationSeconds);
  if (status === "aborted") {
    cronAbortsTotal.inc({
      job_name: jobName,
      reason: (abortReason ?? "deadline_exceeded").slice(0, 50),
    });
  }
}

// ── Memory gauge (complements default metrics with a simpler alias) ──────────
export const processMemoryBytes = new client.Gauge({
  name: "process_memory_bytes",
  help: "Node.js process memory usage in bytes (heapUsed + heapTotal + external + rss)",
  labelNames: ["memory_type"] as const,
  registers: [register],
});

/**
 * Update the process memory gauge at scrape time so the value is fresh.
 * Called inside the /metrics handler.
 */
export function observeMemoryUsage(): void {
  const mem = process.memoryUsage();
  processMemoryBytes.set({ memory_type: "rss" }, mem.rss);
  processMemoryBytes.set({ memory_type: "heap_total" }, mem.heapTotal);
  processMemoryBytes.set({ memory_type: "heap_used" }, mem.heapUsed);
  processMemoryBytes.set({ memory_type: "external" }, mem.external);
}

/**
 * Record the duration and outcome of an HTTP request.
 *
 * Usage: wrap any API route handler with `trackRequest(handler)` or call
 * `recordRequestMetrics` directly in a middleware / route.
 */
export function recordRequestMetrics(
  method: string,
  path: string,
  status: number,
  durationSeconds: number,
): void {
  const labels = { method, path, status };

  httpRequestDuration.observe(labels, durationSeconds);
  httpRequestsTotal.inc(labels);

  if (status >= 400) {
    httpErrorsTotal.inc({ method, path, status_code: status });
  }
}

/**
 * Higher-order wrapper that instruments a Next.js API route handler with
 * request duration, status code tracking, and error recording.
 *
 * Usage:
 * ```ts
 * import { withMetrics } from "@/lib/monitoring/metrics";
 * import { GET as originalGet } from "./handler";
 * export const GET = withMetrics(originalGet);
 * ```
 */
export function withMetrics<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response> | Response,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const start = performance.now();

    try {
      const response = await handler(...args);

      // Extract method and path from the first argument (NextRequest) if available
      const request = args[0] as { method?: string; nextUrl?: { pathname?: string } } | undefined;
      const method = request?.method ?? "UNKNOWN";
      const path = request?.nextUrl?.pathname ?? "/api/unknown";

      recordRequestMetrics(method, path, response.status, (performance.now() - start) / 1000);

      return response;
    } catch (error) {
      // Errors are caught here only if the handler does NOT catch them itself.
      // We still record a 500 so they aren't invisible.
      const request = args[0] as { method?: string; nextUrl?: { pathname?: string } } | undefined;
      const method = request?.method ?? "UNKNOWN";
      const path = request?.nextUrl?.pathname ?? "/api/unknown";

      recordRequestMetrics(method, path, 500, (performance.now() - start) / 1000);

      throw error;
    }
  };
}

/**
 * Generate the Prometheus-formatted metrics text for the /metrics endpoint.
 */
export async function generateMetricsResponse(): Promise<string> {
  observeMemoryUsage();
  return register.metrics();
}

// ── Expose register for testing ──────────────────────────────────────────────
export { register };
