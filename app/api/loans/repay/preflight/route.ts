import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * GET /api/loans/repay/preflight?loanId=...
 *
 * Returns: lender wallet address + exact repayment breakdown so the client
 * can build and sign the on-chain Stellar payment before calling POST /api/loans/repay.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("borrower");
    const loanId   = request.nextUrl.searchParams.get("loanId");
    if (!loanId) return NextResponse.json({ error: "loanId required" }, { status: 400 });

    const supabase = await getServerSupabaseClient();
    if (!supabase) return NextResponse.json({ error: "Database unavailable" }, { status: 500 });

    const { data: loan } = await supabase
      .from("loans")
      .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, borrower_id")
      .eq("id", loanId)
      .eq("borrower_id", user.id)
      .maybeSingle();

    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 });

    const repayableStatuses = ["active", "funded", "approved"];
    if (!repayableStatuses.includes(String(loan.status))) {
      return NextResponse.json({ error: "Loan is not in a repayable state" }, { status: 400 });
    }

    // Find lender wallet from the ledger (the wallet that funded this loan)
    const { data: fundTx } = await supabase
      .from("ledger_transactions")
      .select("metadata, user_id")
      .eq("ref_type", "loan_fund")
      .eq("ref_id", loanId)
      .maybeSingle();

    let lenderAddress = "";
    let lenderUserId  = "";
    if (fundTx) {
      try {
        const meta  = JSON.parse(String(fundTx.metadata ?? "{}"));
        lenderAddress = String(meta.lenderAddress ?? "");
        lenderUserId  = String(fundTx.user_id ?? meta.lenderUserId ?? "");
      } catch { /* ignore */ }
    }

    if (!lenderAddress) {
      return NextResponse.json({ error: "Lender wallet not found for this loan. Cannot process on-chain repayment." }, { status: 422 });
    }

    // --- Interest & fee calculation ---
    // Interest = principal × (apr_bps/10000) × (duration_days/365)   [pro-rated APR]
    const principal    = Number(loan.principal_amount ?? 0);
    const alreadyPaid  = Number(loan.repaid_amount ?? 0);
    const durationDays = Number(loan.duration_days ?? 30);
    const aprBps       = Number(loan.apr_bps ?? 0);

    const totalInterest   = principal * (aprBps / 10000) * (durationDays / 365);
    const platformFeePct  = 0.01; // 1% platform fee on principal
    const platformFee     = +(principal * platformFeePct).toFixed(7);
    const totalDueGross   = +(principal + totalInterest + platformFee).toFixed(7);
    const remainingDue    = +Math.max(0, totalDueGross - alreadyPaid).toFixed(7);

    // Platform wallet (set in env, or use a default treasury address for testnet)
    const platformWallet  = process.env.PLATFORM_FEE_WALLET ?? "";

    return NextResponse.json({
      loanId,
      lenderAddress,
      lenderUserId,
      borrowerAddress: user.user_metadata?.wallet_address ?? "",
      breakdown: {
        principal:       +principal.toFixed(7),
        interest:        +totalInterest.toFixed(7),
        platformFee,
        platformWallet:  platformWallet || null,
        totalDue:        totalDueGross,
        alreadyPaid:     +alreadyPaid.toFixed(7),
        remainingDue,
        aprBps,
        durationDays,
        aprPct:          +((aprBps / 10000) * 100).toFixed(4),
      },
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
