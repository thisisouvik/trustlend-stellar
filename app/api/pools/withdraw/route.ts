import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { ledgerTransactions, lendingPools, poolPositions, profiles } from "@/lib/db/schema";
import { syncPoolOnchain } from "@/lib/pools/onchain";
import { PlatformWalletError, payoutFromPlatformWallet } from "@/lib/stellar/platform-wallet";
import { PAYMENT_MEMO } from "@/lib/stellar/verify-payment";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { isBoundedString } from "@/lib/http/request-validation";

/**
 * POST /api/pools/withdraw
 *
 * Body: { positionId, amount }; requests require a unique Idempotency-Key header.
 *
 * Pays `amount` XLM from the platform wallet back to the lender's wallet
 * (server-signed with PLATFORM_WALLET_SECRET) after reserving the position and
 * pool liquidity, then mirrors the new totals to the PooledLendingContract.
 * Failed payouts release both reservations.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("lender");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return NextResponse.json({ error: "A valid Idempotency-Key header is required" }, { status: 400 });
    }
    const { positionId, amount } = await request.json();

    if (!isBoundedString(positionId, 128) || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: "Amount exceeds maximum allowed" }, { status: 400 });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Get position and verify ownership
    const [positionRow] = await db
      .select({
        id: poolPositions.id,
        poolId: poolPositions.poolId,
        principalAmount: poolPositions.principalAmount,
        withdrawnAmount: poolPositions.withdrawnAmount,
      })
      .from(poolPositions)
      .where(
        and(eq(poolPositions.id, positionId), eq(poolPositions.lenderId, user.id), eq(poolPositions.status, "active")),
      )
      .limit(1);

    if (!positionRow) {
      return NextResponse.json({ error: "Position not found" }, { status: 404 });
    }
    const position = {
      id: positionRow.id,
      pool_id: positionRow.poolId,
      principal_amount: Number(positionRow.principalAmount),
      withdrawn_amount: Number(positionRow.withdrawnAmount),
    };

    if (amount > position.principal_amount) {
      return NextResponse.json(
        { error: "Withdrawal amount exceeds principal" },
        { status: 400 }
      );
    }

    // Get pool
    const [poolRow] = await db
      .select({ availableLiquidity: lendingPools.availableLiquidity })
      .from(lendingPools)
      .where(eq(lendingPools.id, position.pool_id))
      .limit(1);

    if (!poolRow) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    if (amount > Number(poolRow.availableLiquidity)) {
      return NextResponse.json(
        { error: "Insufficient liquidity in pool for withdrawal" },
        { status: 400 }
      );
    }

    // ── Pay the lender from the platform wallet ──────────────────────────────
    const [lenderProfile] = await db
      .select({ walletAddress: profiles.walletAddress })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    const destination = lenderProfile?.walletAddress || user.walletAddress;
    if (!destination) {
      return NextResponse.json(
        { error: "Connect a Stellar wallet on your profile before withdrawing" },
        { status: 409 }
      );
    }

    const withdrawalAmount = Number(Number(amount).toFixed(7));
    if (withdrawalAmount <= 0 || withdrawalAmount > position.principal_amount) {
      return NextResponse.json({ error: "Withdrawal amount is below the supported precision or exceeds principal" }, { status: 400 });
    }
    const [reservation] = await db
      .insert(ledgerTransactions)
      .values({
        userId: user.id,
        category: "withdrawal",
        amount: String(withdrawalAmount),
        currency: "XLM",
        status: "pending",
        refType: "pool_position",
        refId: positionId,
        metadata: { withdrawalIdempotencyKey: idempotencyKey },
      })
      .onConflictDoNothing()
      .returning({ id: ledgerTransactions.id });
    if (!reservation) {
      return NextResponse.json({ error: "This withdrawal request has already been submitted" }, { status: 409 });
    }

    const [reservedPosition] = await db
      .update(poolPositions)
      .set({
        principalAmount: sql`${poolPositions.principalAmount} - ${withdrawalAmount}`,
        withdrawnAmount: sql`${poolPositions.withdrawnAmount} + ${withdrawalAmount}`,
        status: sql`CASE WHEN ${poolPositions.principalAmount} - ${withdrawalAmount} <= 0 THEN 'closed'::position_status ELSE 'active'::position_status END`,
        closedAt: sql`CASE WHEN ${poolPositions.principalAmount} - ${withdrawalAmount} <= 0 THEN now() ELSE NULL END`,
      })
      .where(and(
        eq(poolPositions.id, positionId),
        eq(poolPositions.lenderId, user.id),
        eq(poolPositions.status, "active"),
        gte(poolPositions.principalAmount, String(withdrawalAmount)),
      ))
      .returning({ id: poolPositions.id });
    if (!reservedPosition) {
      await db.update(ledgerTransactions).set({ status: "failed" }).where(eq(ledgerTransactions.id, reservation.id));
      return NextResponse.json({ error: "Position changed; refresh and retry with a new Idempotency-Key" }, { status: 409 });
    }

    const [reservedPool] = await db
      .update(lendingPools)
      .set({
        totalLiquidity: sql`${lendingPools.totalLiquidity} - ${withdrawalAmount}`,
        availableLiquidity: sql`${lendingPools.availableLiquidity} - ${withdrawalAmount}`,
      })
      .where(and(
        eq(lendingPools.id, position.pool_id),
        gte(lendingPools.availableLiquidity, String(withdrawalAmount)),
      ))
      .returning({ id: lendingPools.id });
    if (!reservedPool) {
      await db.update(poolPositions).set({
        principalAmount: sql`${poolPositions.principalAmount} + ${withdrawalAmount}`,
        withdrawnAmount: sql`${poolPositions.withdrawnAmount} - ${withdrawalAmount}`,
        status: "active",
        closedAt: null,
      }).where(eq(poolPositions.id, positionId));
      await db.update(ledgerTransactions).set({ status: "failed" }).where(eq(ledgerTransactions.id, reservation.id));
      return NextResponse.json({ error: "Insufficient liquidity in pool for withdrawal" }, { status: 400 });
    }

    let payout: { hash: string; source: string };
    try {
      payout = await payoutFromPlatformWallet({
        destination,
        amountXlm: withdrawalAmount,
        memo: PAYMENT_MEMO.withdraw(String(positionId)),
      });
    } catch (payoutError) {
      await db.update(poolPositions).set({
        principalAmount: sql`${poolPositions.principalAmount} + ${withdrawalAmount}`,
        withdrawnAmount: sql`${poolPositions.withdrawnAmount} - ${withdrawalAmount}`,
        status: "active",
        closedAt: null,
      }).where(eq(poolPositions.id, positionId));
      await db.update(lendingPools).set({
        totalLiquidity: sql`${lendingPools.totalLiquidity} + ${withdrawalAmount}`,
        availableLiquidity: sql`${lendingPools.availableLiquidity} + ${withdrawalAmount}`,
      }).where(eq(lendingPools.id, position.pool_id));
      await db.update(ledgerTransactions).set({ status: "failed" }).where(eq(ledgerTransactions.id, reservation.id));
      if (payoutError instanceof PlatformWalletError) {
        return NextResponse.json(
          { error: `Withdrawals are unavailable: ${payoutError.message}` },
          { status: 503 }
        );
      }
      const message = payoutError instanceof Error ? payoutError.message : String(payoutError);
      return NextResponse.json({ error: `Payout failed: ${message}` }, { status: 502 });
    }

    await db.update(ledgerTransactions).set({
      status: "confirmed",
      metadata: { withdrawalIdempotencyKey: idempotencyKey, txHash: payout.hash, lenderAddress: destination, platformWallet: payout.source },
    }).where(eq(ledgerTransactions.id, reservation.id));

    // ── Mirror pool totals to the PooledLendingContract ──────────────────────
    const onchain = await syncPoolOnchain(db, position.pool_id);

    return NextResponse.json(
      {
        message: "Withdrawal successful",
        withdrawalAmount,
        txHash: payout.hash,
        onchain,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${payout.hash}`,
      },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Withdrawal error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
