import { NextRequest, NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── 2. Parse request body ─────────────────────────────────────────────────
    const body = await request.json();
    const amount: number = body.amount;
    // Accept both camelCase and snake_case from the frontend
    const durationDays: number = body.durationDays ?? body.duration_days;

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    if (!durationDays || ![30, 60, 90].includes(Number(durationDays))) {
      return NextResponse.json(
        { error: `Invalid duration: received "${durationDays}", must be 30, 60 or 90` },
        { status: 400 }
      );
    }

    // ── 3. Check reputation-based loan limit ─────────────────────────────────
    // Score is seeded on KYC approval; 250 is the starting fallback
    // so new users can borrow immediately while their snapshot is being set up.
    const { data: reputation } = await supabase
      .from("reputation_snapshots")
      .select("score_total")
      .eq("user_id", user.id)
      .maybeSingle();

    const reputationScore: number = reputation?.score_total ?? 250;
    const maxLoan = reputationScore * 10;

    if (amount > maxLoan) {
      return NextResponse.json(
        { error: `Exceeds your credit limit of ${maxLoan} XLM (score: ${reputationScore}).` },
        { status: 400 }
      );
    }

    // ── 4. Find an active lending pool ────────────────────────────────────────
    const { data: pools } = await supabase
      .from("lending_pools")
      .select("id")
      .eq("status", "active")
      .limit(1);

    if (!pools || pools.length === 0) {
      return NextResponse.json({ error: "No active lending pools" }, { status: 400 });
    }

    const poolId = pools[0].id;

    // ── 5. Calculate APR based on loan amount ─────────────────────────────────
    let aprBps = 1500; // 15% default
    if (amount > 2000) aprBps = 1000; // 10%
    else if (amount > 1000) aprBps = 1200; // 12%

    // ── 6. Create the loan record ─────────────────────────────────────────────
    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .insert({
        borrower_id: user.id,
        pool_id: poolId,
        principal_amount: amount,
        apr_bps: aprBps,
        duration_days: Number(durationDays),
        status: "requested",
      })
      .select()
      .single();

    if (loanError) {
      return NextResponse.json({ error: loanError.message }, { status: 500 });
    }

    return NextResponse.json({ loan }, { status: 201 });
  } catch (error) {
    console.error("Loan application error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
