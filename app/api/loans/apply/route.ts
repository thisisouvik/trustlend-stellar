import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("borrower");
    const { amount, durationDays } = await request.json();

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    if (!durationDays || ![30, 60, 90].includes(durationDays)) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Get user reputation
    const { data: reputation } = await supabase
      .from("reputation_snapshots")
      .select("score_total")
      .eq("user_id", user.id)
      .maybeSingle();

    const reputationScore = reputation?.score_total ?? 0;
    const maxLoan = reputationScore * 10;

    if (amount > maxLoan) {
      return NextResponse.json(
        { error: `Exceeds max loan amount: ${maxLoan}` },
        { status: 400 }
      );
    }

    // Get a default pool (or first available)
    const { data: pools } = await supabase
      .from("lending_pools")
      .select("id")
      .eq("status", "active")
      .limit(1);

    if (!pools || pools.length === 0) {
      return NextResponse.json({ error: "No active lending pools" }, { status: 400 });
    }

    const poolId = pools[0].id;

    // Calculate APR based on amount
    let aprBps = 1500; // 15% default
    if (amount > 2000) aprBps = 1000; // 10%
    else if (amount > 1000) aprBps = 1200; // 12%

    // Create loan
    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .insert({
        borrower_id: user.id,
        pool_id: poolId,
        principal_amount: amount,
        apr_bps: aprBps,
        duration_days: durationDays,
        status: "requested",
      })
      .select()
      .single();

    if (loanError) {
      return NextResponse.json({ error: loanError.message }, { status: 500 });
    }

    return NextResponse.json({ loan }, { status: 201 });
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Loan application error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
