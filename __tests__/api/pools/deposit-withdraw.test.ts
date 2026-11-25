import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "../../helpers/fake-db";

const LENDER = "GBLENDER00000000000000000000000000000000000000000000000000";
const PLATFORM = "GBPLATFORM0000000000000000000000000000000000000000000000";
const HASH = "9".repeat(64);
const POOL_ID = "aaaa0000-0000-4000-8000-000000000001";
const POSITION_ID = "bbbb0000-0000-4000-8000-000000000002";

const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRouteRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/kyc/middleware", () => ({
  requireKycVerified: vi.fn().mockResolvedValue({ allowed: true, kycStatus: "verified" }),
}));

const mockVerify = vi.fn();
vi.mock("@/lib/stellar/verify-payment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/verify-payment")>("@/lib/stellar/verify-payment");
  return { ...actual, verifyPaymentTransaction: (...args: unknown[]) => mockVerify(...args) };
});

const mockSync = vi.fn();
vi.mock("@/lib/pools/onchain", () => ({ syncPoolOnchain: (...args: unknown[]) => mockSync(...args) }));

const mockPayout = vi.fn();
vi.mock("@/lib/stellar/platform-wallet", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/platform-wallet")>("@/lib/stellar/platform-wallet");
  return { ...actual, payoutFromPlatformWallet: (...args: unknown[]) => mockPayout(...args) };
});

const mockGetDb = vi.fn();
vi.mock("@/lib/db/client", () => ({ getDb: () => mockGetDb() }));

import { POST as deposit } from "@/app/api/pools/deposit/route";
import { POST as withdraw } from "@/app/api/pools/withdraw/route";
import { PlatformWalletError } from "@/lib/stellar/platform-wallet";

