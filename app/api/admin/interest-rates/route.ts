import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { and, eq, sql } from "drizzle-orm";
import { requireApiAdmin, UnauthorizedError } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import { interestRateConfigs } from "@/lib/db/schema";
import {
  RATE_CONFIG_BOUNDS,
  getActiveRateConfigs,
  getRateConfigHistory,
  isRateModel,
  parseAmountTiers,
  parseReputationTiers,
  validateRateConfigDraft,
} from "@/lib/loans/rate-config";

/**
 * GET  /api/admin/interest-rates — active schedules, publish history, bounds.
 * POST /api/admin/interest-rates — publish a new schedule version.
 *
 * Admin-only (issue #321). Backs the rate editor at /dashboard/admin/rates and
 * replaces the APR ladder that used to be hardcoded in the loan apply route.
 *
 * Publishing is append-only: the previous active row for the rate model is
 * deactivated and a new row is inserted at `version + 1`. Existing loans keep
 * the `apr_bps` they were quoted at — nothing rewrites loan rows here — so a
 * rate change never retroactively reprices a pending loan.
 */

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await enforceRouteRateLimit(request);
    if (rateLimit) return rateLimit;

    await requireApiAdmin();

    const db = getDb();
    const { configs, usedFallback } = await getActiveRateConfigs(db);
    const history = await getRateConfigHistory(db, 25);

    return NextResponse.json(
      {
        success: true,
        data: { active: configs, history },
        bounds: RATE_CONFIG_BOUNDS,
        // True when the table is unreachable or unseeded and origination is
        // running on the code defaults — the dashboard warns on this.
        usingFallbackDefaults: usedFallback,
      },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof UnauthorizedError) {
      const unauthenticated = error.message === "Not authenticated";
      return NextResponse.json(
        {
          success: false,
          error: unauthenticated ? "Authentication required" : "Admin access required",
        },
        { status: unauthenticated ? 401 : 403 }
      );
    }
    console.error("Failed to fetch interest rate configs:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch interest rates" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await enforceRouteRateLimit(request);
    if (rateLimit) return rateLimit;

    const user = await requireApiAdmin();

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { success: false, error: "Database unavailable — cannot publish rate changes" },
        { status: 503 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const rateModel = String(body.rateModel ?? body.rate_model ?? "").toLowerCase();
    if (!isRateModel(rateModel)) {
      return NextResponse.json(
        { success: false, error: "rateModel must be 'fixed' or 'floating'" },
        { status: 400 }
      );
    }

    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (notes.length < RATE_CONFIG_BOUNDS.MIN_NOTES_LENGTH) {
      return NextResponse.json(
        {
          success: false,
          error: `A rationale of at least ${RATE_CONFIG_BOUNDS.MIN_NOTES_LENGTH} characters is required for rate changes`,
        },
        { status: 400 }
      );
    }

    const draft = {
      baseAprBps: Number(body.baseAprBps ?? body.base_apr_bps),
      minAprBps: Number(body.minAprBps ?? body.min_apr_bps ?? 0),
      maxAprBps: Number(body.maxAprBps ?? body.max_apr_bps ?? RATE_CONFIG_BOUNDS.MAX_APR_BPS),
      amountTiers: parseAmountTiers(body.amountTiers ?? body.amount_tiers ?? []),
      reputationTiers: parseReputationTiers(body.reputationTiers ?? body.reputation_tiers ?? []),
    };

    // Reject payloads whose tiers were partly dropped by the lenient parsers —
    // an admin typo must surface as an error, not a silently different schedule.
    const submittedAmountTiers = body.amountTiers ?? body.amount_tiers ?? [];
    const submittedReputationTiers = body.reputationTiers ?? body.reputation_tiers ?? [];
    if (
      (Array.isArray(submittedAmountTiers) &&
        submittedAmountTiers.length !== draft.amountTiers.length) ||
      (Array.isArray(submittedReputationTiers) &&
        submittedReputationTiers.length !== draft.reputationTiers.length)
    ) {
      return NextResponse.json(
        { success: false, error: "One or more tiers were malformed — check every threshold and rate" },
        { status: 400 }
      );
    }

    const validation = validateRateConfigDraft(draft);
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // Highest version ever published for this model, active or not, so versions
    // stay monotonic and the unique (rate_model, version) index never collides.
    const [latest] = await db
      .select({ maxVersion: sql<number>`coalesce(max(${interestRateConfigs.version}), 0)` })
      .from(interestRateConfigs)
      .where(eq(interestRateConfigs.rateModel, rateModel));

    const nextVersion = Number(latest?.maxVersion ?? 0) + 1;

    // Deactivate first: the partial unique index allows only one active row per
    // model, so the insert below would be rejected otherwise.
    await db
      .update(interestRateConfigs)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(eq(interestRateConfigs.rateModel, rateModel), eq(interestRateConfigs.isActive, true))
      );

    const [inserted] = await db
      .insert(interestRateConfigs)
      .values({
        rateModel,
        version: nextVersion,
        isActive: true,
        baseAprBps: draft.baseAprBps,
        minAprBps: draft.minAprBps,
        maxAprBps: draft.maxAprBps,
        amountTiers: draft.amountTiers,
        reputationTiers: draft.reputationTiers,
        notes,
        updatedBy: user.id,
        updatedByEmail: user.email ?? null,
      })
      .returning();

    const { configs } = await getActiveRateConfigs(db);
    const history = await getRateConfigHistory(db, 25);

    return NextResponse.json(
      {
        success: true,
        message: `Published ${rateModel} rate schedule v${nextVersion}. Existing loans keep their locked APR.`,
        published: inserted,
        data: { active: configs, history },
      },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof UnauthorizedError) {
      const unauthenticated = error.message === "Not authenticated";
      return NextResponse.json(
        {
          success: false,
          error: unauthenticated ? "Authentication required" : "Admin access required",
        },
        { status: unauthenticated ? 401 : 403 }
      );
    }
    console.error("Failed to publish rate schedule:", error);
    return NextResponse.json(
      { success: false, error: "Failed to publish rate schedule" },
      { status: 500 }
    );
  }
}
