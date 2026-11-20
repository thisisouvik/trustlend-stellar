import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { TransactionBuilder, Keypair, Networks } from "@stellar/stellar-sdk";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  enforceIdentityRateLimit,
  enforceRouteRateLimit,
  SPONSOR_USER_POLICY,
  SPONSOR_WALLET_POLICY,
} from "@/lib/rate-limit";
import { isValidStellarAddress } from "@/lib/http/request-validation";
import {
  getMaxSponsoredFeeStroops,
  getSponsorableContractIds,
  MAX_SPONSOR_XDR_LENGTH,
  SPONSOR_BASE_FEE_STROOPS,
  validateSponsorshipTransaction,
  type SponsorshipRejectionCode,
} from "@/lib/stellar/sponsorship";

/**
 * TrustLend Advanced Feature: Fee Sponsorship (Gasless Transactions)
 *
 * POST /api/sponsor   Body: { xdr: string }
 *
 * Wraps a borrower-signed transaction in a FeeBumpTransaction signed with the
 * platform key, so the treasury pays the network fee. Because every accepted
 * request spends treasury XLM, the endpoint:
 *
 *   1. applies the per-IP route rate limit;
 *   2. requires an authenticated borrower session;
 *   3. applies per-user and per-wallet sponsorship budgets;
 *   4. validates the inner transaction (lib/stellar/sponsorship.ts) — it must
 *      be a single, signed invocation of an official TrustLend contract, sourced
 *      from the borrower's own wallet, within the sponsorship fee ceiling;
 *
 * and only then signs the fee bump.
 */

const REJECTION_STATUS: Record<SponsorshipRejectionCode, number> = {
  malformed_xdr: 400,
  fee_bump_not_allowed: 400,
  unsigned: 400,
  invalid_operation_count: 400,
  source_mismatch: 403,
  operation_source_mismatch: 403,
  unsupported_operation: 403,
  contract_not_allowed: 403,
  fee_too_high: 403,
  no_contracts_configured: 503,
};

function logRejection(reason: string, details: Record<string, unknown>) {
  console.warn("[sponsor] rejected fee sponsorship request", { reason, ...details });
}

export async function POST(req: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(req);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // ── Authentication: borrowers only ──────────────────────────────────────
    const { user } = await requireAuthenticatedUser("borrower");

    const walletAddress = user.walletAddress;
    if (!isValidStellarAddress(walletAddress)) {
      logRejection("no_linked_wallet", { userId: user.id });
      return NextResponse.json(
        { error: "A linked Stellar wallet is required for fee sponsorship" },
        { status: 403 }
      );
    }

    // ── Per-user and per-wallet sponsorship budgets ─────────────────────────
    const userLimit = await enforceIdentityRateLimit(
      "sponsor:user",
      user.id,
      SPONSOR_USER_POLICY,
      "Fee sponsorship limit reached for this account. Please try again later."
    );
    if (userLimit) {
      logRejection("user_rate_limited", { userId: user.id });
      return userLimit;
    }

    const walletLimit = await enforceIdentityRateLimit(
      "sponsor:wallet",
      walletAddress,
      SPONSOR_WALLET_POLICY,
      "Fee sponsorship limit reached for this wallet. Please try again later."
    );
    if (walletLimit) {
      logRejection("wallet_rate_limited", { userId: user.id, walletAddress });
      return walletLimit;
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      logRejection("invalid_json", { userId: user.id });
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const xdr = (body as { xdr?: unknown } | null)?.xdr;
    if (typeof xdr !== "string" || xdr.trim() === "") {
      return NextResponse.json({ error: "Missing transaction XDR" }, { status: 400 });
    }
    if (xdr.length > MAX_SPONSOR_XDR_LENGTH) {
      logRejection("xdr_too_large", { userId: user.id, length: xdr.length });
      return NextResponse.json({ error: "Transaction XDR is too large" }, { status: 413 });
    }

    // ── Validate the inner transaction ──────────────────────────────────────
    const networkPassphrase = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
    const validation = validateSponsorshipTransaction(xdr.trim(), {
      networkPassphrase,
      walletAddress,
      allowedContractIds: getSponsorableContractIds(),
      maxFeeStroops: getMaxSponsoredFeeStroops(),
    });

    if (!validation.ok) {
      logRejection(validation.code, { userId: user.id, walletAddress, detail: validation.reason });
      return NextResponse.json(
        { error: validation.reason, code: validation.code },
        { status: REJECTION_STATUS[validation.code] }
      );
    }

    const adminSecret = process.env.ADMIN_SECRET_KEY;
    if (!adminSecret) {
      // Simulation mode if key is not set up
      return NextResponse.json({
        success: true,
        message: "Fee Sponsorship Simulation: Admin secret key not configured. In production, this returns a signed FeeBumpTransaction.",
        sponsoredXdr: xdr,
        isSimulated: true
      });
    }

    // ── Wrap and sign ───────────────────────────────────────────────────────
    const sponsorKeypair = Keypair.fromSecret(adminSecret);
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsorKeypair,
      String(SPONSOR_BASE_FEE_STROOPS),
      validation.transaction,
      networkPassphrase
    );
    feeBumpTx.sign(sponsorKeypair);

    console.info("[sponsor] sponsored transaction", {
      userId: user.id,
      walletAddress,
      contractId: validation.contractId,
      functionName: validation.functionName,
      fee: feeBumpTx.fee,
    });

    return NextResponse.json({
      success: true,
      message: "Transaction fees sponsored successfully.",
      sponsoredXdr: feeBumpTx.toXDR(),
      isSimulated: false
    });
  } catch (error) {
    if (isRedirectError(error)) {
      // requireAuthenticatedUser signals "not signed in / wrong role" this way.
      throw error;
    }
    console.error("[sponsor] fee sponsorship failed:", error);
    return NextResponse.json({ error: "Failed to sponsor transaction" }, { status: 500 });
  }
}
