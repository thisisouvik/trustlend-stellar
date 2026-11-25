import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { profiles, reputationEvents, reputationSnapshots } from "@/lib/db/schema";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { TIER_INTEREST_BPS, TIER_MAX_LOAN } from "@/types/contracts";
import { offchainScoreToTier, STANDARD_BASE_APR_BPS } from "@/lib/reputation/scoring";
import { isValidStellarAddress } from "@/lib/http/request-validation";

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { searchParams } = request.nextUrl;
    const address = searchParams.get("address")?.trim();

    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: "A valid wallet address is required" }, { status: 400 });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database service unavailable" }, { status: 500 });
    }

    // 1. Fetch user profile by wallet_address to get user_id
    const [profile] = await db
      .select({ id: profiles.id, full_name: profiles.fullName, wallet_address: profiles.walletAddress })
      .from(profiles)
      .where(eq(profiles.walletAddress, address))
      .limit(1);

    if (!profile) {
      return NextResponse.json({ error: "Borrower profile not found for this address" }, { status: 404 });
    }

    // 2. Fetch reputation snapshot
    const [reputation] = await db
      .select({
        score_total: reputationSnapshots.scoreTotal,
        score_breakdown: reputationSnapshots.scoreBreakdown,
        updated_at: reputationSnapshots.updatedAt,
      })
      .from(reputationSnapshots)
      .where(eq(reputationSnapshots.userId, profile.id))
      .limit(1);

    const score = Number(reputation?.score_total ?? 250);
    const tier = offchainScoreToTier(score);
    const interestRateBps = TIER_INTEREST_BPS[tier] ?? STANDARD_BASE_APR_BPS;
    const rateDiscountBps = Math.max(0, STANDARD_BASE_APR_BPS - interestRateBps);
    const maxLoanStroops = TIER_MAX_LOAN[tier] ?? TIER_MAX_LOAN.None;
    const maxLoanXlm = Number(maxLoanStroops / 10_000_000n);

    // 3. Fetch reputation history events
    const historyRows = await db
      .select({
        id: reputationEvents.id,
        event_type: reputationEvents.sourceType,
        points: reputationEvents.pointsDelta,
        description: reputationEvents.reason,
        created_at: reputationEvents.createdAt,
      })
      .from(reputationEvents)
      .where(eq(reputationEvents.userId, profile.id))
      .orderBy(desc(reputationEvents.createdAt))
      .limit(10);
    const history = historyRows.map((h) => ({ ...h, created_at: h.created_at.toISOString() }));

    return NextResponse.json(
      {
        success: true,
        address: profile.wallet_address,
        borrower_name: profile.full_name,
        reputation: {
          score,
          tier: String(tier),
          interest_rate_pct: interestRateBps / 100,
          rate_discount_pct: rateDiscountBps / 100,
          limit_xlm: maxLoanXlm,
          breakdown: reputation?.score_breakdown || null,
          calculated_daily: true,
          updated_at: reputation?.updated_at ? reputation.updated_at.toISOString() : null,
        },
        history,
      },
      { status: 200 }
    );
  } catch (_error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
