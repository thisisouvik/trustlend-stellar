import { NextRequest, NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabase/server";

/**
 * POST /api/pools/deposit
 *
 * Body: { poolId, amount, txHash, lenderAddress }
 *
 * Flow:
 *   1. Lender signs a real Stellar payment tx in Freighter (client-side)
 *   2. Client passes the confirmed tx hash here
 *   3. We verify the tx hash is non-empty, then record the position
 *
 * Using direct supabase.auth.getUser() to return JSON on auth failure
 * instead of calling requireAuthenticatedUser which redirect()s → 307 HTML.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { poolId, amount, txHash, lenderAddress } = body as {
      poolId: string;
      amount: number;
      txHash?: string;
      lenderAddress?: string;
    };

    if (!poolId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: "Amount exceeds maximum allowed" }, { status: 400 });
    }

    // Require a real Stellar tx hash — no ghost deposits
    if (!txHash || txHash.trim().length < 10) {
      return NextResponse.json(
        { error: "A confirmed Stellar transaction hash is required" },
        { status: 400 }
      );
    }

    // Prevent duplicate recording of the same tx
    const { data: existingTx } = await supabase
      .from("ledger_transactions")
      .select("id")
      .eq("metadata->>txHash", txHash)
      .maybeSingle();

    if (existingTx) {
      return NextResponse.json(
        { error: "This transaction has already been recorded" },
        { status: 409 }
      );
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

    // Upsert pool position (add to existing or create new)
    const { data: existingPosition } = await supabase
      .from("pool_positions")
      .select("id, principal_amount")
      .eq("pool_id", poolId)
      .eq("lender_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    let position;
    if (existingPosition) {
      const { data: updated, error: updateError } = await supabase
        .from("pool_positions")
        .update({
          principal_amount: Number(existingPosition.principal_amount ?? 0) + amount,
        })
        .eq("id", existingPosition.id)
        .select()
        .single();

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
      position = updated;
    } else {
      const { data: newPosition, error: insertError } = await supabase
        .from("pool_positions")
        .insert({
          pool_id: poolId,
          lender_id: user.id,
          principal_amount: amount,
          status: "active",
          opened_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
      position = newPosition;
    }

    // Update pool liquidity atomically
    const { error: poolUpdateError } = await supabase
      .from("lending_pools")
      .update({
        total_liquidity: Number(pool.total_liquidity ?? 0) + amount,
        available_liquidity: Number(pool.available_liquidity ?? 0) + amount,
      })
      .eq("id", poolId);

    if (poolUpdateError) {
      return NextResponse.json({ error: poolUpdateError.message }, { status: 500 });
    }

    // Record ledger entry with tx hash for on-chain verification
    await supabase.from("ledger_transactions").insert({
      user_id: user.id,
      category: "deposit",
      amount,
      currency: "XLM",
      status: "confirmed",
      ref_type: "pool_position",
      ref_id: position.id,
      metadata: JSON.stringify({
        txHash,
        lenderAddress: lenderAddress ?? null,
        poolId,
      }),
    });

    return NextResponse.json(
      {
        position,
        txHash,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Deposit error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
