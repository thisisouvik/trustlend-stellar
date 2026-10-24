import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeDb as createRawFakeDb } from "../helpers/fake-db";
import type { Db } from "@/lib/db/client";

/** The fake only implements the query-builder surface the helpers use. */
type TestDb = Db & ReturnType<typeof createRawFakeDb>;
const createFakeDb = () => createRawFakeDb() as unknown as TestDb;

const LENDER = "GBLENDER00000000000000000000000000000000000000000000000000";
const BORROWER = "GBBORROWER0000000000000000000000000000000000000000000000";
const CONTRACT = "CCLVI2JGD7PUV75VHOLTUZF3CVXYBUTOSLKNLHEUUFXOY73BFXUEVEMO";
const HASH = "4".repeat(64);

const mocks = vi.hoisted(() => ({
  required: vi.fn(() => true),
  verifyInvocation: vi.fn(),
  readLoan: vi.fn(),
  readCollateral: vi.fn(),
  readHealthFactor: vi.fn(),
  activate: vi.fn(),
  recordPayment: vi.fn(),
}));

vi.mock("@/lib/stellar/onchain-lifecycle", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/onchain-lifecycle")>("@/lib/stellar/onchain-lifecycle");
  return {
    ...actual,
    isOnchainLifecycleRequired: () => mocks.required(),
    lendingContractId: () => CONTRACT,
    verifyContractInvocation: (...args: unknown[]) => mocks.verifyInvocation(...args),
    readOnchainLoan: (...args: unknown[]) => mocks.readLoan(...args),
    readUserCollateralEntries: (...args: unknown[]) => mocks.readCollateral(...args),
    readBorrowerHealthFactor: (...args: unknown[]) => mocks.readHealthFactor(...args),
    activateLoanOnchain: (...args: unknown[]) => mocks.activate(...args),
    recordPaymentOnchain: (...args: unknown[]) => mocks.recordPayment(...args),
  };
});

import {
  activateFundedLoanOnchain,
  recordRepaymentOnchain,
  verifyLoanCollateralForFunding,
  verifyOnchainLoanRequest,
} from "@/lib/loans/onchain";

/** Collect every string inside a (possibly cyclic) drizzle `sql` object. */
function strings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((v) => strings(v, seen));
}
const metadataPatch = (db: ReturnType<typeof createFakeDb>) =>
  strings(db.calls.find((c) => c.method === "set")?.args).join(" | ");

const onchainLoan = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  borrower: BORROWER,
  lender: LENDER,
  amountStroops: 100_0000000n,
  durationDays: 30,
  interestRateBps: 1200,
  totalDueStroops: 101_0000000n,
  remainingDueStroops: 101_0000000n,
  status: "Approved",
  escrowId: 0,
  ...overrides,
});

