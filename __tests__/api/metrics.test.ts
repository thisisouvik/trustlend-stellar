import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/metrics/route";

// Mock the metrics module so we don't hit prom-client internals in tests
const mockGenerateMetricsResponse = vi.fn();

vi.mock("@/lib/monitoring/metrics", () => ({
  generateMetricsResponse: () => mockGenerateMetricsResponse(),
}));

const TEST_METRICS_SECRET = "test-metrics-secret";

function makeMetricsRequest(token: string | null = TEST_METRICS_SECRET) {
  return new NextRequest(
    "http://localhost/api/metrics",
    token !== null
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
  );
}

describe("GET /api/metrics", () => {
  const originalSecret = process.env.METRICS_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateMetricsResponse.mockReset();
    process.env.METRICS_SECRET = TEST_METRICS_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.METRICS_SECRET;
    } else {
      process.env.METRICS_SECRET = originalSecret;
    }
  });

  it("returns 401 when Authorization header is missing", async () => {
    const response = await GET(makeMetricsRequest(null));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockGenerateMetricsResponse).not.toHaveBeenCalled();
  });

  it("returns 401 when bearer token is invalid", async () => {
    const response = await GET(makeMetricsRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockGenerateMetricsResponse).not.toHaveBeenCalled();
  });

  it("returns 401 when METRICS_SECRET is not configured", async () => {
    delete process.env.METRICS_SECRET;

    const response = await GET(makeMetricsRequest(TEST_METRICS_SECRET));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockGenerateMetricsResponse).not.toHaveBeenCalled();
  });

  it("returns 200 with prometheus content-type on success", async () => {
    const fakeMetrics = [
      "# HELP http_requests_total Total number of HTTP requests",
      "# TYPE http_requests_total counter",
      "http_requests_total 42",
      "",
      "# HELP process_memory_bytes Node.js process memory usage",
      "# TYPE process_memory_bytes gauge",
      "process_memory_bytes{memory_type=\"heap_used\"} 1048576",
    ].join("\n");

    mockGenerateMetricsResponse.mockResolvedValue(fakeMetrics);

    const response = await GET(makeMetricsRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const text = await response.text();
    expect(text).toContain("# HELP http_requests_total");
    expect(text).toContain("http_requests_total 42");
    expect(text).toContain("process_memory_bytes");
  });

  it("returns valid prometheus exposition format with comments and types", async () => {
    const metricsBlock = [
      "# HELP http_request_duration_seconds Duration of HTTP requests in seconds",
      "# TYPE http_request_duration_seconds histogram",
      "http_request_duration_seconds_bucket{le=\"0.005\"} 0",
      "http_request_duration_seconds_bucket{le=\"+Inf\"} 10",
      "http_request_duration_seconds_count 10",
      "http_request_duration_seconds_sum 3.5",
    ].join("\n");

    mockGenerateMetricsResponse.mockResolvedValue(metricsBlock);

    const response = await GET(makeMetricsRequest());
    const text = await response.text();

    // Every line should be valid Prometheus exposition format:
    // - Lines starting with # are comments/type/help
    // - Metric lines match `metric_name{...} value`
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const isValid =
        line.startsWith("#") ||
        /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})?\s+/.test(line);
      expect(isValid, `Invalid prometheus line: ${line}`).toBe(true);
    }
  });

  it("returns 500 when metrics generation fails", async () => {
    mockGenerateMetricsResponse.mockRejectedValue(new Error("Registry error"));

    const response = await GET(makeMetricsRequest());

    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body).toHaveProperty("error", "Failed to generate metrics");
  });

  it("returns 500 with generic message when non-error is thrown", async () => {
    mockGenerateMetricsResponse.mockRejectedValue("string error");

    const response = await GET(makeMetricsRequest());

    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body).toHaveProperty("error", "Failed to generate metrics");
  });

  it("includes process_memory_bytes metrics in the output", async () => {
    const metricsWithMemory = [
      "# HELP process_memory_bytes Node.js process memory usage in bytes",
      "# TYPE process_memory_bytes gauge",
      'process_memory_bytes{memory_type="rss"} 12345678',
      'process_memory_bytes{memory_type="heap_total"} 9876543',
      'process_memory_bytes{memory_type="heap_used"} 5432109',
      'process_memory_bytes{memory_type="external"} 123456',
    ].join("\n");

    mockGenerateMetricsResponse.mockResolvedValue(metricsWithMemory);

    const response = await GET(makeMetricsRequest());
    const text = await response.text();

    expect(text).toContain('memory_type="rss"');
    expect(text).toContain('memory_type="heap_total"');
    expect(text).toContain('memory_type="heap_used"');
    expect(text).toContain('memory_type="external"');
  });

  it("handles empty metrics gracefully", async () => {
    mockGenerateMetricsResponse.mockResolvedValue("");

    const response = await GET(makeMetricsRequest());

    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe("");
  });
});
