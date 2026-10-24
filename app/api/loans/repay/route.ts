import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, eq, or, sql } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db/client";
import { ledgerTransactions, loanRepayments, loans, profiles, reputationEvents } from "@/lib/db/schema";
import { getLoanLenders } from "@/lib/loans/lenders";
import { splitRepaymentAcrossLenders } from "@/lib/loans/funding";
import { recordRepaymentOnchain } from "@/lib/loans/onchain";
import { getPlatformFeeBps, resolveLoanFeeBps } from "@/lib/platform/settings";
import { PAYMENT_MEMO, verifyPaymentTransaction } from "@/lib/stellar/verify-payment";
import { isRedirectError } from "next/dist/client/components/redirect-error";

interface RepayPayload {
  loanId: string;
  amount: number;       // total amount borrower is paying this time
  txHash: string;       // Stellar confirmed hash
  borrowerAddress: string;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

async function runInTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (typeof (db as { transaction?: unknown }).transaction === "function") {
    return db.transaction(async (tx) => fn(tx as unknown as Db));
  }
  return fn(db);
}

function withRowLock<TQuery>(query: TQuery): TQuery {
  const lockable = query as TQuery & { for?: (mode: "update") => TQuery };
  if (typeof lockable.for === "function") {
    return lockable.for("update");
  }
  return query;
}

