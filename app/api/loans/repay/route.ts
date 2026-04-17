import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

interface RepayPayload {
  loanId: string;
  amount: number;       // total amount borrower is paying this time
  txHash: string;       // Stellar confirmed hash
  borrowerAddress: string;
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("borrower");
    const { loanId, amount, txHash, borrowerAddress } = (await request.json()) as RepayPayload;

    if (!loanId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
    }
    if (!txHash || txHash.trim().length < 10) {
      return NextResponse.json({ error: "A confirmed Stellar transaction hash is required for on-chain repayment" }, { status: 400 });
    }

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Double-check borrower & loan
    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .select("id, borrower_id, status, repaid_amount, principal_amount, apr_bps, duration_days")
      .eq("id", loanId)
      .eq("borrower_id", user.id)
      .single();

    if (loanError || !loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    if (loan.status === "repaid") return NextResponse.json({ error: "Loan is already fully repaid" }, { status: 400 });
    if (loan.status === "defaulted") return NextResponse.json({ error: "Loan is in default" }, { status: 400 });

    const srClient = getServiceRoleClient();
    if (!srClient) return NextResponse.json({ error: "Service config error" }, { status: 500 });

    // Prevent duplicate txHash
    const { data: existingTx } = await srClient
      .from("ledger_transactions")
      .select("id")
      .eq("ref_type", "loan_repay")
      .ilike("metadata->>txHash", txHash) // check if JSON contains this hash
      .maybeSingle();

    if (existingTx) {
      return NextResponse.json({ error: "This transaction hash has already been recorded" }, { status: 409 });
    }

    // Figure out the lender to notify them
    const { data: fundTx } = await srClient
      .from("ledger_transactions")
      .select("user_id, metadata")
      .eq("ref_type", "loan_fund")
      .eq("ref_id", loanId)
      .maybeSingle();
      
    const lenderUserId = fundTx?.user_id || "";
    let lenderAddress = "";
    if (fundTx) {
       try {
         const meta = JSON.parse(String(fundTx.metadata ?? "{}"));
         lenderAddress = meta.lenderAddress ?? "";
       } catch { /* ignore */ }
    }

    // Create repayment record in DB
    const { data: repayment, error: repaymentError } = await supabase
      .from("loan_repayments")
      .insert({
        loan_id: loanId,
        payer_id: user.id,
        amount: amount,
      })
      .select()
      .single();

    if (repaymentError) return NextResponse.json({ error: repaymentError.message }, { status: 500 });

    // Calculate updated balances
    const newRepaidAmount = (loan.repaid_amount || 0) + amount;
    
    // Total due calculation matches preflight
    const principal    = Number(loan.principal_amount ?? 0);
    const durationDays = Number(loan.duration_days ?? 30);
    const aprBps       = Number(loan.apr_bps ?? 0);
    const totalInterest= principal * (aprBps / 10000) * (durationDays / 365);
    const platformFee  = principal * 0.01;
    const totalDue     = principal + totalInterest + platformFee;

    let newStatus = loan.status === "funded" ? "active" : loan.status;
    // adding a small tolerance for floating point rounding issues
    if (newRepaidAmount >= totalDue - 0.0001) {
      newStatus = "repaid";
    } else if (newStatus !== "active") {
      newStatus = "active";
    }

    // Update loan record using service role (bypasses RLS which blocks borrowers from modifying statuses)
    const { error: updateError } = await srClient
      .from("loans")
      .update({
        repaid_amount: newRepaidAmount,
        status: newStatus,
      })
      .eq("id", loanId);

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    // Record on Ledger
    await supabase.from("ledger_transactions").insert({
      user_id: user.id, // the borrower
      category: "loan_repay",
      amount: amount,
      currency: "XLM",
      status: "confirmed",
      ref_type: "loan_repay",
      ref_id: repayment.id, // link to the repayment record
      metadata: JSON.stringify({
        txHash,
        borrowerAddress,
        lenderAddress,
        lenderUserId,
        loanId,
        repaymentId: repayment.id,
        principalAmount: loan.principal_amount,
        repaidSoFar: newRepaidAmount,
        repaidAt: new Date().toISOString(),
      }),
    });

    // Add reputation points
    const repayPoints = newStatus === "repaid" ? 20 : 5;
    await supabase.from("reputation_events").insert({
      user_id:      user.id,
      source_type:  "loan_repayment",
      source_id:    loanId,
      points_delta: repayPoints,
      reason:       `On-chain repayment of ${amount.toFixed(2)} XLM`,
    });

    if (srClient) {
      const { data: snap } = await srClient.from("reputation_snapshots").select("score_total").eq("user_id", user.id).maybeSingle();
      const newScore = Math.min(750, (snap?.score_total ?? 250) + repayPoints);
      await srClient.from("reputation_snapshots").upsert({
        user_id:     user.id,
        score_total: newScore,
        updated_at:  new Date().toISOString(),
      });
    }

    // Notifications
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      userId: user.id,
      title: "Repayment Successful",
      message: `You successfully repaid ${amount.toFixed(2)} XLM on-chain. Status: ${newStatus}`,
      type: "loan_repaid",
    });

    if (lenderUserId) {
      await createNotification({
        userId: lenderUserId,
        title: "Loan Repayment Received",
        message: `The borrower has repaid ${amount.toFixed(2)} XLM towards their loan on-chain!`,
        type: "loan_repaid",
      });
    }

    return NextResponse.json({ repayment, loanStatus: newStatus, txHash }, { status: 201 });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("Repayment error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
