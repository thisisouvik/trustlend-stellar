import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";

type WindowUnit = "s" | "m" | "h";
type WindowString = `${number} ${WindowUnit}`;

type RateLimitPolicy = {
  limit: number;
  window: WindowString;
};

type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

const MAX_LOCAL_BUCKETS = 10_000;

const DEFAULT_POLICY: RateLimitPolicy = { limit: 20, window: "1 m" };

/**
 * Hard ceiling applied to every `/api/*` request, keyed by client IP only.
 *
 * This is the safety net enforced in `proxy.ts` before a request ever reaches
 * a route handler. Per-route policies below are stricter and are counted in
 * their own independent buckets.
 */
export const GLOBAL_API_POLICY: RateLimitPolicy = { limit: 100, window: "1 m" };

/**
 * Strict per-user and per-wallet rate limits for fee sponsorship (`/api/sponsor`)
 * to prevent treasury XLM reserve depletion (Issue #330).
 */
export const SPONSOR_USER_POLICY: RateLimitPolicy = { limit: 5, window: "1 m" };
export const SPONSOR_WALLET_POLICY: RateLimitPolicy = { limit: 5, window: "1 m" };

const ROUTE_POLICIES: Record<string, RateLimitPolicy> = {
  "/api/loans/apply": { limit: 5, window: "10 m" },
  "/api/loans/fund": { limit: 10, window: "10 m" },
  "/api/loans/repay": { limit: 10, window: "10 m" },
  "/api/loans/repay/preflight": { limit: 30, window: "1 m" },
  "/api/loans/repayments": { limit: 30, window: "1 m" },
  "/api/pools": { limit: 60, window: "1 m" },
  "/api/pools/deposit": { limit: 15, window: "10 m" },
  "/api/pools/withdraw": { limit: 10, window: "10 m" },
  "/api/sponsor": { limit: 10, window: "1 m" },
  "/api/tasks/complete": { limit: 30, window: "10 m" },
  "/api/notifications/clear": { limit: 20, window: "1 m" },
  "/api/kyc/token": { limit: 10, window: "1 m" },
  "/api/kyc/webhook": { limit: 20, window: "10 m" },
  "/api/analytics": { limit: 60, window: "1 m" },
  "/api/reputation": { limit: 60, window: "1 m" },
  "/api/notifications": { limit: 60, window: "1 m" },
  "/api/borrower/transactions": { limit: 60, window: "1 m" },
  "/api/lender/transactions": { limit: 60, window: "1 m" },
  "/api/lender/tax-report": { limit: 5, window: "10 m" },
  "/api/treasury": { limit: 60, window: "1 m" },
  "/api/metrics": { limit: 60, window: "1 m" },
  "/api/admin/webhooks": { limit: 30, window: "1 m" },
  "/api/admin/risk-parameters": { limit: 20, window: "1 m" },
};

/**
 * Policies for dynamic route segments, matched in order when no exact
 * `ROUTE_POLICIES` entry exists for the pathname.
 */
const ROUTE_PATTERN_POLICIES: Array<{ pattern: RegExp; policy: RateLimitPolicy }> = [
  // PDF generation is expensive — keep it tight.
  { pattern: /^\/api\/loans\/[^/]+\/receipt$/, policy: { limit: 10, window: "10 m" } },
  { pattern: /^\/api\/admin\/webhooks\/[^/]+$/, policy: { limit: 30, window: "1 m" } },
  // Pool borrow-cap management — sensitive admin action, keep conservative
  { pattern: /^\/api\/admin\/pools\/[^/]+\/borrow-cap$/, policy: { limit: 10, window: "1 m" } },
];

const localWindowStore = new Map<string, { count: number; reset: number }>();

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

const ratelimiters = new Map<string, Ratelimit>();

function getPolicy(pathname: string): RateLimitPolicy {
  const exact = ROUTE_POLICIES[pathname];
  if (exact) return exact;

  const matched = ROUTE_PATTERN_POLICIES.find(({ pattern }) => pattern.test(pathname));
  return matched?.policy ?? DEFAULT_POLICY;
}

function getWindowMs(window: WindowString): number {
  const [value, unit] = window.split(" ") as [string, WindowUnit];
  const amount = Number(value);

  switch (unit) {
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
  }
}

