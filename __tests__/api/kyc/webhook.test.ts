import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import {
  mapProviderStatus,
  extractRejectionReason,
} from "@/lib/kyc/provider";
import type { SumSubWebhookPayload } from "@/lib/kyc/types";

import { createFakeDb, type FakeDb } from "../../helpers/fake-db";

// ── Mock only the database — the real provider signature/status mapping runs ──
const mockGetDb = vi.fn();
let db: FakeDb;

vi.mock("@/lib/db/client", () => ({
  getDb: () => mockGetDb(),
}));

import { POST, GET } from "@/app/api/kyc/webhook/route";

const WEBHOOK_SECRET = "test-webhook-secret";
const ORIGINAL_ENV = { ...process.env };

function digest(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function webhookRequest(body: string, digestHeader: string) {
  return new NextRequest("http://localhost/api/kyc/webhook", {
    method: "POST",
    headers: { "x-payload-digest": digestHeader },
    body,
  });
}

function reviewedPayload(overrides: Partial<SumSubWebhookPayload> = {}): SumSubWebhookPayload {
  return {
    applicantId: "appl-1",
    externalUserId: "user-1",
    type: "applicantReviewed",
    reviewStatus: "completed",
    reviewResult: { reviewAnswer: "GREEN" },
    ...overrides,
  };
}

/**
 * Queue the row counts the profile update(s) will report. The route updates
 * by user id first and falls back to the provider id when nothing matched.
 */
function primeUpdates(...matched: number[]) {
  db.reset();
  for (const n of matched) db.queue(Array.from({ length: n }, () => ({ id: "user-1" })));
}

/** The set({...}) payload of the first profile update. */
function firstUpdatePayload(): Record<string, unknown> {
  return (db.calls.find((c) => c.method === "set")?.args[0] ?? {}) as Record<string, unknown>;
}

function updateCount(): number {
  return db.calls.filter((c) => c.method === "update").length;
}

function seededReputation(): boolean {
  return db.calls.some((c) => c.method === "onConflictDoUpdate");
}

describe("POST /api/kyc/webhook", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    process.env.SUMSUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    db = createFakeDb();
    mockGetDb.mockReturnValue(db);
  });

  it("auto-updates the profile to verified on a GREEN review (AC2)", async () => {
    const body = JSON.stringify(reviewedPayload());
    primeUpdates(1);

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, status: "verified" });

    expect(updateCount()).toBe(1);
    const payload = firstUpdatePayload();
    expect(payload.kycStatus).toBe("verified");
    expect(payload.regulatedPoolAccess).toBe(true);
    expect(payload.kycProviderId).toBe("appl-1");
    expect(payload.kycVerifiedAt).toBeTruthy();
    expect(payload.kycRejectionReason).toBeNull();
    // Reputation snapshot seeded on first verification
    expect(seededReputation()).toBe(true);
  });

  it("marks the profile rejected with a reason on a FINAL RED review", async () => {
    const body = JSON.stringify(
      reviewedPayload({
        reviewResult: {
          reviewAnswer: "RED",
          reviewRejectType: "FINAL",
          rejectLabels: ["DOCUMENT_MISMATCH"],
          moderationComment: "ID does not match selfie",
        },
      })
    );
    primeUpdates(1);

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    const payload = firstUpdatePayload();
    expect(payload.kycStatus).toBe("rejected");
    expect(payload.regulatedPoolAccess).toBe(false);
    expect(payload.kycRejectionReason).toContain("DOCUMENT_MISMATCH");
    expect(seededReputation()).toBe(false);
  });

  it("keeps a RETRY rejection as submitted (resubmission allowed)", async () => {
    const body = JSON.stringify(
      reviewedPayload({
        reviewResult: { reviewAnswer: "RED", reviewRejectType: "RETRY" },
      })
    );
    primeUpdates(1);

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    const payload = firstUpdatePayload();
    expect(payload.kycStatus).toBe("submitted");
    expect(payload.regulatedPoolAccess).toBe(false);
  });

  it("marks pending applicants as submitted", async () => {
    const body = JSON.stringify(reviewedPayload({ type: "applicantPending" }));
    primeUpdates(1);

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    const payload = firstUpdatePayload();
    expect(payload.kycStatus).toBe("submitted");
    expect(payload.kycSubmittedAt).toBeTruthy();
  });

  it("rejects requests with an invalid signature (401) and never touches the DB", async () => {
    const body = JSON.stringify(reviewedPayload());

    const response = await POST(webhookRequest(body, "deadbeef"));

    expect(response.status).toBe(401);
    expect(updateCount()).toBe(0);
  });

  it("falls back to the provider-id lookup when the user-id update fails", async () => {
    const body = JSON.stringify(reviewedPayload());
    // the update by user id matches nothing → fallback update by provider id
    primeUpdates(0, 1);

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    expect(updateCount()).toBe(2);
  });

  it("returns 400 when applicantId or externalUserId is missing", async () => {
    const body = JSON.stringify({ type: "applicantReviewed" });

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(400);
    expect(updateCount()).toBe(0);
  });

  it("returns 400 on malformed JSON", async () => {
    const raw = "{not json";
    const response = await POST(webhookRequest(raw, digest(raw)));

    expect(response.status).toBe(400);
  });

  it("acknowledges the webhook (200) when the service client is unavailable", async () => {
    mockGetDb.mockReturnValue(null);
    const body = JSON.stringify(reviewedPayload());

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
  });

  it("accepts the webhook only in development when no webhook secret is configured", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    delete process.env.SUMSUB_WEBHOOK_SECRET;
    primeUpdates(1);
    const body = JSON.stringify(reviewedPayload());

    const response = await POST(webhookRequest(body, ""));

    expect(response.status).toBe(200);
  });

  it("rejects the webhook in production when no webhook secret is configured", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.SUMSUB_WEBHOOK_SECRET;
    const body = JSON.stringify(reviewedPayload());

    const response = await POST(webhookRequest(body, ""));

    expect(response.status).toBe(401);
    expect(updateCount()).toBe(0);
    expect(seededReputation()).toBe(false);
  });

  it("serves a health check on GET", async () => {
    const response = await GET(new NextRequest("http://localhost/api/kyc/webhook"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provider: "SumSub" });
  });
});

