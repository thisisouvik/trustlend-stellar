import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return {
    ...actual,
    requireAuthenticatedUser: vi.fn(),
  };
});

import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth/session";
import { resetLocalRateLimitStore, SPONSOR_USER_POLICY, SPONSOR_WALLET_POLICY } from "@/lib/rate-limit";
import { POST, validateSponsoredTransactionXdr } from "./route";

const mockedRequireAuth = vi.mocked(requireAuthenticatedUser);

const LENDING_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const UNRELATED_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));

function buildContractCallXdr(params: {
  sourceKeypair: Keypair;
  contractId: string;
  method: string;
  opSource?: string;
}): string {
  const account = new Account(params.sourceKeypair.publicKey(), "100");
  const contract = new Contract(params.contractId);
  const op = contract.call(params.method, nativeToScVal(1, { type: "u32" }));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      params.opSource
        ? Operation.invokeContractFunction({
            contract: params.contractId,
            function: params.method,
            args: [nativeToScVal(1, { type: "u32" })],
            source: params.opSource,
          })
        : op
    )
    .setTimeout(60)
    .build();

  tx.sign(params.sourceKeypair);
  return tx.toXDR();
}

function buildPaymentXdr(params: {
  sourceKeypair: Keypair;
  destination: string;
  memoText?: string;
}): string {
  const account = new Account(params.sourceKeypair.publicKey(), "100");
  let builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.payment({
      destination: params.destination,
      asset: Asset.native(),
      amount: "25.0000000",
    })
  );

  if (params.memoText) {
    builder = builder.addMemo(Memo.text(params.memoText));
  }

  const tx = builder.setTimeout(60).build();
  tx.sign(params.sourceKeypair);
  return tx.toXDR();
}