function pruneLocalWindowStore(now: number) {
  for (const [key, value] of localWindowStore) {
    if (value.reset <= now) {
      localWindowStore.delete(key);
    }
  }

  if (localWindowStore.size <= MAX_LOCAL_BUCKETS) {
    return;
  }

  const entriesByReset = [...localWindowStore.entries()].sort((a, b) => a[1].reset - b[1].reset);
  const overflow = localWindowStore.size - MAX_LOCAL_BUCKETS;

  for (const [key] of entriesByReset.slice(0, overflow)) {
    localWindowStore.delete(key);
  }
}

function getLocalRateLimit(identifier: string, policy: RateLimitPolicy): RateLimitResult {
  const now = Date.now();
  const windowMs = getWindowMs(policy.window);
  pruneLocalWindowStore(now);
  const current = localWindowStore.get(identifier);

  if (!current || current.reset <= now) {
    const reset = now + windowMs;
    localWindowStore.set(identifier, { count: 1, reset });
    pruneLocalWindowStore(now);

    return {
      success: true,
      limit: policy.limit,
      remaining: policy.limit - 1,
      reset,
    };
  }

  current.count += 1;
  localWindowStore.set(identifier, current);
  pruneLocalWindowStore(now);

  return {
    success: current.count <= policy.limit,
    limit: policy.limit,
    remaining: Math.max(policy.limit - current.count, 0),
    reset: current.reset,
  };
}

async function getUpstashRateLimit(
  identifier: string,
  bucket: string,
  policy: RateLimitPolicy
): Promise<RateLimitResult | null> {
  const cacheKey = `${bucket}:${policy.limit}:${policy.window}`;
  let limiter = ratelimiters.get(cacheKey);

  if (!limiter && redis) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(policy.limit, policy.window),
      prefix: `trustlend:ratelimit:${bucket}`,
      analytics: false,
    });
    ratelimiters.set(cacheKey, limiter);
  }

  if (!limiter) {
    return null;
  }

  try {
    const result = await limiter.limit(identifier);
    await result.pending;

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    console.error("Upstash rate limit check failed:", error);
    return null;
  }
}

// ─── Admin / whitelist bypass ────────────────────────────────────────────────

/**
 * Check if the request carries a valid admin bearer token.
 * Requests with `Authorization: Bearer <ADMIN_SECRET_KEY>` bypass rate limits.
 */
function isAdminRequest(request: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) return false;

  const authHeader = request.headers.get("authorization") ?? "";
  return authHeader === `Bearer ${adminSecret}`;
}

/**
 * Check if the request IP is in the whitelist.
 * Configure via `RATE_LIMIT_WHITELIST` env var (comma-separated IPs/CIDR).
 */
function isWhitelistedIp(request: NextRequest): boolean {
  const whitelistCsv = process.env.RATE_LIMIT_WHITELIST;
  if (!whitelistCsv) return false;

  const ip = getRequestIdentifier(request);
  const whitelisted = whitelistCsv.split(",").map((s) => s.trim()).filter(Boolean);
  return whitelisted.includes(ip);
}

/**
 * Headers that may carry the originating client IP, most trustworthy first.
 *
 * The platform-injected headers (Vercel, Cloudflare) are preferred because a
 * client cannot forge them. `x-real-ip` / `x-forwarded-for` are the fallback
 * for self-hosted deployments behind a reverse proxy — without them every
 * caller collapses into a single `unknown` bucket and per-IP limiting stops
 * working entirely.
 */
const CLIENT_IP_HEADERS = [
  "x-vercel-ip-address",
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-real-ip",
  "x-forwarded-for",
] as const;

export function getRequestIdentifier(request: NextRequest): string {
  for (const header of CLIENT_IP_HEADERS) {
    const value = request.headers.get(header);
    if (!value) continue;

    // Forwarded-for style headers carry a chain: "client, proxy1, proxy2".
    const clientIp = value.split(",")[0].trim();
    if (clientIp) return clientIp;
  }

  return "unknown";
}

/**
 * Count a request against one bucket and build the 429 response if it exceeds
 * the policy. Returns `null` when the request is allowed through.
 *
 * Fails open: if the shared (Upstash) store is unreachable the request is
 * allowed rather than blocking legitimate traffic on infrastructure trouble.
 */
