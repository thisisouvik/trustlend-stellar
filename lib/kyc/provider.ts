/**
 * KYC provider adapter — SumSub implementation.
 *
 * All external API calls are isolated here so switching providers
 * only requires editing this one file.
 *
 * Environment variables required (server-side only):
 *   SUMSUB_APP_TOKEN      – SumSub App Token
 *   SUMSUB_SECRET_KEY     – SumSub Secret Key (for request signing)
 *   SUMSUB_WEBHOOK_SECRET – HMAC secret for verifying webhook payloads
 *   SUMSUB_BASE_URL       – e.g. https://api.sumsub.com (optional, defaults provided)
 *   SUMSUB_LEVEL_NAME     – verification level name (default: "basic-kyc-level")
 */

import crypto from "crypto";
import type {
  KycApplicantResult,
  KycProviderConfig,
  KycStatus,
  SumSubWebhookPayload,
} from "./types";

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig(): KycProviderConfig {
  return {
    appToken: process.env.SUMSUB_APP_TOKEN ?? "",
    secretKey: process.env.SUMSUB_SECRET_KEY ?? "",
    webhookSecret: process.env.SUMSUB_WEBHOOK_SECRET ?? "",
    baseUrl: process.env.SUMSUB_BASE_URL ?? "https://api.sumsub.com",
    levelName: process.env.SUMSUB_LEVEL_NAME ?? "basic-kyc-level",
  };
}

function isConfigured(): boolean {
  const { appToken, secretKey } = getConfig();
  return Boolean(appToken && secretKey);
}

// ── Request signing (SumSub requires HMAC-signed requests) ────────────────────

function buildSignedHeaders(
  method: string,
  path: string,
  body: string,
  config: KycProviderConfig
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const data = ts + method.toUpperCase() + path + body;
  const signature = crypto
    .createHmac("sha256", config.secretKey)
    .update(data)
    .digest("hex");

  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-App-Token": config.appToken,
    "X-App-Access-Ts": ts,
    "X-App-Access-Sig": signature,
  };
}

async function sumsubFetch<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const config = getConfig();
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = buildSignedHeaders(method, path, bodyStr, config);

  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers,
    ...(body ? { body: bodyStr } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SumSub API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a SumSub applicant for the given user.
 * Returns the SumSub applicantId.
 *
 * In test/dev mode (env vars not set) returns a deterministic fake ID
 * so the UI still works during development.
 */
export async function createApplicant(
  userId: string,
  email: string,
  fullName: string
): Promise<string> {
  if (!isConfigured()) {
    // Dev/test mode — return stable fake ID
    return `dev-applicant-${userId.slice(0, 8)}`;
  }

  const config = getConfig();
  const path = `/resources/applicants?levelName=${encodeURIComponent(config.levelName)}`;
  const body = {
    externalUserId: userId,
    email,
    fixedInfo: { firstName: fullName.split(" ")[0], lastName: fullName.split(" ").slice(1).join(" ") || "" },
  };

  const result = await sumsubFetch<{ id: string }>("POST", path, body);
  return result.id;
}

/**
 * Retrieve an existing applicant ID by externalUserId (our user UUID).
 * Returns null if not found.
 */
export async function getApplicantId(userId: string): Promise<string | null> {
  if (!isConfigured()) {
    return null;
  }

  try {
    const path = `/resources/applicants/-;externalUserId=${encodeURIComponent(userId)}/one`;
    const result = await sumsubFetch<{ id: string }>("GET", path);
    return result.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Generate a short-lived Web SDK token for the given applicant.
 * The browser uses this to initialise the SumSub iframe.
 *
 * In dev mode returns a fake token so the UI can render a demo state.
 */
export async function generateSdkToken(
  applicantId: string,
  userId: string
): Promise<KycApplicantResult> {
  if (!isConfigured()) {
    return {
      applicantId,
      token: `dev-sdk-token-${userId.slice(0, 8)}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  const path = `/resources/accessTokens?userId=${encodeURIComponent(userId)}&levelName=${encodeURIComponent(getConfig().levelName)}`;
  const result = await sumsubFetch<{ token: string; userId: string }>(
    "POST",
    path
  );

  return {
    applicantId,
    token: result.token,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/**
 * Verify the HMAC-SHA256 digest sent by SumSub on every webhook POST.
 * Returns true if the signature is valid.
 */
export function verifyWebhookSignature(
  rawBody: string,
  digestHeader: string
): boolean {
  const { webhookSecret } = getConfig();
  if (!webhookSecret) {
    if (process.env.NODE_ENV === "development") {
      // Allow local webhook development without configuring SumSub credentials.
      console.warn("[KYC] SUMSUB_WEBHOOK_SECRET is not set — skipping signature verification in development");
      return true;
    }
    console.error("[KYC] SUMSUB_WEBHOOK_SECRET is not set — rejecting webhook");
    return false;
  }

  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digestHeader, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Map a SumSub webhook payload to our internal KycStatus.
 */
export function mapProviderStatus(payload: SumSubWebhookPayload): KycStatus {
  switch (payload.type) {
    case "applicantCreated":
    case "applicantPending":
      return "submitted";

    case "applicantReviewed": {
      const answer = payload.reviewResult?.reviewAnswer;
      if (answer === "GREEN") return "verified";
      if (answer === "RED") {
        const retryable = payload.reviewResult?.reviewRejectType === "RETRY";
        return retryable ? "submitted" : "rejected";
      }
      return "submitted";
    }

    case "applicantOnHold":
      return "submitted";

    default:
      return "submitted";
  }
}

/**
 * Extract a human-readable rejection reason from the webhook payload.
 */
export function extractRejectionReason(
  payload: SumSubWebhookPayload
): string | null {
  if (payload.reviewResult?.reviewAnswer !== "RED") return null;
  const labels = payload.reviewResult?.rejectLabels ?? [];
  const comment = payload.reviewResult?.moderationComment ?? payload.reviewResult?.clientComment ?? "";
  const parts = [...labels, ...(comment ? [comment] : [])];
  return parts.length > 0 ? parts.join("; ") : "Document does not meet requirements";
}
