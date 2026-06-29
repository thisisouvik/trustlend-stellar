import { NextRequest, NextResponse } from "next/server";
import { getServiceRoleClient } from "@/lib/supabase/server";

// Helper function to get credit tier based on score
function getReputationTier(score: number): string {
  if (score >= 750) return "Platinum";
  if (score >= 500) return "Gold";
  if (score >= 300) return "Silver";
  return "Bronze";
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const address = searchParams.get("address")?.trim();

    if (!address) {
      return NextResponse.json({ error: "wallet address is required" }, { status: 400 });
    }

    const supabase = getServiceRoleClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database service unavailable" }, { status: 500 });
    }

    // 1. Fetch user profile by wallet_address to get user_id
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, full_name, wallet_address")
      .eq("wallet_address", address)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 500 });
    }

    if (!profile) {
      return NextResponse.json({ error: "Borrower profile not found for this address" }, { status: 404 });
    }

    // 2. Fetch reputation snapshot
    const { data: reputation, error: reputationError } = await supabase
      .from("reputation_snapshots")
      .select("score_total, updated_at")
      .eq("user_id", profile.id)
      .maybeSingle();

    if (reputationError) {
      return NextResponse.json({ error: reputationError.message }, { status: 500 });
    }

    const score = reputation?.score_total ?? 250; // default initial score is 250
    const tier = getReputationTier(score);
    const limit = score * 10; // credit limit is score * 10

    // 3. Fetch reputation history events
    const { data: history, error: historyError } = await supabase
      .from("reputation_events")
      .select("id, event_type, points, description, created_at")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (historyError) {
      return NextResponse.json({ error: historyError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      address: profile.wallet_address,
      borrower_name: profile.full_name,
      reputation: {
        score,
        tier,
        limit_xlm: limit,
        updated_at: reputation?.updated_at || null
      },
      history: history || []
    }, { status: 200 });

  } catch (_error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
