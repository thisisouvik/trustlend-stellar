import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("lender");
    const { positionId, amount } = await request.json();

    if (!positionId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: "Amount exceeds maximum allowed" }, { status: 400 });
    }

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Get position and verify ownership
    const { data: position, error: positionError } = await supabase
      .from("pool_positions")
      .select("id, pool_id, principal_amount, withdrawn_amount")
      .eq("id", positionId)
      .eq("lender_id", user.id)
      .eq("status", "active")
      .single();

    if (positionError || !position) {
      return NextResponse.json({ error: "Position not found" }, { status: 404 });
    }

    if (amount > position.principal_amount) {
      return NextResponse.json(
        { error: "Withdrawal amount exceeds principal" },
        { status: 400 }
      );
    }

    // Get pool
    const { data: pool, error: poolError } = await supabase
      .from("lending_pools")
      .select("id, total_liquidity, available_liquidity")
      .eq("id", position.pool_id)
      .single();

    if (poolError || !pool) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    if (amount > pool.available_liquidity) {
      return NextResponse.json(
        { error: "Insufficient liquidity in pool for withdrawal" },
        { status: 400 }
      );
    }

    // Update position
    const newPrincipal = position.principal_amount - amount;
    const { error: updateError } = await supabase
      .from("pool_positions")
      .update({
        principal_amount: newPrincipal,
        withdrawn_amount: (position.withdrawn_amount || 0) + amount,
        status: newPrincipal === 0 ? "closed" : "active",
        closed_at: newPrincipal === 0 ? new Date().toISOString() : null,
      })
      .eq("id", positionId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Update pool liquidity
    const { error: poolUpdateError } = await supabase
      .from("lending_pools")
      .update({
        total_liquidity: pool.total_liquidity - amount,
        available_liquidity: pool.available_liquidity - amount,
      })
      .eq("id", position.pool_id);

    if (poolUpdateError) {
      return NextResponse.json({ error: poolUpdateError.message }, { status: 500 });
    }

    // Record transaction
    await supabase.from("ledger_transactions").insert({
      user_id: user.id,
      category: "withdrawal",
      amount: amount,
      currency: "XLM",
      status: "confirmed",
      ref_type: "pool_position",
      ref_id: positionId,
    });

    return NextResponse.json(
      { message: "Withdrawal successful", withdrawalAmount: amount },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Withdrawal error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