function makeSponsorRequest(body: unknown, ip = "203.0.113.10"): NextRequest {
  return new NextRequest("http://localhost:3000/api/sponsor", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/sponsor (Issue #330)", () => {
  const originalEnv = { ...process.env };
  let borrowerKeypair: Keypair;
  let adminKeypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();
    resetLocalRateLimitStore();

    borrowerKeypair = Keypair.random();
    adminKeypair = Keypair.random();

    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
      NEXT_PUBLIC_LENDING_CONTRACT_ID: LENDING_CONTRACT_ID,
      NEXT_PUBLIC_ADMIN_ADDRESS: adminKeypair.publicKey(),
      ADMIN_SECRET_KEY: adminKeypair.secret(),
    };

    mockedRequireAuth.mockResolvedValue({
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        walletAddress: borrowerKeypair.publicKey(),
        role: "borrower",
        fullName: "Test Borrower",
        email: "borrower@example.com",
        createdAt: new Date(0).toISOString(),
        lastSignInAt: null,
      },
      role: "borrower",
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetLocalRateLimitStore();
  });

  it("rejects unauthenticated requests with 401 when requireAuthenticatedUser redirects to /auth", async () => {
    const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/auth;307;",
    });
    mockedRequireAuth.mockRejectedValueOnce(redirectErr);

    const xdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/unauthorized/i);
    expect(mockedRequireAuth).toHaveBeenCalledWith("borrower");
  });

  it("rejects non-borrower roles with 403 when requireAuthenticatedUser redirects to lender dashboard", async () => {
    const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/dashboard/lender;307;",
    });
    mockedRequireAuth.mockRejectedValueOnce(redirectErr);

    const xdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/borrower role required/i);
  });

  it("rejects UnauthorizedError role failures with 403", async () => {
    mockedRequireAuth.mockRejectedValueOnce(
      new UnauthorizedError("This action requires the borrower role.")
    );

    const xdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(403);
  });

  it("rejects missing or malformed XDR payloads with 400", async () => {
    const missingRes = await POST(makeSponsorRequest({}));
    expect(missingRes.status).toBe(400);

    const malformedRes = await POST(makeSponsorRequest({ xdr: "not-valid-base64-xdr!!!" }));
    expect(malformedRes.status).toBe(400);
    const malformedJson = await malformedRes.json();
    expect(malformedJson.error).toMatch(/malformed transaction xdr/i);

    const badJsonRes = await POST(makeSponsorRequest("{invalid-json"));
    expect(badJsonRes.status).toBe(400);
  });

  it("rejects transactions targeting an unrecognized smart contract with 403", async () => {
    const xdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: UNRELATED_CONTRACT_ID,
      method: "create_loan_request",
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/unrecognized or unauthorized contract/i);
  });

  it("rejects privileged administrative contract methods on official contracts with 403", async () => {
    for (const adminMethod of ["initialize", "upgrade", "pause", "trigger_insurance_payout"]) {
      const xdr = buildContractCallXdr({
        sourceKeypair: borrowerKeypair,
        contractId: LENDING_CONTRACT_ID,
        method: adminMethod,
      });

      const res = await POST(makeSponsorRequest({ xdr }));
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/not eligible for fee sponsorship/i);
    }
  });

  it("rejects arbitrary classic payment operations without an official TrustLend protocol memo", async () => {
    const recipient = Keypair.random().publicKey();
    const xdr = buildPaymentXdr({
      sourceKeypair: borrowerKeypair,
      destination: recipient,
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/only sponsored for approved TrustLend protocol repayments/i);
  });

  it("rejects inner transactions whose source wallet does not match the authenticated borrower wallet", async () => {
    const otherWallet = Keypair.random();
    const xdr = buildContractCallXdr({
      sourceKeypair: otherWallet,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/does not match the authenticated borrower wallet/i);
  });

  it("rejects transactions that are already wrapped in a FeeBumpTransaction", async () => {
    const innerXdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });
    const innerTx = TransactionBuilder.fromXDR(innerXdr, Networks.TESTNET);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      adminKeypair,
      "100000",
      innerTx as Exclude<typeof innerTx, { innerTransaction: unknown }>,
      Networks.TESTNET
    );
    feeBump.sign(adminKeypair);

    const res = await POST(makeSponsorRequest({ xdr: feeBump.toXDR() }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/already wrapped in a FeeBumpTransaction/i);
  });

  it("sponsors valid official TrustLend contract invocations and wraps them in a signed FeeBumpTransaction", async () => {
    const xdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.isSimulated).toBe(false);
    expect(typeof json.sponsoredXdr).toBe("string");

    const parsedSponsored = TransactionBuilder.fromXDR(json.sponsoredXdr, Networks.TESTNET);
    expect("innerTransaction" in parsedSponsored).toBe(true);
  });

  it("sponsors valid classic repayment transactions carrying a TL-RPY protocol memo", async () => {
    const lenderDestination = Keypair.random().publicKey();
    const xdr = buildPaymentXdr({
      sourceKeypair: borrowerKeypair,
      destination: lenderDestination,
      memoText: "TL-RPY:loan-abc123",
    });

    const res = await POST(makeSponsorRequest({ xdr }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.isSimulated).toBe(false);
  });

  it("enforces strict per-user rate limits across different client IPs", async () => {
    const xdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });

    for (let i = 0; i < SPONSOR_USER_POLICY.limit; i++) {
      const res = await POST(makeSponsorRequest({ xdr }, `198.51.100.${i + 1}`));
      expect(res.status).toBe(200);
    }

    const blockedRes = await POST(makeSponsorRequest({ xdr }, "198.51.100.250"));
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers.get("Retry-After")).toBeTruthy();
    const blockedJson = await blockedRes.json();
    expect(blockedJson.error).toMatch(/rate limit exceeded for this user account/i);
  });

  it("enforces strict per-wallet rate limits even if different user sessions share a wallet", async () => {
    const sharedWallet = Keypair.random();
    const xdr = buildContractCallXdr({
      sourceKeypair: sharedWallet,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
    });

    for (let i = 0; i < SPONSOR_WALLET_POLICY.limit; i++) {
      mockedRequireAuth.mockResolvedValueOnce({
        user: {
          id: `user-${i}`,
          walletAddress: "",
          role: "borrower",
          fullName: `Borrower ${i}`,
          email: null,
          createdAt: new Date(0).toISOString(),
          lastSignInAt: null,
        },
        role: "borrower",
      });

      const res = await POST(makeSponsorRequest({ xdr }, `203.0.113.${50 + i}`));
      expect(res.status).toBe(200);
    }

    mockedRequireAuth.mockResolvedValueOnce({
      user: {
        id: "user-overflow",
        walletAddress: "",
        role: "borrower",
        fullName: "Overflow Borrower",
        email: null,
        createdAt: new Date(0).toISOString(),
        lastSignInAt: null,
      },
      role: "borrower",
    });

    const blockedRes = await POST(makeSponsorRequest({ xdr }, "203.0.113.200"));
    expect(blockedRes.status).toBe(429);
    const blockedJson = await blockedRes.json();
    expect(blockedJson.error).toMatch(/rate limit exceeded for this wallet address/i);
  });

  it("validates operation-level source account spoofing via validateSponsoredTransactionXdr", () => {
    const attackerSource = Keypair.random().publicKey();
    const xdr = buildContractCallXdr({
      sourceKeypair: borrowerKeypair,
      contractId: LENDING_CONTRACT_ID,
      method: "create_loan_request",
      opSource: attackerSource,
    });

    const result = validateSponsoredTransactionXdr(xdr, Networks.TESTNET, process.env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.reason).toBe("mismatched_operation_source");
    }
  });
});
