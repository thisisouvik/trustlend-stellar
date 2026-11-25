import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { ledgerTransactions, lendingPools, poolPositions, profiles } from "@/lib/db/schema";
import { requireKycVerified } from "@/lib/kyc/middleware";
import { syncPoolOnchain } from "@/lib/pools/onchain";
import { platformWalletAddress } from "@/lib/stellar/platform-wallet";
import { PAYMENT_MEMO, verifyPaymentTransaction } from "@/lib/stellar/verify-payment";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { isBoundedString } from "@/lib/http/request-validation";

/**
 * POST /api/pools/deposit
 *
 * Body: { poolId, amount, txHash, lenderAddress }
 *
 * Flow:
 *   1. Lender signs a real Stellar payment to the platform wallet (client-side)
 *   2. Client passes the confirmed tx hash here
 *   3. The payment is verified against Horizon (signed by the lender's wallet,
 *      memo bound to this pool, `amount` XLM delivered to the platform wallet)
 *   4. The position and pool liquidity are recorded, then mirrored to the
 *      PooledLendingContract
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

    // ── KYC guard: regulated pool deposits require verified identity ────────
    const kycCheck = await requireKycVerified(user.id, db, { regulatedPoolOnly: true });
    if (!kycCheck.allowed) {
      return NextResponse.json(
        { error: kycCheck.reason, kycStatus: kycCheck.kycStatus },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { poolId, amount, txHash, lenderAddress } = body as {
      poolId: string;
      amount: number;
      txHash?: string;
      lenderAddress?: string;
    };

    if (!isBoundedString(poolId, 128) || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: "Amount exceeds maximum allowed" }, { status: 400 });
    }

    // Require a real Stellar tx hash — no ghost deposits
    if (!isBoundedString(txHash, 128) || !isBoundedString(lenderAddress, 128)) {
      return NextResponse.json(
        { error: "A confirmed Stellar transaction hash is required" },
        { status: 400 }
      );
    }

    // Prevent duplicate recording of the same tx
    const [existingTx] = await db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(sql`${ledgerTransactions.metadata}->>'txHash' = ${txHash}`)
      .limit(1);

    if (existingTx) {
      return NextResponse.json(
        { error: "This transaction has already been recorded" },
        { status: 409 }
      );
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

    // ── Verify the payment on-chain before crediting anything ────────────────
    const platformWallet = platformWalletAddress();
    if (!platformWallet) {
      return NextResponse.json(
        { error: "Pool deposits are not configured (NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS is missing)" },
        { status: 503 }
      );
    }

    const [lenderProfile] = await db
      .select({ walletAddress: profiles.walletAddress })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    const lenderWallets = new Set(
      [user.walletAddress, lenderProfile?.walletAddress].filter(
        (w): w is string => typeof w === "string" && w.length > 0
      )
    );
    if (!lenderAddress || !lenderWallets.has(lenderAddress)) {
      return NextResponse.json(
        { error: "lenderAddress does not match a wallet linked to your account" },
        { status: 400 }
      );
    }

    const verification = await verifyPaymentTransaction({
      txHash,
      expectedSource: lenderAddress,
      expectedMemo: PAYMENT_MEMO.deposit(poolId),
      expectedPayments: [{ destination: platformWallet, minAmount: amount }],
    });
    if (!verification.ok) {
      return NextResponse.json(
        { error: `Payment verification failed: ${verification.reason}` },
        { status: verification.status }
      );
    }

    // Upsert pool position (add to existing or create new)
    const [existingPosition] = await db
      .select({ id: poolPositions.id })
      .from(poolPositions)
      .where(
        and(eq(poolPositions.poolId, poolId), eq(poolPositions.lenderId, user.id), eq(poolPositions.status, "active")),
      )
      .limit(1);

    let position;
    if (existingPosition) {
      [position] = await db
        .update(poolPositions)
        .set({ principalAmount: sql`${poolPositions.principalAmount} + ${amount}` })
        .where(eq(poolPositions.id, existingPosition.id))
        .returning();
    } else {
      [position] = await db
        .insert(poolPositions)
        .values({ poolId, lenderId: user.id, principalAmount: String(amount), status: "active" })
        .returning();
    }

    // Update pool liquidity atomically (SQL-side increment, no read-modify-write race)
    await db
      .update(lendingPools)
      .set({
        totalLiquidity: sql`${lendingPools.totalLiquidity} + ${amount}`,
        availableLiquidity: sql`${lendingPools.availableLiquidity} + ${amount}`,
      })
      .where(eq(lendingPools.id, poolId));

    // Record ledger entry with tx hash for on-chain verification
    await db.insert(ledgerTransactions).values({
      userId: user.id,
      category: "deposit",
      amount: String(amount),
      currency: "XLM",
      status: "confirmed",
      refType: "pool_position",
      refId: position.id,
      metadata: { txHash, lenderAddress, poolId, verifiedLedger: verification.ledger },
    });

    // ── Mirror pool totals to the PooledLendingContract ──────────────────────
    const onchain = await syncPoolOnchain(db, poolId);

    return NextResponse.json(
      {
        position,
        txHash,
        onchain,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
      },
      { status: 201 }
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Deposit error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