/**
 * POST /api/loans/repay
 *
 * The borrower's wallet pays each lender their pro-rata share plus the
 * platform fee in one classic transaction (see BorrowerRepayWidget). Before
 * anything is written the payment is verified against Horizon: signed by the
 * borrower's wallet, memo bound to this loan, the whole `amount` delivered to
 * the lenders' and platform wallets and nowhere else. The repayment is then
 * mirrored to the LendingContract with `record_payment`.
 *
 * Concurrency & idempotency (Issue #428):
 *  - Wraps loan balance read, verification, and repayment writes in an atomic
 *    `db.transaction()` with `SELECT ... FOR UPDATE` row-level locking on the
 *    target loan record so concurrent requests cannot race on `repaidAmount`.
 *  - Deduplicates by both `txHash` and optional `Idempotency-Key` header.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("borrower");

    const rawIdempotencyKey =
      request.headers.get("Idempotency-Key") ??
      request.headers.get("idempotency-key") ??
      request.headers.get("x-idempotency-key");
    const idempotencyKey = rawIdempotencyKey !== null ? rawIdempotencyKey.trim() : null;
    if (
      idempotencyKey !== null &&
      (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
    ) {
      return NextResponse.json(
        { error: "Invalid Idempotency-Key header" },
        { status: 400 },
      );
    }

    const { loanId, amount, txHash, borrowerAddress } = (await request.json()) as RepayPayload;

    if (!loanId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
    }
    if (!txHash || txHash.trim().length < 10) {
      return NextResponse.json({ error: "A confirmed Stellar transaction hash is required for on-chain repayment" }, { status: 400 });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    return await runInTransaction(db, async (tx) => {
      // Lock the target loan row with FOR UPDATE so concurrent repayments serialize
      const loanSelect = tx
        .select({
          id: loans.id,
          status: loans.status,
          repaidAmount: loans.repaidAmount,
          principalAmount: loans.principalAmount,
          aprBps: loans.aprBps,
          durationDays: loans.durationDays,
          metadata: loans.metadata,
          borrowerWallet: profiles.walletAddress,
        })
        .from(loans)
        .leftJoin(profiles, eq(profiles.id, loans.borrowerId))
        .where(and(eq(loans.id, loanId), eq(loans.borrowerId, user.id)))
        .limit(1);

      const [loanRow] = await withRowLock(loanSelect);

      if (!loanRow) return NextResponse.json({ error: "Loan not found" }, { status: 404 });
      const loan = {
        id: loanRow.id,
        status: loanRow.status as string,
        repaid_amount: Number(loanRow.repaidAmount),
        principal_amount: Number(loanRow.principalAmount),
        apr_bps: loanRow.aprBps,
        duration_days: loanRow.durationDays,
        metadata: loanRow.metadata,
        borrower_wallet: String(loanRow.borrowerWallet ?? ""),
      };
      if (loan.status === "repaid") return NextResponse.json({ error: "Loan is already fully repaid" }, { status: 400 });
      if (loan.status === "defaulted") return NextResponse.json({ error: "Loan is in default" }, { status: 400 });

      // Prevent duplicate txHash or duplicate Idempotency-Key
      const dedupCondition = idempotencyKey
        ? or(
            sql`lower(${ledgerTransactions.metadata}->>'txHash') = lower(${txHash})`,
            sql`${ledgerTransactions.metadata}->>'idempotencyKey' = ${idempotencyKey}`,
          )
        : sql`lower(${ledgerTransactions.metadata}->>'txHash') = lower(${txHash})`;

      const [existingTx] = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(
          and(
            eq(ledgerTransactions.refType, "loan_repay"),
            dedupCondition,
          ),
        )
        .limit(1);

      if (existingTx) {
        return NextResponse.json(
          { error: "This transaction hash or idempotency key has already been recorded" },
          { status: 409 },
        );
      }

      // Figure out every lender to notify. A loan can be funded by several
      // lenders (Issue #269), each owed a pro-rata slice of this repayment.
      const lenders = await getLoanLenders(tx, loanId);
      const primaryLender = lenders[0];
      const lenderUserId = primaryLender?.lenderId ?? "";
      const lenderAddress = primaryLender?.address ?? "";
      const lenderPayouts = splitRepaymentAcrossLenders(amount, lenders);

      // ── Verify the repayment on-chain before crediting it ────────────────────
      // The borrower may only pay from the wallet they signed in with or the one
      // saved on their profile; the client-supplied address is just a claim.
      const borrowerWallets = new Set(
        [user.walletAddress, loan.borrower_wallet].filter((w) => typeof w === "string" && w.length > 0)
      );
      if (!borrowerWallets.has(String(borrowerAddress ?? ""))) {
        return NextResponse.json(
          { error: "borrowerAddress does not match a wallet linked to your account" },
          { status: 400 }
        );
      }

      const platformWallet = process.env.PLATFORM_FEE_WALLET ?? "";
      const allowedDestinations = [
        ...lenders.map((l) => l.address).filter((a) => a.length > 0),
        ...(platformWallet ? [platformWallet] : []),
      ];
      if (allowedDestinations.length === 0) {
        return NextResponse.json(
          { error: "No lender wallet is recorded for this loan, so the repayment cannot be verified" },
          { status: 409 }
        );
      }

      const verification = await verifyPaymentTransaction({
        txHash,
        expectedSource: String(borrowerAddress),
        expectedMemo: PAYMENT_MEMO.repay(loanId),
        // Each lender's share is checked in aggregate: the whole amount must
        // have landed across the lenders + platform wallet and nowhere else.
        expectedPayments: allowedDestinations.map((destination) => ({ destination, minAmount: 0 })),
      });
      if (!verification.ok) {
        return NextResponse.json(
          { error: `Payment verification failed: ${verification.reason}` },
          { status: verification.status }
        );
      }
      if (verification.totalNative + 0.0000001 < amount) {
        return NextResponse.json(
          {
            error: `Payment verification failed: transaction moved ${verification.totalNative.toFixed(7)} XLM but ${amount} XLM was claimed`,
          },
          { status: 422 }
        );
      }

      // Create repayment record in DB
      const [repayment] = await tx
        .insert(loanRepayments)
        .values({ loanId, payerId: user.id, amount: String(amount), txRef: txHash })
        .returning();

      // Calculate updated balances
      const newRepaidAmount = (loan.repaid_amount || 0) + amount;

      // Total due calculation matches preflight
      const principal    = Number(loan.principal_amount ?? 0);
      const durationDays = Number(loan.duration_days ?? 30);
      const aprBps       = Number(loan.apr_bps ?? 0);
      const totalInterest= principal * (aprBps / 10000) * (durationDays / 365);
      // The platform fee is admin-configurable (issue #324) but locked per loan:
      // `resolveLoanFeeBps` prefers the rate stamped at origination, so raising
      // the fee never increases what an outstanding loan owes. Only loans created
      // before that stamp existed fall through to the live setting.
      const activeFeeSetting = await getPlatformFeeBps(tx);
      const resolvedFee  = resolveLoanFeeBps({
        principal,
        loanMetadata: loan.metadata,
        activeSetting: activeFeeSetting,
      });
      const platformFee  = resolvedFee.feeAmount;
      const totalDue     = principal + totalInterest + platformFee;

      let newStatus = loan.status === "funded" ? "active" : loan.status;
      // adding a small tolerance for floating point rounding issues
      if (newRepaidAmount >= totalDue - 0.0001) {
        newStatus = "repaid";
      } else if (newStatus !== "active") {
        newStatus = "active";
      }

      await tx
        .update(loans)
        .set({
          repaidAmount: String(newRepaidAmount),
          status: newStatus as typeof loans.$inferInsert.status,
        })
        .where(eq(loans.id, loanId));

      // ── Mirror the repayment to the LendingContract ──────────────────────────
      const onchain = await recordRepaymentOnchain({
        db: tx,
        loanId,
        loanMetadata: loan.metadata,
        amountXlm: amount,
      });

      // Record on Ledger
      await tx.insert(ledgerTransactions).values({
        userId: user.id, // the borrower
        category: "loan_repay",
        amount: String(amount),
        currency: "XLM",
        status: "confirmed",
        refType: "loan_repay",
        refId: repayment.id, // link to the repayment record
        metadata: {
          txHash,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          borrowerAddress: verification.source,
          verifiedLedger: verification.ledger,
          lenderAddress,
          lenderUserId,
          // Full pro-rata breakdown so each lender's share of this repayment is
          // auditable after the fact (Issue #269).
          lenderPayouts: lenderPayouts.map((entry) => ({
            lenderUserId: entry.lenderId,
            address: entry.address,
            share: +entry.share.toFixed(7),
            payout: entry.payout,
          })),
          loanId,
          repaymentId: repayment.id,
          principalAmount: loan.principal_amount,
          repaidSoFar: newRepaidAmount,
          repaidAt: new Date().toISOString(),
          // Which fee was charged and where it came from, so a borrower dispute
          // can be settled from the ledger alone (issue #324).
          platformFeeBps: resolvedFee.feeBps,
          platformFeeAmount: platformFee,
          platformFeeSource: resolvedFee.source,
          platformFeeVersion: resolvedFee.version,
        },
      });

      // Add reputation points
      const repayPoints = newStatus === "repaid" ? 20 : 5;
      await tx.insert(reputationEvents).values({
        userId: user.id,
        sourceType: "loan_repayment",
        sourceId: loanId,
        pointsDelta: repayPoints,
        reason: `On-chain repayment of ${amount.toFixed(2)} XLM`,
      });

      // Notifications
      const { createNotification } = await import("@/lib/notifications");
      await createNotification({
        userId: user.id,
        title: "Repayment Successful",
        message: `You successfully repaid ${amount.toFixed(2)} XLM on-chain. Status: ${newStatus}`,
        type: "loan_repaid",
      });

      // Notify every lender with the slice that reached them.
      for (const entry of lenderPayouts) {
        if (!entry.lenderId) continue;

        await createNotification({
          userId: entry.lenderId,
          title: "Loan Repayment Received",
          message:
            lenderPayouts.length > 1
              ? `The borrower repaid ${amount.toFixed(2)} XLM on-chain. Your share (${(entry.share * 100).toFixed(1)}% of this loan) is ${entry.payout.toFixed(2)} XLM.`
              : `The borrower has repaid ${amount.toFixed(2)} XLM towards their loan on-chain!`,
          type: "loan_repaid",
        });
      }

      return NextResponse.json({ repayment, loanStatus: newStatus, txHash, onchain }, { status: 201 });
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("Repayment error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
