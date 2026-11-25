import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPooledDb } from "@/lib/db/client";
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

/**
 * POST /api/loans/repay
 *
 * The borrower's wallet pays each lender their pro-rata share plus the
 * platform fee in one classic transaction (see BorrowerRepayWidget). Before
 * anything is written the payment is verified against Horizon: signed by the
 * borrower's wallet, memo bound to this loan, the whole `amount` delivered to
 * the lenders' and platform wallets and nowhere else. The repayment is then
 * mirrored to the LendingContract with `record_payment`.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("borrower");
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
    const txDb = getPooledDb();
    if (!txDb) return NextResponse.json({ error: "Transactional database unavailable" }, { status: 503 });

    // Double-check borrower & loan
    const [loanRow] = await db
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

    // Prevent duplicate txHash
    const [existingTx] = await db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.refType, "loan_repay"),
          sql`lower(${ledgerTransactions.metadata}->>'txHash') = lower(${txHash})`,
        ),
      )
      .limit(1);

    if (existingTx) {
      return NextResponse.json({ error: "This transaction hash has already been recorded" }, { status: 409 });
    }

    // Figure out every lender to notify. A loan can be funded by several
    // lenders (Issue #269), each owed a pro-rata slice of this repayment.
    const lenders = await getLoanLenders(db, loanId);
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

    // Total due calculation matches preflight
    const principal    = Number(loan.principal_amount ?? 0);
    const durationDays = Number(loan.duration_days ?? 30);
    const aprBps       = Number(loan.apr_bps ?? 0);
    const totalInterest= principal * (aprBps / 10000) * (durationDays / 365);
    // The platform fee is admin-configurable (issue #324) but locked per loan:
    // `resolveLoanFeeBps` prefers the rate stamped at origination, so raising
    // the fee never increases what an outstanding loan owes. Only loans created
    // before that stamp existed fall through to the live setting.
    const activeFeeSetting = await getPlatformFeeBps(db);
    const resolvedFee  = resolveLoanFeeBps({
      principal,
      loanMetadata: loan.metadata,
      activeSetting: activeFeeSetting,
    });
    const platformFee  = resolvedFee.feeAmount;
    const totalDue     = principal + totalInterest + platformFee;

    // Lock and reread the authoritative row after Horizon verification.
    // Different valid payment transactions racing for the same loan therefore
    // cannot both apply against the same repaid balance.
    let repayment: typeof loanRepayments.$inferSelect;
    let newRepaidAmount = 0;
    let newStatus = "active";
    try {
      const result = await txDb.transaction(async (tx) => {
        const [lockedLoan] = await tx.select({
          status: loans.status,
          repaidAmount: loans.repaidAmount,
          principalAmount: loans.principalAmount,
          aprBps: loans.aprBps,
          durationDays: loans.durationDays,
        }).from(loans).where(and(eq(loans.id, loanId), eq(loans.borrowerId, user.id))).for("update").limit(1);
        if (!lockedLoan) throw new Error("Loan not found");
        if (lockedLoan.status === "repaid" || lockedLoan.status === "defaulted") throw new Error("Loan is no longer repayable");
        const lockedPrincipal = Number(lockedLoan.principalAmount);
        const lockedInterest = lockedPrincipal * (Number(lockedLoan.aprBps ?? 0) / 10000) * (Number(lockedLoan.durationDays ?? 30) / 365);
        const lockedFeeSetting = await getPlatformFeeBps(tx as unknown as typeof db);
        const lockedFee = resolveLoanFeeBps({ principal: lockedPrincipal, loanMetadata: loan.metadata, activeSetting: lockedFeeSetting }).feeAmount;
        const due = lockedPrincipal + lockedInterest + lockedFee;
        const updatedRepaid = Number(lockedLoan.repaidAmount ?? 0) + amount;
        if (updatedRepaid > due + 0.0001) throw new Error("Repayment exceeds the remaining loan balance");
        const status = updatedRepaid >= due - 0.0001 ? "repaid" : "active";
        const [repayRow] = await tx.insert(loanRepayments).values({ loanId, payerId: user.id, amount: String(amount), txRef: txHash }).returning();
        await tx.update(loans).set({ repaidAmount: String(updatedRepaid), status: status as typeof loans.$inferInsert.status }).where(eq(loans.id, loanId));
        await tx.insert(ledgerTransactions).values({
          userId: user.id, category: "loan_repay", amount: String(amount), currency: "XLM", status: "confirmed",
          refType: "loan_repay", refId: repayRow.id,
          metadata: { txHash, borrowerAddress: verification.source, verifiedLedger: verification.ledger, lenderAddress, lenderUserId,
            lenderPayouts: lenderPayouts.map((entry) => ({ lenderUserId: entry.lenderId, address: entry.address, share: +entry.share.toFixed(7), payout: entry.payout })),
            loanId, repaymentId: repayRow.id, principalAmount: lockedPrincipal, repaidSoFar: updatedRepaid, repaidAt: new Date().toISOString(),
            platformFeeBps: resolvedFee.feeBps, platformFeeAmount: lockedFee, platformFeeSource: resolvedFee.source, platformFeeVersion: resolvedFee.version },
        });
        await tx.insert(reputationEvents).values({ userId: user.id, sourceType: "loan_repayment", sourceId: loanId,
          pointsDelta: status === "repaid" ? 20 : 5, reason: `On-chain repayment of ${amount.toFixed(2)} XLM` });
        return { repayment: repayRow, repaid: updatedRepaid, status };
      });
      repayment = result.repayment;
      newRepaidAmount = result.repaid;
      newStatus = result.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("idx_loan_repayments_tx_ref") || message.includes("duplicate key value")) {
        return NextResponse.json({ error: "This transaction hash has already been recorded" }, { status: 409 });
      }
      if (message.includes("no longer repayable") || message.includes("exceeds the remaining")) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
      throw error;
    }

    // ── Mirror the repayment to the LendingContract ──────────────────────────
    const onchain = await recordRepaymentOnchain({
      db,
      loanId,
      loanMetadata: loan.metadata,
      amountXlm: amount,
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
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("Repayment error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
