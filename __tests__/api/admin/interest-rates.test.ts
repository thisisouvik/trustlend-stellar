import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock Auth ─────────────────────────────────────────────────────────────────
const { mockRequireApiAdmin, MockUnauthorizedError } = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  return {
    mockRequireApiAdmin: vi.fn(),
    MockUnauthorizedError,
  };
});

vi.mock("@/lib/auth/session", () => ({
  requireApiAdmin: () => mockRequireApiAdmin(),
  UnauthorizedError: MockUnauthorizedError,
}));

// ── Mock Rate Limiter ─────────────────────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: vi.fn().mockResolvedValue(null),
}));

// ── Mock database ─────────────────────────────────────────────────────────────
const mockGetDb = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getDb: () => mockGetDb(),
}));

import { GET, POST } from "@/app/api/admin/interest-rates/route";
import { interestRateConfigs } from "@/lib/db/schema";
import { createFakeDb } from "../../helpers/fake-db";

function makeRequest(body?: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/interest-rates", {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const validBody = {
  rateModel: "fixed",
  baseAprBps: 1400,
  minAprBps: 100,
  maxAprBps: 5000,
  amountTiers: [{ minAmount: 1000, aprBps: 1100 }],
  reputationTiers: [{ minScore: 500, multiplierBps: 9500 }],
  notes: "Lowered rates to track market funding costs",
};

describe("GET /api/admin/interest-rates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiAdmin.mockResolvedValue({
      id: "admin-1",
      email: "admin@trustlend.org",
    });
  });

  it("returns the active schedules and the bounds the UI validates against", async () => {
    const db = createFakeDb();
    db.queue([]); // fixed: no row
    db.queue([]); // floating: no row
    db.queue([]); // history
    mockGetDb.mockReturnValue(db);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.active.fixed).toBeDefined();
    expect(json.data.active.floating).toBeDefined();
    expect(json.bounds.MAX_APR_BPS).toBe(10000);
    expect(json.usingFallbackDefaults).toBe(true);
  });

  it("reports usingFallbackDefaults: false once both models are published", async () => {
    const row = (rateModel: string) => ({
      rateModel,
      version: 1,
      baseAprBps: 1200,
      minAprBps: 100,
      maxAprBps: 5000,
      amountTiers: [],
      reputationTiers: [],
      notes: "seed",
      updatedByEmail: "admin@trustlend.org",
      updatedAt: null,
    });

    const db = createFakeDb();
    db.queue([row("fixed")]);
    db.queue([row("floating")]);
    db.queue([row("fixed"), row("floating")]);
    mockGetDb.mockReturnValue(db);

    const json = await (await GET(makeRequest())).json();
    expect(json.usingFallbackDefaults).toBe(false);
    expect(json.data.history).toHaveLength(2);
  });

  it("rejects a non-admin caller with 403", async () => {
    mockRequireApiAdmin.mockRejectedValue(new MockUnauthorizedError("Admin access required."));
    mockGetDb.mockReturnValue(createFakeDb());

    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Admin access required");
  });
});

describe("POST /api/admin/interest-rates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiAdmin.mockResolvedValue({
      id: "admin-1",
      email: "admin@trustlend.org",
    });
  });

  /** Queues the writes/reads a successful publish makes, in order. */
  function queuePublish(db: ReturnType<typeof createFakeDb>, maxVersion = 2) {
    db.queue([{ maxVersion }]); // max version lookup
    db.queue([]); // deactivate previous active row
    db.queue([{ id: "cfg-1", version: maxVersion + 1 }]); // insert .returning()
    db.queue([]); // re-read active: fixed
    db.queue([]); // re-read active: floating
    db.queue([]); // history
    return db;
  }

  it("publishes the next version and reports that existing loans are unaffected", async () => {
    const db = queuePublish(createFakeDb(), 2);
    mockGetDb.mockReturnValue(db);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.published.version).toBe(3);
    expect(json.message).toContain("v3");
    expect(json.message).toContain("Existing loans keep their locked APR");
  });

  it("deactivates the previous schedule before inserting the new one", async () => {
    const db = queuePublish(createFakeDb(), 1);
    mockGetDb.mockReturnValue(db);

    await POST(makeRequest(validBody));

    const methods = db.calls.map((c) => c.method);
    expect(methods.indexOf("update")).toBeGreaterThan(-1);
    expect(methods.indexOf("insert")).toBeGreaterThan(methods.indexOf("update"));
  });

  it("starts at version 1 when nothing has been published for the model", async () => {
    const db = queuePublish(createFakeDb(), 0);
    mockGetDb.mockReturnValue(db);

    const json = await (await POST(makeRequest(validBody))).json();
    expect(json.published.version).toBe(1);
  });

  it("writes only to interest_rate_configs, so pending loans are not repriced", async () => {
    const db = queuePublish(createFakeDb(), 1);
    mockGetDb.mockReturnValue(db);

    await POST(makeRequest(validBody));

    // Publishing is exactly one deactivate plus one insert, both against the
    // config table, and never a write to any loan row.
    const writes = db.calls.filter((c) => ["insert", "update", "delete"].includes(c.method));
    expect(writes.map((c) => c.method)).toEqual(["update", "insert"]);

    for (const write of writes) {
      expect(write.args[0]).toBe(interestRateConfigs);
    }
  });

  it("rejects an unsupported rate model", async () => {
    mockGetDb.mockReturnValue(createFakeDb());
    const res = await POST(makeRequest({ ...validBody, rateModel: "variable" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("rateModel must be");
  });

  it("requires a rationale for the audit trail", async () => {
    mockGetDb.mockReturnValue(createFakeDb());
    const res = await POST(makeRequest({ ...validBody, notes: "hm" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("rationale");
  });

  it("rejects a schedule that violates the safety bounds", async () => {
    mockGetDb.mockReturnValue(createFakeDb());
    const res = await POST(makeRequest({ ...validBody, baseAprBps: 99999 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("baseAprBps");
  });

  it("rejects a malformed tier instead of silently dropping it", async () => {
    mockGetDb.mockReturnValue(createFakeDb());
    const res = await POST(
      makeRequest({
        ...validBody,
        amountTiers: [{ minAmount: 1000, aprBps: 1100 }, { minAmount: "oops", aprBps: 900 }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("malformed");
  });

  it("rejects invalid JSON", async () => {
    mockGetDb.mockReturnValue(createFakeDb());
    const req = new NextRequest("http://localhost/api/admin/interest-rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 503 when the database is unavailable", async () => {
    mockGetDb.mockReturnValue(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(503);
  });

  it("rejects a non-admin caller with 403", async () => {
    mockRequireApiAdmin.mockRejectedValue(new MockUnauthorizedError("Admin access required."));
    mockGetDb.mockReturnValue(createFakeDb());

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(403);
  });
});
