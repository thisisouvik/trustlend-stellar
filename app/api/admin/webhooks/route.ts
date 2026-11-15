import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { requireApiAdmin, UnauthorizedError } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { webhookEndpoints } from "@/lib/db/schema";
import { serializeWebhook } from "@/lib/webhooks/serialize";
import { enforceRouteRateLimit } from "@/lib/rate-limit";

const webhookSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Must be a valid URL").startsWith("https://", "Webhook URLs must use HTTPS"),
  platform: z.enum(["discord", "telegram", "slack", "custom"]),
  topic: z.string().min(1, "Topic is required"),
});

async function guard() {
  try {
    const user = await requireApiAdmin();
    const db = getDb();
    if (!db) {
      return { error: NextResponse.json({ error: "Database not configured" }, { status: 500 }) };
    }
    return { user, db };
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof UnauthorizedError) {
      const unauthenticated = err.message === "Not authenticated";
      return {
        error: NextResponse.json(
          { error: unauthenticated ? "Authentication required" : "Admin access required" },
          { status: unauthenticated ? 401 : 403 }
        ),
      };
    }
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 500 }) };
  }
}

export async function GET(request: NextRequest) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  const g = await guard();
  if ("error" in g) return g.error;

  const rows = await g.db.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt));
  return NextResponse.json({ webhooks: rows.map(serializeWebhook) });
}

export async function POST(request: NextRequest) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  const g = await guard();
  if ("error" in g) return g.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  const [row] = await g.db
    .insert(webhookEndpoints)
    .values({
      name: parsed.data.name,
      url: parsed.data.url,
      platform: parsed.data.platform,
      topic: parsed.data.topic,
      isActive: true,
      createdBy: g.user.id,
    })
    .returning();

  return NextResponse.json({ webhook: serializeWebhook(row) }, { status: 201 });
}
