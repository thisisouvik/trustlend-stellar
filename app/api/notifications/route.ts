import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";
import { enforceRouteRateLimit } from "@/lib/rate-limit";

const DEFAULT_NOTIFICATIONS_LIMIT = 20;
const MAX_NOTIFICATIONS_LIMIT = 50;

function parsePaginationParams(searchParams: URLSearchParams): {
  limit: number;
  offset: number;
} {
  const rawLimit = searchParams.get("limit");
  const parsedLimit =
    rawLimit !== null && rawLimit.trim() !== ""
      ? Number.parseInt(rawLimit, 10)
      : DEFAULT_NOTIFICATIONS_LIMIT;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(1, parsedLimit), MAX_NOTIFICATIONS_LIMIT)
    : DEFAULT_NOTIFICATIONS_LIMIT;

  const rawOffset = searchParams.get("offset");
  const parsedOffset =
    rawOffset !== null && rawOffset.trim() !== ""
      ? Number.parseInt(rawOffset, 10)
      : 0;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;

  return { limit, offset };
}

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "DB unavailable" }, { status: 503 });
    }

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { limit, offset } = parsePaginationParams(request.nextUrl.searchParams);

    let query = db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    if (offset > 0) {
      query = query.offset(offset) as typeof query;
    }

    const rows = await query;

    // Keep the snake_case wire format the NotificationWidget expects.
    const data = rows.map((n) => ({
      id: n.id,
      user_id: n.userId,
      title: n.title,
      message: n.message,
      type: n.type,
      read: n.read,
      created_at: n.createdAt.toISOString(),
    }));

    return NextResponse.json(
      { notifications: data, pagination: { limit, offset } },
      { status: 200, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