describe("activateFundedLoanOnchain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.required.mockReturnValue(true);
    mocks.readCollateral.mockResolvedValue([{ asset: CONTRACT, amountStroops: 150_0000000n }]);
    mocks.readHealthFactor.mockResolvedValue(15000);
  });

  it("is a no-op when the lifecycle is off or the loan has no on-chain id", async () => {
    const db = createFakeDb();
    mocks.required.mockReturnValue(false);
    expect(await activateFundedLoanOnchain({ db, loanId: "l", loanMetadata: { onchain_loan_id: 5 }, lenderAddress: LENDER })).toEqual({
      attempted: false,
      reason: "lifecycle off",
    });
    mocks.required.mockReturnValue(true);
    expect(await activateFundedLoanOnchain({ db, loanId: "l", loanMetadata: {}, lenderAddress: LENDER })).toMatchObject({
      attempted: false,
    });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("verifies approve_loan, checks the on-chain lender, signs activate_loan and records both hashes", async () => {
    const db = createFakeDb();
    db.queue([]); // metadata merge
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: null });
    mocks.readLoan.mockResolvedValue(onchainLoan());
    mocks.activate.mockResolvedValue({ hash: HASH });

    const out = await activateFundedLoanOnchain({
      db,
      loanId: "l",
      loanMetadata: { onchain_loan_id: 5 },
      lenderAddress: LENDER,
      approveTxHash: "5".repeat(64),
    });
    expect(out).toEqual({ attempted: true, ok: true, txHash: HASH, status: "Active" });
    expect(mocks.verifyInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ method: "approve_loan", contractId: CONTRACT, expectedInvoker: LENDER }),
    );
    expect(mocks.activate).toHaveBeenCalledWith(5);
    expect(metadataPatch(db)).toContain(HASH);
  });

  it("fails soft (records the error) when the completing lender never signed approve_loan", async () => {
    const db = createFakeDb();
    db.queue([]);
    const out = await activateFundedLoanOnchain({ db, loanId: "l", loanMetadata: { onchain_loan_id: 5 }, lenderAddress: LENDER });
    expect(out).toMatchObject({ attempted: true, ok: false });
    if (out.attempted && !out.ok) expect(out.error).toMatch(/approveTxHash is required/);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(db.calls.some((c) => c.method === "update")).toBe(true);
  });

  it("refuses to activate when the on-chain loan was approved by someone else", async () => {
    const db = createFakeDb();
    db.queue([]);
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: null });
    mocks.readLoan.mockResolvedValue(onchainLoan({ lender: BORROWER }));
    const out = await activateFundedLoanOnchain({
      db,
      loanId: "l",
      loanMetadata: { onchain_loan_id: 5 },
      lenderAddress: LENDER,
      approveTxHash: "5".repeat(64),
    });
    expect(out).toMatchObject({ attempted: true, ok: false, error: expect.stringMatching(/different lender/) });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("treats an already-active on-chain loan as success (idempotent retry)", async () => {
    const db = createFakeDb();
    db.queue([]);
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: null });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Active" }));
    const out = await activateFundedLoanOnchain({
      db,
      loanId: "l",
      loanMetadata: { onchain_loan_id: 5 },
      lenderAddress: LENDER,
      approveTxHash: "5".repeat(64),
    });
    expect(out).toMatchObject({ attempted: true, ok: true, status: "Active" });
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});

describe("recordRepaymentOnchain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.required.mockReturnValue(true);
  });

  it("caps the recorded amount at the contract's remaining balance and appends the hash", async () => {
    const db = createFakeDb();
    db.queue([]);
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Active", remainingDueStroops: 30_0000000n }));
    mocks.recordPayment.mockResolvedValue({ hash: HASH, status: "Repaid" });

    const out = await recordRepaymentOnchain({
      db,
      loanId: "l",
      loanMetadata: { onchain_loan_id: 5, onchain_payment_txs: ["x"] },
      amountXlm: 50,
    });
    expect(out).toEqual({ attempted: true, ok: true, txHash: HASH, status: "Repaid" });
    expect(mocks.recordPayment).toHaveBeenCalledWith(5, 30_0000000n);
    expect(metadataPatch(db)).toContain(`"onchain_payment_txs":["x","${HASH}"]`);
  });

  it("fails soft when the on-chain loan is not active", async () => {
    const db = createFakeDb();
    db.queue([]);
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending" }));
    const out = await recordRepaymentOnchain({ db, loanId: "l", loanMetadata: { onchain_loan_id: 5 }, amountXlm: 10 });
    expect(out).toMatchObject({ attempted: true, ok: false, error: expect.stringMatching(/Pending/) });
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });
});

