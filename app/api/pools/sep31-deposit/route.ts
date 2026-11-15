import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { ledgerTransactions, lendingPools } from "@/lib/db/schema";
import { requireKycVerified } from "@/lib/kyc/middleware";
import { getSep24Config } from "@/lib/stellar/sep24-config";
import { discoverSep31Anchor, getSep31Transaction } from "@/lib/stellar/sep31";

/**
 * POST /api/pools/sep31-deposit
 *
 * Body: { poolId, amount, currency, anchorTxId, anchorJwt, instructions, lenderAddress }
 *
 * Verifies the initiated transaction with the anchor before recording it.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("lender");
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // Require KYC verification for lenders using fiat rails
    const kycCheck = await requireKycVerified(user.id, db, { regulatedPoolOnly: true });
    if (!kycCheck.allowed) {
      return NextResponse.json(
        { error: kycCheck.reason, kycStatus: kycCheck.kycStatus },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { poolId, amount, currency, anchorTxId, instructions, lenderAddress, anchorJwt } = body as {
      poolId: string;
      amount: number;
      currency: string;
      anchorTxId: string;
      instructions: Record<string, unknown>;
      lenderAddress?: string;
      anchorJwt: string;
    };

    if (
      typeof poolId !== "string" || !poolId ||
      typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 ||
      typeof currency !== "string" || !currency ||
      typeof anchorTxId !== "string" || !anchorTxId ||
      !instructions || typeof instructions !== "object" ||
      typeof anchorJwt !== "string" || !anchorJwt
    ) {
      return NextResponse.json({ error: "Invalid request parameters" }, { status: 400 });
    }

    let anchorTransaction;
    try {
      const { homeDomain } = getSep24Config();
      const endpoints = await discoverSep31Anchor(homeDomain);
      anchorTransaction = await getSep31Transaction(
        endpoints.directPaymentServer,
        anchorJwt,
        anchorTxId,
      );
    } catch (error) {
      console.error("Failed to verify SEP-31 transaction with anchor:", error);
      return NextResponse.json({ error: "Unable to verify transaction with anchor" }, { status: 502 });
    }

    const pendingStatuses = new Set([
      "pending_sender",
      "pending_stellar",
      "pending_customer_info_update",
      "pending_transaction_info_update",
      "hold",
    ]);
    const verifiedAmount = Number(anchorTransaction.amount_in);
    const anchorCurrency = anchorTransaction.asset_code ?? anchorTransaction.amount_in_asset
      ?.split(":").slice(0, 2).pop();
    if (
      anchorTransaction.id !== anchorTxId ||
      !pendingStatuses.has(anchorTransaction.status) ||
      !anchorCurrency ||
      anchorCurrency.toUpperCase() !== currency.toUpperCase() ||
      !Number.isFinite(verifiedAmount) ||
      verifiedAmount !== amount
    ) {
      return NextResponse.json({ error: "Anchor transaction details do not match the deposit" }, { status: 400 });
    }

    // Verify pool exists and is active
    const [pool] = await db
      .select({ id: lendingPools.id })
      .from(lendingPools)
      .where(and(eq(lendingPools.id, poolId), eq(lendingPools.status, "active")))
      .limit(1);

    if (!pool) {
      return NextResponse.json({ error: "Pool not found or inactive" }, { status: 404 });
    }

    // Prevent duplicate recording of the same anchor transaction
    const [existingTx] = await db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(sql`${ledgerTransactions.metadata}->>'anchorTxId' = ${anchorTxId}`)
      .limit(1);

    if (existingTx) {
      return NextResponse.json(
        { error: "This transaction has already been recorded" },
        { status: 409 }
      );
    }

    // Record the pending deposit ledger entry
    const [transaction] = await db
      .insert(ledgerTransactions)
      .values({
        userId: user.id,
        category: "deposit",
        amount: String(amount),
        currency,
        status: "pending",
        refType: "pool_position",
        refId: null, // pool_position is created asynchronously upon webhook confirmation
        metadata: { anchorTxId, instructions, poolId, lenderAddress: lenderAddress ?? null, isSep31: true },
      })
      .returning();

    return NextResponse.json({ success: true, transaction });
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    if (error instanceof UnauthorizedError) {
      const unauthenticated = error.message === "Not authenticated";
      return NextResponse.json(
        { error: unauthenticated ? "Authentication required" : error.message },
        { status: unauthenticated ? 401 : 403 }
      );
    }
    console.error("Failed to record SEP-31 deposit:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
