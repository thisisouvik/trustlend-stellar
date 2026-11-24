import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getPooledDb } from "@/lib/db/client";
import { normalizeReferralCode } from "@/lib/referrals/codes";
import {
  readReferralClaim,
  referralClaimErrorStatus,
  referralClaimStatement,
} from "@/lib/referrals/claim";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { isBoundedString } from "@/lib/http/request-validation";

/**
 * POST /api/referrals/claim
 *
 * Attributes the signed-in user to the referrer behind `code` (Issue #266).
 * Called once, right after a user signs up through an invite link.
 *
 * Attribution is deliberately server-side and idempotent:
 *   • record_referral() runs in SQL with the caller id taken from the session,
 *     so the referee cannot forge a row
 *   • the unique constraint on referee_id makes a double submit a no-op
 *   • self-referral is rejected in SQL as well as here
 *
 * Body: { code: string }
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser();
    // The HTTP client cannot start interactive transactions. Referral claims
    // use the pooled client so their SQL validation and insert share one
    // transaction, including when different links are claimed concurrently.
    const db = getPooledDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const body = await request.json().catch(() => ({}));
    const rawCode = (body as { code?: unknown }).code;
    if (!isBoundedString(rawCode, 64)) {
      return NextResponse.json(
        { error: "A valid referral code is required" },
        { status: 400 },
      );
    }
    const code = normalizeReferralCode(rawCode);

    if (!code) {
      return NextResponse.json(
        { error: "A valid referral code is required" },
        { status: 400 },
      );
    }

    let claim: ReturnType<typeof readReferralClaim>;
    try {
      const result = await db.transaction((tx) =>
        tx.execute(referralClaimStatement(user.id, code)),
      );
      claim = readReferralClaim(result.rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const errorStatus = referralClaimErrorStatus(error);
      // Map the SQL guards onto meaningful status codes rather than a blanket
      // 500 — an unknown code is a client mistake, not a server fault.
      if (errorStatus === 404) {
        return NextResponse.json(
          { error: "That referral code does not exist" },
          { status: 404 },
        );
      }
      if (errorStatus === 409) {
        return NextResponse.json(
          { error: "You cannot use your own referral link" },
          { status: 409 },
        );
      }
      console.error("Referral claim failed:", message);
      return NextResponse.json(
        { error: "Could not record your referral" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        referralId: claim.referralId,
        status: claim.status,
        message:
          "Referral recorded. Your friend earns their bonus once your first loan is funded.",
      },
      { status: 200 },
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Referral claim error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
