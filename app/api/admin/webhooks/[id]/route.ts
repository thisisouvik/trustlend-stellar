import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireApiAdmin, UnauthorizedError } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { webhookEndpoints } from "@/lib/db/schema";
import { serializeWebhook } from "@/lib/webhooks/serialize";
import { enforceRouteRateLimit } from "@/lib/rate-limit";

const patchWebhookSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  url: z.string().url("Must be a valid URL").startsWith("https://", "Webhook URLs must use HTTPS").optional(),
  platform: z.enum(["discord", "telegram", "slack", "custom"]).optional(),
  topic: z.string().min(1, "Topic is required").optional(),
  is_active: z.boolean().optional(),
});

async function guard() {
  try {
    await requireApiAdmin();
    const db = getDb();
    if (!db) {
      return { error: NextResponse.json({ error: "Database not configured" }, { status: 500 }) };
    }
    return { db };
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  const { id } = await params;
  const g = await guard();
  if ("error" in g) return g.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  const { is_active, ...rest } = parsed.data;
  const [row] = await g.db
    .update(webhookEndpoints)
    .set({ ...rest, ...(is_active !== undefined ? { isActive: is_active } : {}) })
    .where(eq(webhookEndpoints.id, id))
    .returning();

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ webhook: serializeWebhook(row) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  const { id } = await params;
  const g = await guard();
  if ("error" in g) return g.error;

  await g.db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));

  return NextResponse.json({ success: true });
}