describe("verifyOnchainLoanRequest", () => {
  const params = {
    onchainLoanId: 5,
    onchainTxHash: HASH,
    walletAddress: BORROWER,
    borrowerWallets: [BORROWER],
    amountXlm: 100,
    durationDays: 30,
    interestRateBps: 1200,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.required.mockReturnValue(true);
    mocks.readCollateral.mockResolvedValue([{ asset: CONTRACT, amountStroops: 150_0000000n }]);
    mocks.readHealthFactor.mockResolvedValue(15000);
  });

  it("passes through with empty metadata when the lifecycle is off", async () => {
    mocks.required.mockReturnValue(false);
    const out = await verifyOnchainLoanRequest({ db: createFakeDb(), ...params, onchainLoanId: undefined, onchainTxHash: undefined });
    expect(out).toEqual({ ok: true, metadata: {} });
  });

  it("requires the on-chain id and hash when the lifecycle is on", async () => {
    const out = await verifyOnchainLoanRequest({ db: createFakeDb(), ...params, onchainLoanId: undefined, onchainTxHash: undefined });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(mocks.verifyInvocation).not.toHaveBeenCalled();
  });

  it("rejects a wallet that is not linked to the account", async () => {
    const out = await verifyOnchainLoanRequest({ db: createFakeDb(), ...params, walletAddress: LENDER });
    expect(out).toMatchObject({ ok: false, status: 400 });
  });

  it("verifies the invocation, cross-checks the on-chain record and returns link metadata", async () => {
    const db = createFakeDb();
    db.queue([]); // duplicate check
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: 5 });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending" }));

    const out = await verifyOnchainLoanRequest({ db, ...params });
    expect(out).toEqual({
      ok: true,
      metadata: { onchain_loan_id: 5, onchain_request_tx: HASH, onchain_status: "Pending" },
    });
    expect(mocks.verifyInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ method: "create_loan_request", expectedInvoker: BORROWER, txHash: HASH }),
    );
  });

  it("rejects when the returned id, borrower, amount, duration or status do not match", async () => {
    const db = () => {
      const d = createFakeDb();
      d.queue([]);
      return d;
    };
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: 6 });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending" }));
    expect(await verifyOnchainLoanRequest({ db: db(), ...params })).toMatchObject({ ok: false, status: 422 });

    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: 5 });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending", borrower: LENDER }));
    expect(await verifyOnchainLoanRequest({ db: db(), ...params })).toMatchObject({ ok: false, status: 422 });

    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending", amountStroops: 99_0000000n }));
    expect(await verifyOnchainLoanRequest({ db: db(), ...params })).toMatchObject({ ok: false, status: 422 });

    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending", durationDays: 60 }));
    expect(await verifyOnchainLoanRequest({ db: db(), ...params })).toMatchObject({ ok: false, status: 422 });

    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Active" }));
    expect(await verifyOnchainLoanRequest({ db: db(), ...params })).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects an on-chain loan that is already linked to another row", async () => {
    const db = createFakeDb();
    db.queue([{ id: "other-loan" }]);
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: 5 });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending" }));
    expect(await verifyOnchainLoanRequest({ db, ...params })).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects an on-chain loan with an interest rate different from the quoted APR", async () => {
    const db = createFakeDb();
    db.queue([]);
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: 5 });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending", interestRateBps: 0 }));

    const out = await verifyOnchainLoanRequest({ db, ...params });

    expect(out).toMatchObject({ ok: false, status: 422, reason: expect.stringContaining("quoted APR") });
    expect(db.calls.some((call) => call.method === "select")).toBe(false);
  });

  it("rejects loan request when on-chain collateral vault balance is insufficient", async () => {
    const db = createFakeDb();
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: 5 });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending" }));
    mocks.readCollateral.mockResolvedValue([{ asset: CONTRACT, amountStroops: 20_0000000n }]);

    const out = await verifyOnchainLoanRequest({ db, ...params });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      reason: expect.stringContaining("Insufficient on-chain collateral"),
    });
  });

  it("rejects loan request when borrower health factor is below 10000 bps", async () => {
    const db = createFakeDb();
    mocks.verifyInvocation.mockResolvedValue({ ok: true, returnValue: 5 });
    mocks.readLoan.mockResolvedValue(onchainLoan({ status: "Pending" }));
    mocks.readHealthFactor.mockResolvedValue(8500);

    const out = await verifyOnchainLoanRequest({ db, ...params });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      reason: expect.stringContaining("health factor"),
    });
  });

  it("verifies collateral custody before funding on-chain loans", async () => {
    mocks.readCollateral.mockResolvedValue([]);
    const res = await verifyLoanCollateralForFunding({
      loanMetadata: { onchain_loan_id: 5 },
      borrowerWallet: BORROWER,
      principalAmountXlm: 100,
    });
    expect(res).toMatchObject({
      ok: false,
      status: 422,
      reason: expect.stringContaining("Insufficient on-chain collateral"),
    });
  });
});
