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

const ROUTE_POLICIES: Record<string, RateLimitPolicy> = {
  "/api/loans/apply": { limit: 5, window: "10 m" },
  "/api/loans/fund": { limit: 10, window: "10 m" },
  "/api/loans/repay": { limit: 10, window: "10 m" },
  "/api/pools/deposit": { limit: 15, window: "10 m" },
  "/api/pools/withdraw": { limit: 10, window: "10 m" },
  "/api/sponsor": { limit: 10, window: "1 m" },
  "/api/tasks/complete": { limit: 30, window: "10 m" },
  "/api/notifications/clear": { limit: 20, window: "1 m" },
};

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
  return ROUTE_POLICIES[pathname] ?? DEFAULT_POLICY;
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
  pathname: string,
  policy: RateLimitPolicy
): Promise<RateLimitResult | null> {
  const cacheKey = `${pathname}:${policy.limit}:${policy.window}`;
  let limiter = ratelimiters.get(cacheKey);

  if (!limiter && redis) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(policy.limit, policy.window),
      prefix: `trustlend:ratelimit:${pathname}`,
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

function getRequestIdentifier(request: NextRequest): string {
  const ip =
    request.headers.get("x-vercel-ip-address") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown";
  return ip;
}

export async function enforceRouteRateLimit(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const policy = getPolicy(pathname);
  const identifier = `${pathname}:${getRequestIdentifier(request)}`;
  const result = redis
    ? await getUpstashRateLimit(identifier, pathname, policy)
    : getLocalRateLimit(identifier, policy);

  if (!result) {
    return null;
  }

  if (!result.success) {
    const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1_000));

    return NextResponse.json(
      { error: "Too many requests" },
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

  return null;
}
