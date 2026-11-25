import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { redirect } from "next/navigation";
import {
  Account,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, enforceRouteRateLimit: vi.fn().mockResolvedValue(null) };
});

import { POST } from "@/app/api/sponsor/route";
import { validateSponsorshipTransaction } from "@/lib/stellar/sponsorship";

const PASSPHRASE = Networks.TESTNET;
const LENDING_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const FOREIGN_ID = StrKey.encodeContract(Buffer.alloc(32, 9));

let borrower = Keypair.random();
const sponsor = Keypair.random();

function buildTx(
  opts: {
    signer?: Keypair;
    source?: string;
    contractId?: string;
    ops?: number;
    fee?: string;
    sign?: boolean;
  } = {}
) {
  const source = opts.source ?? borrower.publicKey();
  const builder = new TransactionBuilder(new Account(source, "1"), {
    fee: opts.fee ?? "100",
    networkPassphrase: PASSPHRASE,
  }).setTimeout(300);

  const count = opts.ops ?? 1;
  for (let i = 0; i < count; i += 1) {
    builder.addOperation(new Contract(opts.contractId ?? LENDING_ID).call("repay_loan"));
  }

  const tx = builder.build();
  if (opts.sign !== false) tx.sign(opts.signer ?? borrower);
  return tx;
}

const baseOptions = () => ({
  networkPassphrase: PASSPHRASE,
  walletAddress: borrower.publicKey(),
  allowedContractIds: new Set([LENDING_ID]),
  maxFeeStroops: 5_000_000n,
});

describe("validateSponsorshipTransaction", () => {
  it("accepts a signed TrustLend contract call from the borrower's wallet", () => {
    const result = validateSponsorshipTransaction(buildTx().toXDR(), baseOptions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contractId).toBe(LENDING_ID);
      expect(result.functionName).toBe("repay_loan");
    }
  });

  it("rejects malformed XDR", () => {
    const result = validateSponsorshipTransaction("not-xdr", baseOptions());
    expect(result).toMatchObject({ ok: false, code: "malformed_xdr" });
  });

  it("rejects calls to contracts outside the TrustLend allowlist", () => {
    const result = validateSponsorshipTransaction(buildTx({ contractId: FOREIGN_ID }).toXDR(), baseOptions());
    expect(result).toMatchObject({ ok: false, code: "contract_not_allowed" });
  });

  it("rejects non-contract operations such as payments", () => {
    const payment = new TransactionBuilder(new Account(borrower.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "10" }))
      .setTimeout(300)
      .build();
    payment.sign(borrower);
    const result = validateSponsorshipTransaction(payment.toXDR(), baseOptions());
    expect(result).toMatchObject({ ok: false, code: "unsupported_operation" });
  });

  it("rejects transactions sourced from another account", () => {
    const other = Keypair.random();
    const result = validateSponsorshipTransaction(
      buildTx({ source: other.publicKey(), signer: other }).toXDR(),
      baseOptions()
    );
    expect(result).toMatchObject({ ok: false, code: "source_mismatch" });
  });

  it("rejects unsigned transactions", () => {
    const result = validateSponsorshipTransaction(buildTx({ sign: false }).toXDR(), baseOptions());
    expect(result).toMatchObject({ ok: false, code: "unsigned" });
  });

  it("rejects transactions with more than one operation", () => {
    const result = validateSponsorshipTransaction(buildTx({ ops: 2 }).toXDR(), baseOptions());
    expect(result).toMatchObject({ ok: false, code: "invalid_operation_count" });
  });

  it("rejects transactions whose fee exceeds the sponsorship ceiling", () => {
    const result = validateSponsorshipTransaction(buildTx({ fee: "6000000" }).toXDR(), baseOptions());
    expect(result).toMatchObject({ ok: false, code: "fee_too_high" });
  });

  it("rejects transactions whose inclusion fee exceeds the sponsor base fee", () => {
    const result = validateSponsorshipTransaction(buildTx({ fee: "200000" }).toXDR(), baseOptions());
    expect(result).toMatchObject({ ok: false, code: "fee_too_high" });
  });

  it("rejects already fee-bumped transactions", () => {
    const bumped = TransactionBuilder.buildFeeBumpTransaction(sponsor, "100000", buildTx(), PASSPHRASE);
    bumped.sign(sponsor);
    const result = validateSponsorshipTransaction(bumped.toXDR(), baseOptions());
    expect(result).toMatchObject({ ok: false, code: "fee_bump_not_allowed" });
  });

  it("rejects everything when no TrustLend contracts are configured", () => {
    const result = validateSponsorshipTransaction(buildTx().toXDR(), {
      ...baseOptions(),
      allowedContractIds: new Set(),
    });
    expect(result).toMatchObject({ ok: false, code: "no_contracts_configured" });
  });
});