// ── Provider status mapping (pure) ────────────────────────────────────────────

describe("mapProviderStatus", () => {
  it("maps GREEN reviews to verified", () => {
    expect(mapProviderStatus(reviewedPayload())).toBe("verified");
  });

  it("maps FINAL RED reviews to rejected", () => {
    expect(
      mapProviderStatus(
        reviewedPayload({
          reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL" },
        })
      )
    ).toBe("rejected");
  });

  it("maps RETRY RED reviews back to submitted", () => {
    expect(
      mapProviderStatus(
        reviewedPayload({
          reviewResult: { reviewAnswer: "RED", reviewRejectType: "RETRY" },
        })
      )
    ).toBe("submitted");
  });

  it("maps created/pending/onHold events to submitted", () => {
    for (const type of ["applicantCreated", "applicantPending", "applicantOnHold"] as const) {
      expect(mapProviderStatus(reviewedPayload({ type }))).toBe("submitted");
    }
  });

  it("defaults unknown events to submitted", () => {
    expect(
      mapProviderStatus({ applicantId: "a", externalUserId: "u", type: "somethingElse" as never })
    ).toBe("submitted");
  });
});

describe("extractRejectionReason", () => {
  it("returns null for non-RED reviews", () => {
    expect(extractRejectionReason(reviewedPayload())).toBeNull();
  });

  it("joins labels and comments for RED reviews", () => {
    const reason = extractRejectionReason(
      reviewedPayload({
        reviewResult: {
          reviewAnswer: "RED",
          rejectLabels: ["DOCUMENT_MISMATCH", "SELFIE_MISMATCH"],
          moderationComment: "Blurry photo",
        },
      })
    );
    expect(reason).toContain("DOCUMENT_MISMATCH");
    expect(reason).toContain("Blurry photo");
  });

  it("returns a default message when no labels or comments exist", () => {
    const reason = extractRejectionReason(
      reviewedPayload({ reviewResult: { reviewAnswer: "RED" } })
    );
    expect(reason).toBe("Document does not meet requirements");
  });
});
