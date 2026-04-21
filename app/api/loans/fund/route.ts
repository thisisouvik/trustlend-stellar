import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * POST /api/loans/fund
 *
 * Direct P2P lending — a lender directly funds a specific open loan.
 *
 * Flow:
 *   1. Lender signs a Stellar payment to the BORROWER's wallet via Freighter (client-side)
 *   2. Client sends the confirmed txHash here
 *   3. We validate the loan is still "requested" (not funded by someone else)
 *   4. Update loan → status: "active", record lender info & txHash in ledger
 *
 * Body: { loanId, txHash, lenderAddress, lenderUserId? }
 */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("lender");
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const body = await request.json();
    const { loanId, txHash, lenderAddress } = body as {
      loanId: string;
      txHash: string;
      lenderAddress: string;
    };

    if (!loanId) {
      return NextResponse.json({ error: "loanId is required" }, { status: 400 });
    }
    if (!txHash || txHash.trim().length < 10) {
      return NextResponse.json(
        { error: "A confirmed Stellar transaction hash is required" },
        { status: 400 }
      );
    }

    // ── Prevent duplicate recording of same tx ───────────────────────────────
    const { data: existingTx } = await supabase
      .from("ledger_transactions")
      .select("id")
      .eq("ref_type", "loan_fund")
      .eq("ref_id", loanId)
      .maybeSingle();

    if (existingTx) {
      return NextResponse.json(
        { error: "This loan has already been funded" },
        { status: 409 }
      );
    }

    // ── Fetch the loan ───────────────────────────────────────────────────────
    const { data: loan, error: fetchErr } = await supabase
      .from("loans")
      .select("id, status, principal_amount, borrower_id, pool_id, apr_bps, duration_days")
      .eq("id", loanId)
      .maybeSingle();

    if (fetchErr || !loan) {
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

    const now = new Date().toISOString();

    // Calculate due date based on duration
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + Number(loan.duration_days ?? 30));

    // ── Activate the loan ────────────────────────────────────────────────────
    const { data: activatedLoan, error: updateErr } = await supabase.rpc("activate_loan_funding", {
      p_loan_id: loanId,
      p_lender_id: user.id,
      p_approved_at: now,
      p_due_at: dueDate.toISOString(),
    });

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // ── Record in ledger with full transparency info ──────────────────────────
    await supabase.from("ledger_transactions").insert({
      user_id: user.id, // the lender
      category: "loan_fund",
      amount: Number(loan.principal_amount ?? 0),
      currency: "XLM",
      status: "confirmed",
      ref_type: "loan_fund",
      ref_id: loanId,
      metadata: JSON.stringify({
        txHash,
        lenderAddress,
        lenderUserId: user.id,
        borrowerId: String(loan.borrower_id),
        loanId,
        principalAmount: loan.principal_amount,
        aprBps: loan.apr_bps,
        durationDays: loan.duration_days,
        fundedAt: now,
      }),
    });

    // ── Emit notifications ──
    const { createNotification } = await import("@/lib/notifications");
    // Notify Borrower
    await createNotification({
      userId: String(loan.borrower_id),
      title: "Loan Funded!",
      message: `Great news! A lender has funded your loan of ${loan.principal_amount} XLM. The funds have been sent to your wallet.`,
      type: "loan_funded",
    });
    // Notify Lender
    await createNotification({
      userId: user.id,
      title: "Funding Successful",
      message: `You successfully funded a ${loan.principal_amount} XLM loan. View 'Loans You Funded' for details.`,
      type: "investment_made",
    });

    return NextResponse.json(
      {
        loanId,
        status: String(activatedLoan?.status ?? "active"),
        txHash,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        message: "Loan funded successfully. The borrower will receive XLM in their wallet.",
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
