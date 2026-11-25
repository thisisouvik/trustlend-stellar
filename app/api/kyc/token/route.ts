import { redirect } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getDashboardPath } from "@/lib/auth/roles";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";
import { createApplicant, getApplicantId, generateSdkToken } from "@/lib/kyc/provider";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * POST /api/kyc/token
 *
 * Returns a short-lived SumSub Web SDK token so the browser can
 * initialise the KYC iframe without exposing server credentials.
 * Available to both borrowers and lenders (lender compliance, issue #262).
 *
 * Flow:
 *  1. Authenticate the user via session cookie (borrower or lender)
 *  2. Look up or create a SumSub applicant for this user
 *  3. Persist the applicantId on profiles.kyc_provider_id
 *  4. Generate a short-lived SDK token
 *  5. Return { applicantId, token, expiresAt } to the browser
 */
export async function POST(request: NextRequest) {
  try {
    // ── 0. Rate limit ────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const { user, role } = await requireAuthenticatedUser();

    // Borrowers and lenders self-verify. Admins are internal staff and are
    // routed to their own dashboard instead of the customer KYC flow.
    if (role === "admin") {
      redirect(getDashboardPath(role));
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // ── 2. Load profile ──────────────────────────────────────────────────────
    const [profile] = await db
      .select({ fullName: profiles.fullName, kycProviderId: profiles.kycProviderId, kycStatus: profiles.kycStatus })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    const fullName = String(profile?.fullName ?? "").trim() || "Unknown";
    const existingApplicantId = profile?.kycProviderId ?? null;

    // Don't re-create for already verified users — just return a refresh token
    let applicantId = existingApplicantId;

    if (!applicantId) {
      // Try to find an existing applicant by externalUserId in the provider
      const foundId = await getApplicantId(user.id);
      applicantId = foundId ?? await createApplicant(
        user.id,
        user.email ?? "",
        fullName
      );

      // Persist the applicantId on the caller's profile
      await db
        .update(profiles)
        .set({
          kycProviderId: applicantId,
          kycStatus: profile?.kycStatus === "pending" ? "submitted" : profile?.kycStatus,
          kycSubmittedAt: new Date(),
        })
        .where(eq(profiles.id, user.id));
    }

    // ── 3. Generate SDK token ────────────────────────────────────────────────
    const tokenResult = await generateSdkToken(applicantId!, user.id);

    return NextResponse.json(tokenResult, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[KYC Token] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate KYC token" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/kyc/token — return current KYC status for the authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    // ── 0. Rate limit ────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { user } = await requireAuthenticatedUser();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const [profile] = await db
      .select({
        kycStatus: profiles.kycStatus,
        kycProviderId: profiles.kycProviderId,
        kycSubmittedAt: profiles.kycSubmittedAt,
        kycVerifiedAt: profiles.kycVerifiedAt,
        kycRejectionReason: profiles.kycRejectionReason,
        regulatedPoolAccess: profiles.regulatedPoolAccess,
      })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    return NextResponse.json({
      kycStatus: profile?.kycStatus ?? "pending",
      applicantId: profile?.kycProviderId ?? null,
      submittedAt: profile?.kycSubmittedAt ? profile.kycSubmittedAt.toISOString() : null,
      verifiedAt: profile?.kycVerifiedAt ? profile.kycVerifiedAt.toISOString() : null,
      rejectionReason: profile?.kycRejectionReason ?? null,
      regulatedPoolAccess: profile?.regulatedPoolAccess ?? false,
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
