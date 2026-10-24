import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "../../helpers/fake-db";

const BORROWER = "GBBORROWER0000000000000000000000000000000000000000000000";
const LENDER_A = "GBLENDERA000000000000000000000000000000000000000000000000";
const LENDER_B = "GBLENDERB000000000000000000000000000000000000000000000000";
const PLATFORM = "GBPLATFORM0000000000000000000000000000000000000000000000";
const HASH = "f".repeat(64);
const LOAN_ID = "1c2d3e4f-0000-4000-8000-000000000001";

const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRouteRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn().mockResolvedValue({ id: "n" }) }));

const mockLenders = vi.fn();
vi.mock("@/lib/loans/lenders", () => ({ getLoanLenders: (...args: unknown[]) => mockLenders(...args) }));

const mockVerify = vi.fn();
vi.mock("@/lib/stellar/verify-payment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/verify-payment")>("@/lib/stellar/verify-payment");
  return { ...actual, verifyPaymentTransaction: (...args: unknown[]) => mockVerify(...args) };
});

const mockRecord = vi.fn();
vi.mock("@/lib/loans/onchain", () => ({ recordRepaymentOnchain: (...args: unknown[]) => mockRecord(...args) }));

const mockGetDb = vi.fn();
vi.mock("@/lib/db/client", () => ({ getDb: () => mockGetDb() }));

import { POST } from "@/app/api/loans/repay/route";

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/loans/repay", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const loanRow = {
  id: LOAN_ID,
  status: "active",
  repaidAmount: "0",
  principalAmount: "100",
  aprBps: 1200,
  durationDays: 30,
  metadata: { onchain_loan_id: 9 },
  borrowerWallet: BORROWER,
};

const lenders = [
  { lenderId: "lender-a", address: LENDER_A, contribution: 60 },
  { lenderId: "lender-b", address: LENDER_B, contribution: 40 },
];

describe("POST /api/loans/repay — payment verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PLATFORM_FEE_WALLET = PLATFORM;
    mockRequireAuthenticatedUser.mockResolvedValue({ user: { id: "borrower-1", walletAddress: BORROWER }, role: "borrower" });
    mockLenders.mockResolvedValue(lenders);
    mockRecord.mockResolvedValue({ attempted: true, ok: true, txHash: "a".repeat(64), status: "Active" });
  });
  afterEach(() => {
    delete process.env.PLATFORM_FEE_WALLET;
  });

  it("rejects an unverifiable payment before any repayment row is written", async () => {
    const db = createFakeDb();
    db.queue([loanRow]); // loan
    db.queue([]); // duplicate txHash check
    mockGetDb.mockReturnValue(db);
    mockVerify.mockResolvedValue({ ok: false, status: 404, reason: "Transaction not found on the Stellar network" });

    const res = await POST(request({ loanId: LOAN_ID, amount: 50, txHash: HASH, borrowerAddress: BORROWER }));
    expect(res.status).toBe(404);
    expect(db.calls.some((c) => c.method === "insert")).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("rejects when the transaction moved less than the claimed amount", async () => {
    const db = createFakeDb();
    db.queue([loanRow]);
    db.queue([]);
    mockGetDb.mockReturnValue(db);
    mockVerify.mockResolvedValue({
      ok: true,
      txHash: HASH,
      source: BORROWER,
      memo: "",
      ledger: 1,
      closedAt: new Date().toISOString(),
      received: { [LENDER_A]: 20, [LENDER_B]: 9 },
      totalNative: 29,
    });

    const res = await POST(request({ loanId: LOAN_ID, amount: 50, txHash: HASH, borrowerAddress: BORROWER }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/29.0000000 XLM/);
    expect(db.calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("rejects a borrowerAddress that is not linked to the account", async () => {
    const db = createFakeDb();
    db.queue([loanRow]);
    db.queue([]);
    mockGetDb.mockReturnValue(db);

    const res = await POST(request({ loanId: LOAN_ID, amount: 50, txHash: HASH, borrowerAddress: LENDER_A }));
    expect(res.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("verifies the borrower's payment to every lender plus the platform wallet, records it and mirrors on-chain", async () => {
    const db = createFakeDb();
    db.queue([loanRow]); // loan
    db.queue([]); // duplicate check
    db.queue([{ id: "rep-1" }]); // repayment insert
    db.queue([]); // loans update
    db.queue([]); // ledger insert
    db.queue([]); // reputation event insert
    mockGetDb.mockReturnValue(db);
    mockVerify.mockResolvedValue({
      ok: true,
      txHash: HASH,
      source: BORROWER,
      memo: `TL-RPY:${LOAN_ID.slice(0, 12)}`,
      ledger: 77,
      closedAt: new Date().toISOString(),
      received: { [LENDER_A]: 29.7, [LENDER_B]: 19.8, [PLATFORM]: 0.5 },
      totalNative: 50,
    });

    const res = await POST(request({ loanId: LOAN_ID, amount: 50, txHash: HASH, borrowerAddress: BORROWER }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.loanStatus).toBe("active");
    expect(json.onchain).toMatchObject({ attempted: true, ok: true });

    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSource: BORROWER,
        expectedMemo: `TL-RPY:${LOAN_ID.slice(0, 12)}`,
        expectedPayments: [LENDER_A, LENDER_B, PLATFORM].map((destination) => ({ destination, minAmount: 0 })),
      }),
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ loanId: LOAN_ID, amountXlm: 50, loanMetadata: { onchain_loan_id: 9 } }),
    );
  });

  it("refuses when no lender wallet is known for the loan", async () => {
    const db = createFakeDb();
    db.queue([loanRow]);
    db.queue([]);
    mockGetDb.mockReturnValue(db);
    mockLenders.mockResolvedValue([]);
    delete process.env.PLATFORM_FEE_WALLET;

    const res = await POST(request({ loanId: LOAN_ID, amount: 50, txHash: HASH, borrowerAddress: BORROWER }));
    expect(res.status).toBe(409);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("executes inside db.transaction with FOR UPDATE row-level lock and rejects duplicate Idempotency-Key", async () => {
    const db = createFakeDb() as ReturnType<typeof createFakeDb> & {
      transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    const transactionSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
    db.transaction = transactionSpy;

    const origSelect = db.select.bind(db);
    const forSpy = vi.fn();
    db.select = (...args: unknown[]) => {
      const chain = origSelect(...args);
      chain.for = (mode: string) => {
        forSpy(mode);
        return chain;
      };
      return chain;
    };

    db.queue([loanRow]); // loan lookup with FOR UPDATE
    db.queue([{ id: "existing-ledger-tx" }]); // duplicate idempotency key found
    mockGetDb.mockReturnValue(db);

    const res = await POST(
      request(
        { loanId: LOAN_ID, amount: 50, txHash: HASH, borrowerAddress: BORROWER },
        { "Idempotency-Key": "repay-idem-key-1" },
      ),
    );

    expect(res.status).toBe(409);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(forSpy).toHaveBeenCalledWith("update");
    expect(mockVerify).not.toHaveBeenCalled();
    expect(db.calls.some((c) => c.method === "insert")).toBe(false);
  });
});
