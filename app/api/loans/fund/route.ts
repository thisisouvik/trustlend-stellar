import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { ledgerTransactions, loanFundings, loans, profiles } from "@/lib/db/schema";
import { sendLoanFundedEmail } from "@/lib/email/resend";
import { getFundingProgress, validateFundingAmount } from "@/lib/loans/funding";
import { qualifyReferralForLoan } from "@/lib/referrals/qualify";
import { PAYMENT_MEMO, verifyPaymentTransaction } from "@/lib/stellar/verify-payment";
import * as onchainLoans from "@/lib/loans/onchain";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { isBoundedString } from "@/lib/http/request-validation";

/**
 * POST /api/loans/fund
 *
 * Direct P2P lending with partial fills (Issue #269) — one loan request can be
 * filled by several lenders, each contributing a slice.
 *
 * Flow:
 *   1. Lender signs a Stellar payment to the BORROWER's wallet (client-side)
 *   2. Client sends the confirmed txHash and the amount funded
 *   3. The payment is verified against Horizon: signed by the lender's wallet,
 *      memo bound to this loan, at least `amount` XLM paid to the borrower's
 *      wallet and nothing paid anywhere else (Phase 2.1)
 *   4. record_loan_funding() atomically records the contribution and, once the
 *      contributions cover the principal, flips the loan to "active"
 *   5. If the loan exists on the LendingContract, the lender who completed the
 *      funding also signed `approve_loan`; the server verifies that call and
 *      then signs `activate_loan` (Phase 2.2)
 *
 * Body: { loanId, txHash, lenderAddress, amount?, approveTxHash? }
 *   `amount` defaults to the full remaining balance, so a client that predates
 *   partial fills keeps working unchanged.
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

    const body = await request.json();
    const { loanId, txHash, lenderAddress, amount, approveTxHash } = body as {
      loanId: string;
      txHash: string;
      lenderAddress: string;
      amount?: number | string;
      approveTxHash?: string;
    };

    if (!isBoundedString(loanId, 128)) {
      return NextResponse.json({ error: "loanId is required" }, { status: 400 });
    }
    if (!txHash || txHash.trim().length < 10) {
      return NextResponse.json(
        { error: "A confirmed Stellar transaction hash is required" },
        { status: 400 }
      );
    }

    const normalizedTxHash = txHash.trim();
    if (!isBoundedString(normalizedTxHash, 128) || !isBoundedString(lenderAddress, 128)) {
      return NextResponse.json({ error: "Invalid funding request" }, { status: 400 });
    }

    // ── Replay guard ─────────────────────────────────────────────────────────
    // Dedupe on the transaction hash, not on the loan: a loan may legitimately
    // receive many contributions, but each Stellar payment is claimable once.
    const [existingFunding] = await db
      .select({ id: loanFundings.id })
      .from(loanFundings)
      .where(eq(loanFundings.txHash, normalizedTxHash))
      .limit(1);

    if (existingFunding) {
      return NextResponse.json(
        { error: "This transaction has already been recorded" },
        { status: 409 }
      );
    }

    // ── Fetch the loan ───────────────────────────────────────────────────────
    const [loanRow] = await db
      .select({
        id: loans.id,
        status: loans.status,
        principalAmount: loans.principalAmount,
        fundedAmount: loans.fundedAmount,
        borrowerId: loans.borrowerId,
        aprBps: loans.aprBps,
        durationDays: loans.durationDays,
        metadata: loans.metadata,
        borrowerWallet: profiles.walletAddress,
      })
      .from(loans)
      .leftJoin(profiles, eq(profiles.id, loans.borrowerId))
      .where(eq(loans.id, loanId))
      .limit(1);

    const loan = loanRow
      ? {
          ...loanRow,
          principal_amount: Number(loanRow.principalAmount),
          funded_amount: Number(loanRow.fundedAmount),
          borrower_id: loanRow.borrowerId,
          apr_bps: loanRow.aprBps,
          duration_days: loanRow.durationDays,
          borrower_wallet: String(loanRow.borrowerWallet ?? ""),
        }
      : null;

    if (!loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    }

    const fundableStatuses = ["requested", "approved"];
    if (!fundableStatuses.includes(String(loan.status))) {
      return NextResponse.json(
        { error: `Loan is not available for funding (status: ${loan.status})` },
        { status: 409 }
      );
    }

    // ── Prevent lender from funding their own loan ────────────────────────────
    if (String(loan.borrower_id) === String(user.id)) {
      return NextResponse.json(
        { error: "You cannot fund your own loan" },
        { status: 400 }
      );
    }

    // ── Resolve and validate the contribution ────────────────────────────────
    const progressBefore = getFundingProgress(
      loan.principal_amount,
      loan.funded_amount
    );

    if (progressBefore.isFullyFunded) {
      return NextResponse.json(
        { error: "This loan is already fully funded" },
        { status: 409 }
      );
    }

    // Omitting `amount` means "fill the rest", preserving the pre-#269 contract.
    const requestedAmount = amount ?? progressBefore.remaining;
    const validation = validateFundingAmount(
      requestedAmount,
      progressBefore.remaining
    );

    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Round to Stellar's 7-decimal precision before it reaches Postgres.
    // `principal - funded` in JS floats can land a fraction above the exact
    // numeric(20,6) remainder, which the RPC would reject as overfunding.
    const contribution = Number(validation.amount.toFixed(7));
    const now = new Date().toISOString();

    // ── Verify the payment on-chain before crediting anything ────────────────
    if (!loan.borrower_wallet) {
      return NextResponse.json(
        { error: "The borrower has no wallet connected, so this loan cannot be funded yet" },
        { status: 409 }
      );
    }

    // Verify that the borrower's collateral is locked in custody on-chain (#427)
    if (typeof onchainLoans.verifyLoanCollateralForFunding === "function") {
      const collateralCheck = await onchainLoans.verifyLoanCollateralForFunding({
        loanMetadata: loan.metadata,
        borrowerWallet: loan.borrower_wallet,
        principalAmountXlm: loan.principal_amount,
      });
      if (!collateralCheck.ok) {
        return NextResponse.json(
          { error: collateralCheck.reason },
          { status: collateralCheck.status }
        );
      }
    }

    // The payment must come from the wallet this account signed in with (or
    // the wallet saved on the lender's profile), not from an address the
    // client merely claims.
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
    if (!lenderWallets.has(String(lenderAddress ?? ""))) {
      return NextResponse.json(
        { error: "lenderAddress does not match a wallet linked to your account" },
        { status: 400 }
      );
    }

    const verification = await verifyPaymentTransaction({
      txHash: normalizedTxHash,
      expectedSource: String(lenderAddress),
      expectedMemo: PAYMENT_MEMO.fund(loanId),
      expectedPayments: [{ destination: loan.borrower_wallet, minAmount: contribution }],
    });
    if (!verification.ok) {
      return NextResponse.json(
        { error: `Payment verification failed: ${verification.reason}` },
        { status: verification.status }
      );
    }
    const verifiedLenderAddress = verification.source;

    // ── Record the contribution atomically ───────────────────────────────────
    // The RPC locks the loan row, so concurrent lenders cannot both read the
    // same remaining balance and collectively overfund the loan.
    type FundingResultRow = {
      loan_id: string;
      status: string;
      principal_amount: string | number;
      funded_amount: string | number;
      remaining_amount: string | number;
      is_fully_funded: boolean;
      funding_id: string;
    };
    let fundingRows: FundingResultRow[];
    try {
      const executed = await db.execute(
        sql`select loan_id, status, principal_amount, funded_amount, remaining_amount, is_fully_funded, funding_id
             from public.record_loan_funding(${loanId}::uuid, ${user.id}::uuid, ${contribution}::numeric, ${normalizedTxHash}::text, ${verifiedLenderAddress}::text, ${now}::timestamptz)`,
      );
      fundingRows = executed.rows as FundingResultRow[];
    } catch (rpcErr) {
      const message = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);

      // The tx_hash unique index is the authoritative replay guard against a
      // duplicate that slipped past the pre-check in a concurrent request.
      if (
        message.includes("idx_loan_fundings_tx_hash") ||
        message.includes("duplicate key value")
      ) {
        return NextResponse.json(
          { error: "This transaction has already been recorded" },
          { status: 409 }
        );
      }

      // The RPC raises for the race-condition cases: another lender took the
      // remaining balance between our read and our write.
      if (
        message.includes("already fully funded") ||
        message.includes("exceeds the remaining") ||
        message.includes("not available for funding")
      ) {
        return NextResponse.json({ error: message }, { status: 409 });
      }

      return NextResponse.json({ error: message }, { status: 500 });
    }

    // The function returns a single-row table.
    const result = fundingRows[0];
    const progressAfter = getFundingProgress(
      result?.principal_amount ?? loan.principal_amount,
      result?.funded_amount ?? progressBefore.funded + contribution
    );
    const isFullyFunded = Boolean(result?.is_fully_funded ?? progressAfter.isFullyFunded);

    // ── Mirror activation to the LendingContract ─────────────────────────────
    // The XLM has already moved and is recorded above; a chain failure here is
    // surfaced in the response and in loans.metadata rather than rolled back.
    const onchain = isFullyFunded
      ? await onchainLoans.activateFundedLoanOnchain({
          db,
          loanId,
          loanMetadata: loan.metadata,
          lenderAddress: verifiedLenderAddress,
          approveTxHash,
        })
      : { attempted: false as const };

    // ── Record in ledger with full transparency info ──────────────────────────
    await db.insert(ledgerTransactions).values({
      userId: user.id, // the lender
      category: "loan_fund",
      amount: String(contribution),
      currency: "XLM",
      status: "confirmed",
      refType: "loan_fund",
      refId: loanId,
      metadata: {
        txHash: normalizedTxHash,
        lenderAddress: verifiedLenderAddress,
        lenderUserId: user.id,
        verifiedLedger: verification.ledger,
        borrowerId: String(loan.borrower_id),
        loanId,
        contributionAmount: contribution,
        principalAmount: loan.principal_amount,
        fundedAmountAfter: progressAfter.funded,
        remainingAfter: progressAfter.remaining,
        isFullyFunded,
        aprBps: loan.apr_bps,
        durationDays: loan.duration_days,
        fundedAt: now,
      },
    });

    // ── Emit notifications ──
    const { createNotification } = await import("@/lib/notifications");
    const percentLabel = `${Math.round(progressAfter.percent)}%`;

    if (isFullyFunded) {
      // Notify Borrower — the loan is live and the money is on its way.
      await createNotification({
        userId: String(loan.borrower_id),
        title: "Loan Fully Funded!",
        message: `Great news! Your loan of ${progressAfter.principal} XLM is now 100% funded and active. The funds have been sent to your wallet.`,
        type: "loan_funded",
      });
      await sendLoanFundedEmail({
        userId: String(loan.borrower_id),
        amount: progressAfter.principal,
        loanId,
      });

      // ── Referral bonus (Issue #266) ──
      // The loan is now Active, which is what qualifies the borrower's
      // referrer. The XLM payout itself is made on-chain by the lending
      // contract during activate_loan; this mirrors it for the dashboard.
      const referral = await qualifyReferralForLoan({
        db,
        refereeId: String(loan.borrower_id),
        loanId,
      });

      if (referral.qualified && referral.referrerId) {
        await createNotification({
          userId: referral.referrerId,
          title: "Referral Bonus Earned!",
          message:
            "Someone you invited just had their first loan funded. Your referral bonus is on its way to your wallet.",
          type: "investment_made",
        });
      }
    } else {
      // Partial fill — tell the borrower how far along the request is.
      await createNotification({
        userId: String(loan.borrower_id),
        title: "Loan Partially Funded",
        message: `A lender contributed ${contribution} XLM to your loan request. It is now ${percentLabel} funded — ${progressAfter.remaining.toFixed(2)} XLM still needed to activate it.`,
        type: "loan_funded",
      });
    }

    // Notify Lender
    await createNotification({
      userId: user.id,
      title: "Funding Successful",
      message: isFullyFunded
        ? `You contributed ${contribution} XLM and completed this loan's funding. View 'Loans You Funded' for details.`
        : `You contributed ${contribution} XLM. The loan is now ${percentLabel} funded.`,
      type: "investment_made",
    });

    return NextResponse.json(
      {
        loanId,
        status: String(result?.status ?? loan.status),
        txHash: normalizedTxHash,
        amountFunded: contribution,
        principalAmount: progressAfter.principal,
        fundedAmount: progressAfter.funded,
        remainingAmount: progressAfter.remaining,
        fundedPercent: progressAfter.percent,
        isFullyFunded,
        onchain,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${normalizedTxHash}`,
        message: isFullyFunded
          ? "Loan fully funded and activated. The borrower will receive XLM in their wallet."
          : `Contribution recorded. This loan is now ${percentLabel} funded.`,
      },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Loan funding error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
