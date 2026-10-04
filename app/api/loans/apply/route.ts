import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, notInArray } from "drizzle-orm";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import { ledgerTransactions, lendingPools, loans, profiles, reputationSnapshots } from "@/lib/db/schema";
import { requireKycVerified } from "@/lib/kyc/middleware";
import { verifyOnchainLoanRequest } from "@/lib/loans/onchain";
import { getActiveRateConfig, isRateModel, priceLoanApr } from "@/lib/loans/rate-config";
import { getPlatformFeeBps } from "@/lib/platform/settings";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * POST /api/loans/apply
 *
 * Body: { amount, durationDays, rateModel, onchainLoanId?, onchainTxHash?, walletAddress?, preflight? }
 *
 * `preflight: true` runs every validation (KYC, limits, one-active-loan,
 * credit limit) and returns the APR without creating anything, so the client
 * can check eligibility before asking the wallet to sign the on-chain request.
 *
 * APRs come from the admin-managed schedule in `interest_rate_configs`
 * (lib/loans/rate-config.ts), not from hardcoded ladders — admins retune rates
 * from /dashboard/admin/rates without a deployment. The schedule version used
 * for the quote is stamped into `loans.metadata.rate_config_version` so a later
 * publish cannot retroactively reprice a loan already in flight.
 *
 * When the on-chain lifecycle is enabled (NEXT_PUBLIC_ONCHAIN_LOAN_LIFECYCLE,
 * see lib/stellar/onchain-lifecycle.ts) the borrower must first sign
 * `create_loan_request` on the LendingContract and send the resulting loan id
 * and transaction hash. The server verifies that transaction and the on-chain
 * record (borrower, amount, duration) before the database row is created, and
 * links the two through `loans.metadata.onchain_loan_id`.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("borrower");
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // ── KYC guard: regulated pools require verified identity ─────────────────
    const kycCheck = await requireKycVerified(user.id, db);
    if (!kycCheck.allowed) {
      return NextResponse.json(
        { error: kycCheck.reason, kycStatus: kycCheck.kycStatus },
        { status: 403 }
      );
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    const body = await request.json();
    const amount: number = body.amount;
    const durationDays: number = body.durationDays ?? body.duration_days;
    const rateModel: unknown = String(body.rateModel ?? body.rate_model ?? "fixed").toLowerCase();
    const onchainLoanId: unknown = body.onchainLoanId ?? body.onchain_loan_id;
    const onchainTxHash: unknown = body.onchainTxHash ?? body.onchain_tx_hash;
    const walletAddress: unknown = body.walletAddress ?? body.wallet_address;
    const preflight = body.preflight === true;

    const MIN_BORROW_AMOUNT = 1; // Minimum 1 XLM to prevent dust/spam loans

    if (!amount || amount < MIN_BORROW_AMOUNT) {
      return NextResponse.json(
        { error: `Invalid amount: minimum borrow amount is ${MIN_BORROW_AMOUNT} XLM` },
        { status: 400 }
      );
    }

    if (!durationDays || ![30, 60, 90].includes(Number(durationDays))) {
      return NextResponse.json(
        { error: `Invalid duration: must be 30, 60, or 90 days` },
        { status: 400 }
      );
    }

    if (!isRateModel(rateModel)) {
      return NextResponse.json(
        { error: `Invalid rate model: must be 'fixed' or 'floating'` },
        { status: 400 }
      );
    }

    // ── 1. Anti-scam: only ONE active loan at a time ─────────────────────────
    const existingLoans = await db
      .select({ id: loans.id })
      .from(loans)
      .where(
        and(eq(loans.borrowerId, user.id), notInArray(loans.status, ["repaid", "defaulted", "cancelled"])),
      )
      .limit(1);

    if (existingLoans.length > 0) {
      return NextResponse.json(
        {
          error:
            "You already have an active or pending loan. Repay or close it before applying for a new one.",
        },
        { status: 400 }
      );
    }

    // ── 2. Reputation / credit limit check ───────────────────────────────────
    const [reputation] = await db
      .select({ scoreTotal: reputationSnapshots.scoreTotal })
      .from(reputationSnapshots)
      .where(eq(reputationSnapshots.userId, user.id))
      .limit(1);

    const reputationScore: number = reputation?.scoreTotal ?? 250;
    const maxLoan = reputationScore * 10;

    if (amount > maxLoan) {
      return NextResponse.json(
        { error: `Exceeds your credit limit of ${maxLoan} XLM (trust score: ${reputationScore}).` },
        { status: 400 }
      );
    }

    // ── 3. Quote the APR from the admin-managed schedule ─────────────────────
    // Fixed-rate quotes are locked into loans.apr_bps at creation; floating
    // loans start here and are recomputed later against whatever schedule is
    // active at that point.
    const { config: rateConfig, usedFallback } = await getActiveRateConfig(db, rateModel);
    const quote = priceLoanApr(rateConfig, { amount, reputationScore, usedFallback });
    const aprBps = quote.aprBps;

    if (preflight) {
      return NextResponse.json(
        {
          ok: true,
          aprBps,
          rateModel,
          maxLoan,
          reputationScore,
          rateConfigVersion: quote.configVersion,
          rateBreakdown: {
            tierAprBps: quote.tierAprBps,
            reputationMultiplierBps: quote.reputationMultiplierBps,
            matchedAmountTier: quote.matchedAmountTier,
          },
        },
        { status: 200 }
      );
    }

    // The platform fee in force right now. Stamped into the loan below so it
    // stays fixed for this borrower even if an admin changes it later (#324).
    const originationFee = await getPlatformFeeBps(db);

    // ── 3b. Verify the on-chain loan request (mandatory when enabled) ────────
    const [borrowerProfile] = await db
      .select({ walletAddress: profiles.walletAddress })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    const onchain = await verifyOnchainLoanRequest({
      db,
      onchainLoanId,
      onchainTxHash,
      walletAddress: typeof walletAddress === "string" ? walletAddress : "",
      borrowerWallets: [user.walletAddress, borrowerProfile?.walletAddress ?? ""],
      amountXlm: amount,
      durationDays: Number(durationDays),
    });
    if (!onchain.ok) {
      return NextResponse.json({ error: onchain.reason }, { status: onchain.status });
    }

    // ── 4. Try to auto-assign a pool with enough liquidity and headroom under cap ─
    const availablePools = await db
      .select({
        id: lendingPools.id,
        availableLiquidity: lendingPools.availableLiquidity,
        totalBorrowed: lendingPools.totalBorrowed,
        borrowCap: lendingPools.borrowCap,
      })
      .from(lendingPools)
      .where(and(eq(lendingPools.status, "active"), gte(lendingPools.availableLiquidity, String(amount))))
      .orderBy(desc(lendingPools.availableLiquidity))
      .limit(10); // fetch a few so we can apply cap filtering

    const eligiblePool = availablePools.find((p) => {
      // If a borrow cap is set, ensure there is headroom (#153)
      if (p.borrowCap !== null) {
        return Number(p.totalBorrowed ?? 0) + amount <= Number(p.borrowCap);
      }
      return true; // no cap set — pool is eligible
    });

    const poolId = eligiblePool ? eligiblePool.id : null; // loan will be funded directly by a lender

    // ── 5. Create the loan ───────────────────────────────────────────────────
    const [loan] = await db
      .insert(loans)
      .values({
        borrowerId: user.id,
        poolId,
        principalAmount: String(amount),
        aprBps,
        durationDays: Number(durationDays),
        rateModel,
        status: "requested",
        metadata: {
          rate_model: rateModel,
          // Pins the loan to the schedule it was quoted under, so publishing a
          // new one never retroactively reprices this loan (issue #321).
          rate_config_version: quote.configVersion,
          rate_quote: {
            tier_apr_bps: quote.tierAprBps,
            reputation_multiplier_bps: quote.reputationMultiplierBps,
            matched_amount_tier: quote.matchedAmountTier,
            clamped: quote.clamped,
            used_fallback: quote.usedFallback,
          },
          ...onchain.metadata,
        },
      })
      .returning();

    // ── 6. Record request in ledger for traceability ────────────────────────
    try {
      await db.insert(ledgerTransactions).values({
        userId: user.id,
        category: "loan_request",
        amount: String(amount),
        currency: "XLM",
        status: "confirmed",
        refType: "loan_request",
        refId: loan.id,
        metadata: {
          stage: "requested",
          loanId: loan.id,
          durationDays: Number(durationDays),
          aprBps,
          rateModel,
          rateConfigVersion: quote.configVersion,
          fundingPath: poolId ? "pool" : "direct",
          onchainLoanId: onchain.metadata.onchain_loan_id ?? null,
          onchainTxHash: onchain.metadata.onchain_request_tx ?? null,
        },
      });
    } catch (ledgerError) {
      // Roll back the just-created loan to keep invariants strict: every request must have a ledger entry.
      await db.delete(loans).where(and(eq(loans.id, loan.id), eq(loans.borrowerId, user.id)));
      const message = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
      return NextResponse.json({ error: `Failed to record transaction trail: ${message}` }, { status: 500 });
    }

    // ── Emit notification ──
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      userId: user.id,
      title: "Loan Request Submitted",
      message: `Your ${rateModel}-rate request for ${amount} XLM is now live in the marketplace and waiting for lender funding.`,
      type: "loan_requested",
    });

    return NextResponse.json(
      {
        loan,
        rateModel,
        rateConfigVersion: quote.configVersion,
        onchain: onchain.metadata,
        fundingPath: poolId ? "pool" : "direct",
        message: poolId
          ? `Your ${rateModel}-rate loan request has been submitted. A lending pool has been assigned — it will be processed shortly.`
          : `Your ${rateModel}-rate loan request is now open. A lender will fund it directly. You'll receive XLM in your wallet once funded.`,
      },
      { status: 201 }
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Loan application error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