function request(body: unknown) {
  return new NextRequest("http://localhost/api/sponsor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let userSeq = 0;
function signInBorrower(walletAddress = borrower.publicKey()) {
  userSeq += 1;
  const id = `00000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  mockRequireAuthenticatedUser.mockResolvedValue({ user: { id, walletAddress }, role: "borrower" });
  return id;
}

describe("POST /api/sponsor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = PASSPHRASE;
    process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID = LENDING_ID;
    process.env.ADMIN_SECRET_KEY = sponsor.secret();
    // Fresh wallet per test so per-wallet budgets don't leak between tests.
    borrower = Keypair.random();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID;
    delete process.env.ADMIN_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it("requires an authenticated borrower session", async () => {
    mockRequireAuthenticatedUser.mockImplementation(() => redirect("/auth"));
    await expect(POST(request({ xdr: buildTx().toXDR() }))).rejects.toThrow();
    expect(mockRequireAuthenticatedUser).toHaveBeenCalledWith("borrower");
  });

  it("sponsors a valid TrustLend contract call", async () => {
    signInBorrower();
    const inner = buildTx();
    const res = await POST(request({ xdr: inner.toXDR() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isSimulated).toBe(false);

    const bumped = TransactionBuilder.fromXDR(body.sponsoredXdr, PASSPHRASE);
    expect(bumped).toBeInstanceOf(FeeBumpTransaction);
    expect((bumped as FeeBumpTransaction).feeSource).toBe(sponsor.publicKey());
    expect((bumped as FeeBumpTransaction).innerTransaction.hash()).toEqual(inner.hash());
  });

  it("rejects calls to non-TrustLend contracts with 403", async () => {
    signInBorrower();
    const res = await POST(request({ xdr: buildTx({ contractId: FOREIGN_ID }).toXDR() }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("contract_not_allowed");
    expect(console.warn).toHaveBeenCalled();
  });

  it("rejects transactions not sourced from the session wallet", async () => {
    signInBorrower(Keypair.random().publicKey());
    const res = await POST(request({ xdr: buildTx().toXDR() }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("source_mismatch");
  });

  it("rejects malformed XDR with 400", async () => {
    signInBorrower();
    const res = await POST(request({ xdr: "AAAA-garbage" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("malformed_xdr");
  });

  it("rejects a missing XDR or invalid JSON body with 400", async () => {
    signInBorrower();
    expect((await POST(request({}))).status).toBe(400);
    signInBorrower();
    expect((await POST(request("{not json"))).status).toBe(400);
  });

  it("rejects borrowers without a linked wallet", async () => {
    signInBorrower("");
    const res = await POST(request({ xdr: buildTx().toXDR() }));
    expect(res.status).toBe(403);
  });

  it("enforces a per-user budget even when the wallet changes", async () => {
    const userId = signInBorrower();
    const send = () => {
      const wallet = Keypair.random();
      mockRequireAuthenticatedUser.mockResolvedValue({
        user: { id: userId, walletAddress: wallet.publicKey() },
        role: "borrower",
      });
      return POST(request({ xdr: buildTx({ source: wallet.publicKey(), signer: wallet }).toXDR() }));
    };
    for (let i = 0; i < 10; i += 1) {
      expect((await send()).status).toBe(200);
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("enforces a per-wallet budget across different user accounts", async () => {
    const wallet = Keypair.random();
    const xdr = buildTx({ source: wallet.publicKey(), signer: wallet }).toXDR();
    for (let i = 0; i < 10; i += 1) {
      signInBorrower(wallet.publicKey()); // fresh user id each time
      expect((await POST(request({ xdr }))).status).toBe(200);
    }
    signInBorrower(wallet.publicKey());
    expect((await POST(request({ xdr }))).status).toBe(429);
  });

  it("does not leak internal error details", async () => {
    signInBorrower();
    process.env.ADMIN_SECRET_KEY = "not-a-secret";
    const res = await POST(request({ xdr: buildTx().toXDR() }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to sponsor transaction");
  });
});
