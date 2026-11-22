import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb, type FakeDb } from "../helpers/fake-db";

let db: FakeDb | null = null;
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

vi.mock("@/lib/auth/cron", () => ({
  requireCronAuth: vi.fn(() => null),
  getCronTimeoutConfig: vi.fn(() => ({ timeoutMs: 5000, safetyBufferMs: 1000 })),
}));

// Mock individual underlying operations
vi.mock("@/lib/scheduler/payment-due", () => ({
  runPaymentDueScheduler: vi.fn().mockResolvedValue({
    processed: 10,
    succeeded: 10,
    failed: 0,
    errors: [],
  }),
}));

vi.mock("@/lib/scheduler/default-management", () => ({
  runDefaultManagement: vi.fn().mockResolvedValue({
    ledgerTime: "2026-11-22T00:00:00.000Z",
    scanned: 5,
    defaulted: 2,
    payoutsProposed: 1,
    failed: 0,
    outcomes: [],
  }),
}));

vi.mock("@/scripts/liquidation-keeper", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  runLiquidationKeeper: vi.fn().mockResolvedValue({
    scanned: 8,
    liquidated: 2,
    healthy: 6,
    skipped: 0,
    failed: 0,
  }),
}));

vi.mock("@/lib/stellar/server-contract", () => ({
  getAdminKeypair: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/oracle/sources", () => ({
  createDefaultSources: vi.fn().mockReturnValue([{ name: "test-source" }]),
}));

vi.mock("@/scripts/price-oracle-keeper", () => ({
  loadOracleConfig: vi.fn().mockReturnValue({}),
  createDefaultSources: vi.fn().mockReturnValue([]),
  createInitialState: vi.fn().mockReturnValue({}),
  createDryRunPublisher: vi.fn().mockReturnValue({}),
  runOracleCycle: vi.fn().mockResolvedValue({
    polled: 4,
    published: 2,
    skipped: 0,
    unavailable: 0,
    failed: 0,
    results: [],
  }),
}));

vi.mock("@/lib/reputation/daily-sync", () => ({
  runDailyReputationRecalculation: vi.fn().mockResolvedValue({
    scanned: 15,
    updated: 15,
    tierUpgrades: 2,
    errors: 0,
    details: [],
  }),
}));

import { POST as paymentDueRoute } from "@/app/api/cron/payment-due/route";
import { POST as defaultMgmtRoute } from "@/app/api/cron/default-management/route";
import { POST as liquidationRoute } from "@/app/api/cron/liquidation/route";
import { POST as priceOracleRoute } from "@/app/api/cron/price-oracle/route";
import { POST as reputationRoute } from "@/app/api/cron/reputation-scoring/route";

describe("Scheduled Cron API Routes with Dead-Man Switches", () => {
  beforeEach(() => {
    db = createFakeDb();
  });

  it("POST /api/cron/payment-due executes guarded run and returns 200", async () => {
    db!.queue([{ id: "log-1" }]); // start log
    db!.queue([{ startedAt: new Date() }]); // complete select
    db!.queue([]); // complete update

    const req = new NextRequest("http://localhost/api/cron/payment-due", { method: "POST" });
    const res = await paymentDueRoute(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(10);
    expect(body.duration).toBeGreaterThanOrEqual(0);
  });

  it("POST /api/cron/default-management executes guarded run and returns 200", async () => {
    db!.queue([{ id: "log-2" }]);
    db!.queue([{ startedAt: new Date() }]);
    db!.queue([]);

    const req = new NextRequest("http://localhost/api/cron/default-management", { method: "POST" });
    const res = await defaultMgmtRoute(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.defaulted).toBe(2);
  });

  it("POST /api/cron/liquidation executes guarded run and returns 200", async () => {
    db!.queue([{ id: "log-3" }]);
    db!.queue([{ startedAt: new Date() }]);
    db!.queue([]);

    const req = new NextRequest("http://localhost/api/cron/liquidation", { method: "POST" });
    const res = await liquidationRoute(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.liquidated).toBe(2);
  });

  it("POST /api/cron/price-oracle executes guarded run and returns 200", async () => {
    db!.queue([{ id: "log-4" }]);
    db!.queue([{ startedAt: new Date() }]);
    db!.queue([]);

    const req = new NextRequest("http://localhost/api/cron/price-oracle", { method: "POST" });
    const res = await priceOracleRoute(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.published).toBe(2);
  });

  it("POST /api/cron/reputation-scoring executes guarded run and returns 200", async () => {
    db!.queue([{ id: "log-5" }]);
    db!.queue([{ startedAt: new Date() }]);
    db!.queue([]);

    const req = new NextRequest("http://localhost/api/cron/reputation-scoring", { method: "POST" });
    const res = await reputationRoute(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(15);
  });
});
