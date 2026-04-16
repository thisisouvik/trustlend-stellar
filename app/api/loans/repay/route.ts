import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("borrower");
    const { loanId, amount } = await request.json();

    if (!loanId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    // Prevent unreasonably large amounts (max 1M XLM in stroops equivalent)
    if (amount > 1_000_000) {
      return NextResponse.json({ error: "Amount exceeds maximum allowed" }, { status: 400 });
    }

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Get loan and verify borrower
    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .select("id, borrower_id, status, repaid_amount, principal_amount, apr_bps")
      .eq("id", loanId)
      .eq("borrower_id", user.id)
      .single();

    if (loanError || !loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    }

    if (loan.status === "repaid") {
      return NextResponse.json({ error: "Loan already repaid" }, { status: 400 });
    }

    if (loan.status === "defaulted") {
      return NextResponse.json({ error: "Loan is in default" }, { status: 400 });
    }

    // Create repayment record
    const { data: repayment, error: repaymentError } = await supabase
      .from("loan_repayments")
      .insert({
        loan_id: loanId,
        payer_id: user.id,
        amount: amount,
      })
      .select()
      .single();

    if (repaymentError) {
      return NextResponse.json({ error: repaymentError.message }, { status: 500 });
    }

    // Update loan repaid amount
    const newRepaidAmount = (loan.repaid_amount || 0) + amount;
    const totalDue = loan.principal_amount + (loan.principal_amount * loan.apr_bps) / 10000;

    let newStatus = "active";
    if (newRepaidAmount >= totalDue) {
      newStatus = "repaid";
    }

    // Update loan status
    const { error: updateError } = await supabase
      .from("loans")
      .update({
        repaid_amount: newRepaidAmount,
        status: newStatus,
      })
      .eq("id", loanId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Add reputation points for repayment
    const repayPoints = newStatus === "repaid" ? 20 : 5;
    await supabase.from("reputation_events").insert({
      user_id:      user.id,
      source_type:  "loan_repayment",
      source_id:    loanId,
      points_delta: repayPoints,
      reason:       `Repaid ${amount} XLM towards loan`,
    });

    // Also upsert the snapshot so the trust score is immediately reflected
    const sr = getServiceRoleClient();
    if (sr) {
      const { data: snap } = await sr
        .from("reputation_snapshots")
        .select("score_total")
        .eq("user_id", user.id)
        .maybeSingle();
      const newScore = Math.min(750, (snap?.score_total ?? 250) + repayPoints);
      await sr.from("reputation_snapshots").upsert({
        user_id:     user.id,
        score_total: newScore,
        updated_at:  new Date().toISOString(),
      });
    }

    // Emit notifications
    const { createNotification } = await import("@/lib/notifications");
    // Notify Borrower
    await createNotification({
      userId: user.id,
      title: "Repayment Successful",
      message: `You have successfully repaid ${amount} XLM towards your loan. Status: ${newStatus}`,
      type: "loan_repaid",
    });

    if (sr) {
      // Find the lender (if this was a direct loan, lender info is in ledger_transactions)
      const { data: fundTx } = await sr
        .from("ledger_transactions")
        .select("user_id")
        .eq("ref_id", loanId)
        .eq("category", "loan_fund")
        .maybeSingle();
      
      if (fundTx && fundTx.user_id) {
        await createNotification({
          userId: fundTx.user_id,
          title: "Loan Repayment Received",
          message: `The borrower has repaid ${amount} XLM towards their loan!`,
          type: "loan_repaid",
        });
      }
    }

    return NextResponse.json({ repayment, loanStatus: newStatus }, { status: 201 });
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Repayment error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
