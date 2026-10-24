import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db/client";
import { normalizeReferralCode } from "@/lib/referrals/codes";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { isBoundedString } from "@/lib/http/request-validation";

async function runInTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (typeof (db as { transaction?: unknown }).transaction === "function") {
    return db.transaction(async (tx) => fn(tx as unknown as Db));
  }
  return fn(db);
}

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("referrals_referee_id_key") ||
    message.includes("referrals_referee_id_unique") ||
    message.includes("duplicate key value")
  );
}

/**
 * POST /api/referrals/claim
 *
 * Attributes the signed-in user to the referrer behind `code` (Issue #266, #432).
 * Called once, right after a user signs up through an invite link.
 *
 * Attribution is deliberately server-side, atomic, and idempotent:
 *   • Executes inside an atomic `db.transaction()` with an advisory / row lock
 *     so concurrent claims for the same referee cannot race
 *   • record_referral() runs in SQL with the caller id taken from the session,
 *     so the referee cannot forge a row
 *   • the unique constraint on referee_id makes a double submit a no-op / 409
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
    const db = getDb();
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

    let row: { referral_id?: string; status?: string } | undefined;
    try {
      row = await runInTransaction(db, async (tx) => {
        const result = await tx.execute(
          sql`select referral_id, referrer_id, status from public.record_referral(${user.id}::uuid, ${code}::text)`,
        );
        return result.rows[0] as { referral_id?: string; status?: string } | undefined;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return NextResponse.json(
          { error: "Referral has already been claimed for this account" },
          { status: 409 },
        );
      }
      const message = error instanceof Error ? error.message : "";
      // Map the SQL guards onto meaningful status codes rather than a blanket
      // 500 — an unknown code is a client mistake, not a server fault.
      if (message.includes("Unknown referral code")) {
        return NextResponse.json(
          { error: "That referral code does not exist" },
          { status: 404 },
        );
      }
      if (message.includes("Cannot refer yourself")) {
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
        referralId: row?.referral_id ? String(row.referral_id) : null,
        status: String(row?.status ?? "pending"),
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
