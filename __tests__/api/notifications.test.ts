import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createFakeDb } from "../helpers/fake-db";

const mockGetSessionUser = vi.fn();
const mockGetDb = vi.fn();
const mockEnforceRouteRateLimit = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => mockGetDb(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: (...args: unknown[]) => mockEnforceRouteRateLimit(...args),
}));

import { GET } from "@/app/api/notifications/route";
import { POST as clearNotifications } from "@/app/api/notifications/clear/route";

describe("GET /api/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRouteRateLimit.mockResolvedValue(null);
    mockGetSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it("enforces rate limiting and returns 429 when exceeded", async () => {
    mockEnforceRouteRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    );

    const response = await GET(new NextRequest("http://localhost/api/notifications"));
    expect(response.status).toBe(429);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("returns 401 when user is not authenticated", async () => {
    mockGetDb.mockReturnValue(createFakeDb());
    mockGetSessionUser.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost/api/notifications"));
    expect(response.status).toBe(401);
  });

  it("defaults pagination limit to 20 when no limit parameter is supplied", async () => {
    const db = createFakeDb();
    db.queue([
      {
        id: "notif-1",
        userId: "user-1",
        title: "Loan Funded",
        message: "Your loan was funded.",
        type: "info",
        read: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    mockGetDb.mockReturnValue(db);

    const response = await GET(new NextRequest("http://localhost/api/notifications"));
    expect(response.status).toBe(200);

    const limitCall = db.calls.find((call) => call.method === "limit");
    expect(limitCall?.args).toEqual([20]);

    const body = await response.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.pagination).toEqual({ limit: 20, offset: 0 });
  });

  it("clamps oversized limit parameters to the maximum of 50", async () => {
    const db = createFakeDb();
    db.queue([]);
    mockGetDb.mockReturnValue(db);

    const response = await GET(
      new NextRequest("http://localhost/api/notifications?limit=5000&offset=10"),
    );
    expect(response.status).toBe(200);

    const limitCall = db.calls.find((call) => call.method === "limit");
    const offsetCall = db.calls.find((call) => call.method === "offset");
    expect(limitCall?.args).toEqual([50]);
    expect(offsetCall?.args).toEqual([10]);

    const body = await response.json();
    expect(body.pagination).toEqual({ limit: 50, offset: 10 });
  });

  it("clamps non-positive limit parameters to 1 and negative offsets to 0", async () => {
    const db = createFakeDb();
    db.queue([]);
    mockGetDb.mockReturnValue(db);

    const response = await GET(
      new NextRequest("http://localhost/api/notifications?limit=0&offset=-15"),
    );
    expect(response.status).toBe(200);

    const limitCall = db.calls.find((call) => call.method === "limit");
    expect(limitCall?.args).toEqual([1]);

    const body = await response.json();
    expect(body.pagination).toEqual({ limit: 1, offset: 0 });
  });
});

describe("POST /api/notifications/clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRouteRateLimit.mockResolvedValue(null);
    mockGetSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it("enforces rate limiting on notification clear endpoint", async () => {
    mockEnforceRouteRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    );

    const response = await clearNotifications(
      new NextRequest("http://localhost/api/notifications/clear", { method: "POST" }),
    );
    expect(response.status).toBe(429);
  });
});
