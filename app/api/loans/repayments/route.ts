import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("borrower");
    const loanId = request.nextUrl.searchParams.get("loanId");

    if (!loanId) {
      return NextResponse.json({ error: "loanId is required" }, { status: 400 });
    }

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Verify loan belongs to this borrower
    const { data: loan } = await supabase
      .from("loans")
      .select("id, principal_amount, repaid_amount, status")
      .eq("id", loanId)
      .eq("borrower_id", user.id)
      .maybeSingle();

    if (!loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    }

    // Fetch repayment history
    const { data: repayments } = await supabase
      .from("loan_repayments")
      .select("id, amount, created_at")
      .eq("loan_id", loanId)
      .order("created_at", { ascending: false })
      .limit(50);

    const dueAmount = Math.max(0, Number(loan.principal_amount) - Number(loan.repaid_amount ?? 0));

    return NextResponse.json({
      repayments: (repayments ?? []).map((r) => ({
        id: r.id,
        repayment_id: r.id,
        amount: Number(r.amount),
        created_at: r.created_at,
      })),
      dueAmount,
      loanStatus: loan.status,
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error("Repayments fetch error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