function request(path: string, body: Record<string, unknown>, idempotencyKey = "test-withdrawal-request-1") {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

describe("POST /api/pools/deposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS = PLATFORM;
    mockRequireAuthenticatedUser.mockResolvedValue({ user: { id: "lender-1", walletAddress: LENDER }, role: "lender" });
    mockSync.mockResolvedValue({ attempted: true, ok: true, txHash: "1".repeat(64), onchainPoolId: 0 });
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS;
  });

  it("verifies the payment to the platform wallet with the pool-bound memo before crediting", async () => {
    const db = createFakeDb();
    db.queue([]); // duplicate tx
    db.queue([{ id: POOL_ID }]); // pool
    db.queue([{ walletAddress: LENDER }]); // lender profile
    db.queue([]); // existing position
    db.queue([{ id: POSITION_ID }]); // insert position
    db.queue([]); // pool update
    db.queue([]); // ledger insert
    mockGetDb.mockReturnValue(db);
    mockVerify.mockResolvedValue({
      ok: true,
      txHash: HASH,
      source: LENDER,
      memo: "",
      ledger: 5,
      closedAt: new Date().toISOString(),
      received: { [PLATFORM]: 250 },
      totalNative: 250,
    });

    const res = await deposit(request("/api/pools/deposit", { poolId: POOL_ID, amount: 250, txHash: HASH, lenderAddress: LENDER }));
    expect(res.status).toBe(201);
    expect((await res.json()).onchain).toMatchObject({ attempted: true, ok: true });
    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSource: LENDER,
        expectedMemo: `TL-DEPOSIT:${POOL_ID.slice(0, 12)}`,
        expectedPayments: [{ destination: PLATFORM, minAmount: 250 }],
      }),
    );
    expect(mockSync).toHaveBeenCalledWith(db, POOL_ID);
  });

  it("does not create a position when verification fails", async () => {
    const db = createFakeDb();
    db.queue([]);
    db.queue([{ id: POOL_ID }]);
    db.queue([{ walletAddress: LENDER }]);
    mockGetDb.mockReturnValue(db);
    mockVerify.mockResolvedValue({ ok: false, status: 422, reason: "Transaction paid 0 XLM" });

    const res = await deposit(request("/api/pools/deposit", { poolId: POOL_ID, amount: 250, txHash: HASH, lenderAddress: LENDER }));
    expect(res.status).toBe(422);
    expect(db.calls.some((c) => c.method === "insert" || c.method === "update")).toBe(false);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("refuses deposits when no platform wallet is configured", async () => {
    delete process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS;
    const db = createFakeDb();
    db.queue([]);
    db.queue([{ id: POOL_ID }]);
    mockGetDb.mockReturnValue(db);

    const res = await deposit(request("/api/pools/deposit", { poolId: POOL_ID, amount: 250, txHash: HASH, lenderAddress: LENDER }));
    expect(res.status).toBe(503);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe("POST /api/pools/withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthenticatedUser.mockResolvedValue({ user: { id: "lender-1", walletAddress: LENDER }, role: "lender" });
    mockSync.mockResolvedValue({ attempted: false, reason: "lifecycle off" });
  });

  function queueWithdrawReads(db: ReturnType<typeof createFakeDb>) {
    db.queue([{ id: POSITION_ID, poolId: POOL_ID, principalAmount: "100", withdrawnAmount: "0" }]); // position
    db.queue([{ availableLiquidity: "500" }]); // pool
    db.queue([{ walletAddress: LENDER }]); // lender profile
  }

  it("reserves the position and pool before paying, then records the hash", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([{ id: "reservation-1" }]); // idempotency reservation
    db.queue([{ id: POSITION_ID }]); // atomic position reservation
    db.queue([{ id: POOL_ID }]); // atomic liquidity reservation
    db.queue([]); // mark ledger confirmed
    mockGetDb.mockReturnValue(db);
    mockPayout.mockResolvedValue({ hash: HASH, source: PLATFORM });

    const res = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.txHash).toBe(HASH);
    expect(mockPayout).toHaveBeenCalledWith(
      expect.objectContaining({ destination: LENDER, amountXlm: 40, memo: `TL-WDR:${POSITION_ID.slice(0, 12)}` }),
    );
    expect(db.calls.some((c) => c.method === "set" && (c.args[0] as { metadata?: { txHash?: string } })?.metadata?.txHash === HASH)).toBe(true);
    expect(db.calls.filter((c) => c.method === "update").length).toBe(3);
    expect(mockSync).toHaveBeenCalledWith(db, POOL_ID);
  });

  it("rolls back the reservation when the server cannot sign the payout", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([{ id: "reservation-1" }]);
    db.queue([{ id: POSITION_ID }]);
    db.queue([{ id: POOL_ID }]);
    db.queue([]); // restore position
    db.queue([]); // restore pool
    db.queue([]); // mark failed
    mockGetDb.mockReturnValue(db);
    mockPayout.mockRejectedValue(new PlatformWalletError("PLATFORM_WALLET_SECRET is not configured"));

    const res = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/PLATFORM_WALLET_SECRET/);
    expect(db.calls.filter((c) => c.method === "update").length).toBe(5);
  });

  it("returns 502 when the Stellar submission itself fails", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([{ id: "reservation-1" }]);
    db.queue([{ id: POSITION_ID }]);
    db.queue([{ id: POOL_ID }]);
    db.queue([]);
    db.queue([]);
    db.queue([]);
    mockGetDb.mockReturnValue(db);
    mockPayout.mockRejectedValue(new Error("tx_bad_seq"));

    const res = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    expect(res.status).toBe(502);
    expect(db.calls.filter((c) => c.method === "update").length).toBe(5);
  });

  it("deduplicates concurrent retries with the same idempotency key", async () => {
    const firstDb = createFakeDb();
    queueWithdrawReads(firstDb);
    firstDb.queue([{ id: "reservation-1" }]);
    firstDb.queue([{ id: POSITION_ID }]);
    firstDb.queue([{ id: POOL_ID }]);
    firstDb.queue([]);
    const duplicateDb = createFakeDb();
    queueWithdrawReads(duplicateDb);
    duplicateDb.queue([]); // unique index rejects duplicate key
    mockGetDb.mockReturnValueOnce(firstDb).mockReturnValueOnce(duplicateDb);
    let releasePayout!: (value: { hash: string; source: string }) => void;
    let signalPayoutStarted!: () => void;
    const payoutStarted = new Promise<void>((resolve) => { signalPayoutStarted = resolve; });
    mockPayout.mockImplementation(() => {
      signalPayoutStarted();
      return new Promise((resolve) => { releasePayout = resolve; });
    });

    const firstPromise = withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    await payoutStarted;
    const duplicate = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    releasePayout({ hash: HASH, source: PLATFORM });
    const first = await firstPromise;

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
    expect(mockPayout).toHaveBeenCalledTimes(1);
  });

  it("does not pay when an atomic position reservation loses a concurrent race", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([{ id: "reservation-2" }]);
    db.queue([]); // conditional position update lost the race
    db.queue([]); // idempotency reservation marked failed
    mockGetDb.mockReturnValue(db);

    const response = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 100 }));

    expect(response.status).toBe(409);
    expect(mockPayout).not.toHaveBeenCalled();
  });
});
