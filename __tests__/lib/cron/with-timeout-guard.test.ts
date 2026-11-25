import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb, type FakeDb } from "../../helpers/fake-db";

let fakeDb: FakeDb | null = null;
vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/auth/cron", () => ({
  requireCronAuth: vi.fn((request: Request, jobName: string) => {
    if (request.headers.get("authorization") === "Bearer invalid") {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
      });
    }
    return null;
  }),
  getCronTimeoutConfig: vi.fn(() => ({ timeoutMs: 1000, safetyBufferMs: 200 })),
}));

import { withCronTimeoutGuard } from "@/lib/cron/with-timeout-guard";

describe("withCronTimeoutGuard", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
  });

  it("executes handler successfully when authorized", async () => {
    fakeDb!.queue([{ id: "log-1" }]); // start insert
    fakeDb!.queue([{ startedAt: new Date() }]); // complete select
    fakeDb!.queue([]); // complete update

    const handler = vi.fn(async (ctx) => {
      expect(ctx.jobName).toBe("test-job");
      expect(ctx.signal).toBeDefined();
      return { processed: 5, succeeded: 5, failed: 0 };
    });

    const route = withCronTimeoutGuard("test-job", handler);
    const req = new NextRequest("http://localhost/api/cron/test", {
      method: "POST",
      headers: { authorization: "Bearer valid" },
    });

    const res = await route(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(5);
    expect(body.duration).toBeGreaterThanOrEqual(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("blocks unauthorized requests with 401", async () => {
    const handler = vi.fn();
    const route = withCronTimeoutGuard("test-job", handler);
    const req = new NextRequest("http://localhost/api/cron/test", {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });

    const res = await route(req);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("handles handler returning aborted status and preserves partial progress", async () => {
    fakeDb!.queue([{ id: "log-1" }]); // start
    fakeDb!.queue([{ startedAt: new Date() }]); // abort select
    fakeDb!.queue([]); // abort update
    fakeDb!.queue([]); // alert insert

    const handler = vi.fn(async () => {
      return {
        processed: 3,
        succeeded: 2,
        failed: 1,
        aborted: true,
        abortReason: "Execution deadline budget reached",
      };
    });

    const route = withCronTimeoutGuard("test-job", handler);
    const req = new NextRequest("http://localhost/api/cron/test", {
      method: "POST",
      headers: { authorization: "Bearer valid" },
    });

    const res = await route(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.aborted).toBe(true);
    expect(body.partial).toBe(true);
    expect(body.processed).toBe(3);
    expect(body.succeeded).toBe(2);
    expect(body.abortReason).toContain("Execution deadline budget reached");
  });

  it("records error and 500 when handler throws an unexpected exception", async () => {
    fakeDb!.queue([{ id: "log-1" }]); // start
    fakeDb!.queue([{ startedAt: new Date() }]); // fail select
    fakeDb!.queue([]); // fail update
    fakeDb!.queue([]); // alert insert

    const handler = vi.fn(async () => {
      throw new Error("Database connection dropped");
    });

    const route = withCronTimeoutGuard("test-job", handler);
    const req = new NextRequest("http://localhost/api/cron/test", {
      method: "POST",
      headers: { authorization: "Bearer valid" },
    });

    const res = await route(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Database connection dropped");
  });
});