async function enforcePolicy(
  request: NextRequest,
  bucket: string,
  policy: RateLimitPolicy,
  message: string
): Promise<NextResponse | null> {
  // ── Admin / whitelist bypass ───────────────────────────────────────────────
  if (isAdminRequest(request) || isWhitelistedIp(request)) {
    return null;
  }

  const ip = getRequestIdentifier(request);
  const identifier = `${bucket}:${ip}`;
  const result = redis
    ? await getUpstashRateLimit(identifier, bucket, policy)
    : getLocalRateLimit(identifier, policy);

  if (!result || result.success) {
    return null;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1_000));

  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(result.reset),
      },
    }
  );
}

/**
 * Apply rate limiting to a Next.js API route.
 *
 * Returns a `NextResponse` with status 429 if the request is rate-limited,
 * or `null` if the request should proceed.
 *
 * **Bypass:** Requests with `Authorization: Bearer <ADMIN_SECRET_KEY>` or
 * from whitelisted IPs (configured via `RATE_LIMIT_WHITELIST` env var) skip
 * rate limiting entirely.
 */
export async function enforceRouteRateLimit(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  return enforcePolicy(request, pathname, getPolicy(pathname), "Too many requests");
}

/**
 * Apply the global per-IP ceiling to any `/api/*` request: at most
 * `GLOBAL_API_POLICY.limit` requests per minute per client IP, across all
 * endpoints combined.
 *
 * Enforced in `proxy.ts` so it runs before a request reaches a route handler.
 * Counted in its own bucket, independent of the per-route policies applied by
 * `enforceRouteRateLimit`.
 */
export async function enforceGlobalApiRateLimit(request: NextRequest) {
  return enforcePolicy(
    request,
    "global:api",
    GLOBAL_API_POLICY,
    "Too many requests, please slow down."
  );
}

async function enforceIdentifierPolicy(
  identifierKey: string,
  bucket: string,
  policy: RateLimitPolicy,
  message: string
): Promise<NextResponse | null> {
  const normalizedKey = identifierKey.trim();
  if (!normalizedKey) {
    return null;
  }

  const identifier = `${bucket}:${normalizedKey}`;
  const result = redis
    ? await getUpstashRateLimit(identifier, bucket, policy)
    : getLocalRateLimit(identifier, policy);

  if (!result || result.success) {
    return null;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1_000));

  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(result.reset),
      },
    }
  );
}

/**
 * Enforce strict per-user and per-wallet rate limits on fee sponsorship requests.
 * Returns a 429 NextResponse if either the authenticated user ID or the target
 * wallet address exceeds its sponsorship quota.
 */
export async function enforceSponsorRateLimit(params: {
  userId: string;
  walletAddresses?: Array<string | null | undefined>;
  userPolicy?: RateLimitPolicy;
  walletPolicy?: RateLimitPolicy;
}): Promise<NextResponse | null> {
  const userPolicy = params.userPolicy ?? SPONSOR_USER_POLICY;
  const walletPolicy = params.walletPolicy ?? SPONSOR_WALLET_POLICY;

  const userLimitResponse = await enforceIdentifierPolicy(
    params.userId,
    "sponsor:user",
    userPolicy,
    "Fee sponsorship rate limit exceeded for this user account. Please wait before requesting another sponsored transaction."
  );
  if (userLimitResponse) {
    return userLimitResponse;
  }

  const uniqueWallets = new Set(
    (params.walletAddresses ?? [])
      .filter((addr): addr is string => typeof addr === "string" && addr.trim().length > 0)
      .map((addr) => addr.trim())
  );

  for (const wallet of uniqueWallets) {
    const walletLimitResponse = await enforceIdentifierPolicy(
      wallet,
      "sponsor:wallet",
      walletPolicy,
      "Fee sponsorship rate limit exceeded for this wallet address. Please wait before requesting another sponsored transaction."
    );
    if (walletLimitResponse) {
      return walletLimitResponse;
    }
  }

  return null;
}

/** Reset the in-memory rate-limit window store (for deterministic testing). */
export function resetLocalRateLimitStore(): void {
  localWindowStore.clear();
}
