import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { and, eq, sql } from "drizzle-orm";
import { requireApiAdmin, UnauthorizedError } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import { platformSettings } from "@/lib/db/schema";
import {
  MIN_SETTING_NOTES_LENGTH,
  PLATFORM_SETTING_KEYS,
  SETTING_DEFINITIONS,
  getPlatformSetting,
  getPlatformSettingHistory,
  isPlatformSettingKey,
  validateSettingValue,
  type PlatformSetting,
  type PlatformSettingKey,
} from "@/lib/platform/settings";

/**
 * GET  /api/admin/platform-settings — active values, history, bounds.
 * POST /api/admin/platform-settings — publish a new value for one key.
 *
 * Admin-only (issue #324). Replaces the hardcoded 1% platform fee that lived in
 * app/api/loans/repay/route.ts.
 *
 * Publishing is append-only: the previous active row for the key is deactivated
 * and a new row inserted at `version + 1`. Loans already outstanding are NOT
 * touched — each carries the fee it was originated under in
 * `loans.metadata.platform_fee_bps` — so a change here only affects loans
 * created from this point on.
 */

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await enforceRouteRateLimit(request);
    if (rateLimit) return rateLimit;

    await requireApiAdmin();

    const db = getDb();
    const active: Record<string, PlatformSetting> = {};
    let usingFallbackDefaults = false;

    for (const key of PLATFORM_SETTING_KEYS) {
      const setting = await getPlatformSetting(db, key);
      active[key] = setting;
      usingFallbackDefaults = usingFallbackDefaults || setting.usedFallback;
    }

    const history = await getPlatformSettingHistory(db, undefined, 25);

    return NextResponse.json(
      {
        success: true,
        data: { active, history },
        definitions: SETTING_DEFINITIONS,
        // True when the table is unreachable or unseeded and the routes are
        // charging the built-in defaults.
        usingFallbackDefaults,
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
    console.error("Failed to fetch platform settings:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch platform settings" },
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
        { success: false, error: "Database unavailable — cannot publish setting changes" },
        { status: 503 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const settingKey = String(body.settingKey ?? body.setting_key ?? "");
    if (!isPlatformSettingKey(settingKey)) {
      return NextResponse.json(
        {
          success: false,
          error: `settingKey must be one of: ${PLATFORM_SETTING_KEYS.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (notes.length < MIN_SETTING_NOTES_LENGTH) {
      return NextResponse.json(
        {
          success: false,
          error: `A rationale of at least ${MIN_SETTING_NOTES_LENGTH} characters is required for setting changes`,
        },
        { status: 400 }
      );
    }

    const valueBps = Number(body.valueBps ?? body.value_bps);
    const validation = validateSettingValue(settingKey as PlatformSettingKey, valueBps);
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // Highest version ever published for this key, active or not, so versions
    // stay monotonic and the unique (setting_key, version) index never collides.
    const [latest] = await db
      .select({ maxVersion: sql<number>`coalesce(max(${platformSettings.version}), 0)` })
      .from(platformSettings)
      .where(eq(platformSettings.settingKey, settingKey));

    const nextVersion = Number(latest?.maxVersion ?? 0) + 1;

    // Deactivate first: the partial unique index allows only one active row per
    // key, so the insert below would be rejected otherwise.
    await db
      .update(platformSettings)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(eq(platformSettings.settingKey, settingKey), eq(platformSettings.isActive, true))
      );

    const [inserted] = await db
      .insert(platformSettings)
      .values({
        settingKey,
        version: nextVersion,
        isActive: true,
        valueBps: Math.round(valueBps),
        notes,
        updatedBy: user.id,
        updatedByEmail: user.email ?? null,
      })
      .returning();

    const active: Record<string, PlatformSetting> = {};
    for (const key of PLATFORM_SETTING_KEYS) {
      active[key] = await getPlatformSetting(db, key);
    }
    const history = await getPlatformSettingHistory(db, undefined, 25);

    const definition = SETTING_DEFINITIONS[settingKey as PlatformSettingKey];

    return NextResponse.json(
      {
        success: true,
        message:
          `Published ${definition.label} v${nextVersion} at ${(valueBps / 100).toFixed(2)}%. ` +
          `Existing loans keep the fee they were originated under.`,
        published: inserted,
        data: { active, history },
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
    console.error("Failed to publish platform setting:", error);
    return NextResponse.json(
      { success: false, error: "Failed to publish platform setting" },
      { status: 500 }
    );
  }
}
