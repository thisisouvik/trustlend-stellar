import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { referrals } from "@/lib/db/schema";
import { buildReferralLink } from "@/lib/referrals/codes";
import { resolveSiteUrl } from "@/lib/referrals/site-url";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * GET /api/referrals
 *
 * Returns the signed-in user's referral link plus their programme stats
 * (Issue #266). The code is created on demand via ensure_referral_code(), so a
 * user who predates the referral migration gets one on first visit rather than
 * seeing an empty state. Claims are intentionally handled by the transactional
 * POST endpoint, not by this read-oriented endpoint.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // Guarantees a code exists before we try to build a link from it.
    const codeResult = await db.execute(
      sql`select public.ensure_referral_code(${user.id}::uuid) as code`,
    );
    const code = (codeResult.rows[0] as { code?: string } | undefined)?.code;

    if (!code) {
      console.error("Referral code assignment failed for", user.id);
      return NextResponse.json(
        { error: "Could not prepare your referral code" },
        { status: 500 },
      );
    }

    const [stats] = await db
      .select({
        total_invited: sql<number>`count(*)::int`,
        pending_count: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
        qualified_count: sql<number>`count(*) filter (where ${referrals.status} = 'qualified')::int`,
        paid_count: sql<number>`count(*) filter (where ${referrals.status} = 'paid')::int`,
        total_earned: sql<string>`coalesce(sum(${referrals.bonusAmount}) filter (where ${referrals.status} = 'paid'), 0)`,
      })
      .from(referrals)
      .where(eq(referrals.referrerId, user.id));

    const invited = await db
      .select({
        id: referrals.id,
        status: referrals.status,
        bonus_amount: referrals.bonusAmount,
        created_at: referrals.createdAt,
        qualified_at: referrals.qualifiedAt,
        paid_at: referrals.paidAt,
      })
      .from(referrals)
      .where(eq(referrals.referrerId, user.id))
      .orderBy(desc(referrals.createdAt))
      .limit(50);

    return NextResponse.json(
      {
        referralCode: String(code),
        referralLink: buildReferralLink(String(code), resolveSiteUrl(request)),
        stats: {
          totalInvited: Number(stats?.total_invited ?? 0),
          pending: Number(stats?.pending_count ?? 0),
          qualified: Number(stats?.qualified_count ?? 0),
          paid: Number(stats?.paid_count ?? 0),
          totalEarned: Number(stats?.total_earned ?? 0),
        },
        referrals: invited.map((r) => ({
          id: r.id,
          status: r.status,
          bonusAmount: Number(r.bonus_amount ?? 0),
          invitedAt: r.created_at.toISOString(),
          qualifiedAt: r.qualified_at ? r.qualified_at.toISOString() : null,
          paidAt: r.paid_at ? r.paid_at.toISOString() : null,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Referral fetch error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
