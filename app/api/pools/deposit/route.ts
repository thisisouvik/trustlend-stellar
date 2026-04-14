import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("lender");
    const { poolId, amount } = await request.json();

    if (!poolId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: "Amount exceeds maximum allowed" }, { status: 400 });
    }

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Verify pool exists and is active
    const { data: pool, error: poolError } = await supabase
      .from("lending_pools")
      .select("id, status, total_liquidity, available_liquidity")
      .eq("id", poolId)
      .eq("status", "active")
      .single();

    if (poolError || !pool) {
      return NextResponse.json({ error: "Pool not found or inactive" }, { status: 404 });
    }

    // Create or update pool position
    const { data: existingPosition } = await supabase
      .from("pool_positions")
      .select("id")
      .eq("pool_id", poolId)
      .eq("lender_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    let position;
    if (existingPosition) {
      // Update existing position
      const { data: currentPosition } = await supabase
        .from("pool_positions")
        .select("principal_amount")
        .eq("id", existingPosition.id)
        .single();

      const { data: updated, error: updateError } = await supabase
        .from("pool_positions")
        .update({
          principal_amount: (currentPosition?.principal_amount ?? 0) + amount,
        })
        .eq("id", existingPosition.id)
        .select()
        .single();

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
      position = updated;
    } else {
      // Create new position
      const { data: newPosition, error: insertError } = await supabase
        .from("pool_positions")
        .insert({
          pool_id: poolId,
          lender_id: user.id,
          principal_amount: amount,
          status: "active",
        })
        .select()
        .single();

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
      position = newPosition;
    }

    // Update pool liquidity
    const { error: poolUpdateError } = await supabase
      .from("lending_pools")
      .update({
        total_liquidity: pool.total_liquidity + amount,
        available_liquidity: pool.available_liquidity + amount,
      })
      .eq("id", poolId);

    if (poolUpdateError) {
      return NextResponse.json({ error: poolUpdateError.message }, { status: 500 });
    }

    // Record transaction
    await supabase.from("ledger_transactions").insert({
      user_id: user.id,
      category: "deposit",
      amount: amount,
      currency: "XLM",
      status: "confirmed",
      ref_type: "pool_position",
      ref_id: position.id,
    });

    return NextResponse.json({ position }, { status: 201 });
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Deposit error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
