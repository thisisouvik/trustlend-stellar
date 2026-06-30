import { redis } from "@/lib/services/redis";
import type { PlatformAnalyticsResponse } from "@/lib/analytics";

export const ANALYTICS_CACHE_KEY = "analytics:platform:v1";

type CachedEntry = {
  payload: PlatformAnalyticsResponse;
  expiresAt: number;
};

let memoryCache: CachedEntry | null = null;

function parsePayload(value: unknown): PlatformAnalyticsResponse | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as PlatformAnalyticsResponse;
    } catch {
      return null;
    }
  }

  if (typeof value === "object") {
    return value as PlatformAnalyticsResponse;
  }

  return null;
}

export async function getCachedPlatformAnalytics(): Promise<PlatformAnalyticsResponse | null> {
  if (redis) {
    try {
      const cached = await redis.get(ANALYTICS_CACHE_KEY);
      return parsePayload(cached);
    } catch (error) {
      console.error("[analytics-cache] Redis read failed:", error);
    }
  }

  if (memoryCache && memoryCache.expiresAt > Date.now()) {
    return memoryCache.payload;
  }

  memoryCache = null;
  return null;
}

export async function setCachedPlatformAnalytics(
  payload: PlatformAnalyticsResponse,
  ttlSeconds: number,
): Promise<void> {
  const expiresAt = Date.now() + ttlSeconds * 1_000;
  memoryCache = { payload, expiresAt };

  if (!redis) {
    return;
  }

  try {
    await redis.set(ANALYTICS_CACHE_KEY, JSON.stringify(payload), { ex: ttlSeconds });
  } catch (error) {
    console.error("[analytics-cache] Redis write failed:", error);
  }
}

export function clearAnalyticsMemoryCacheForTests(): void {
  memoryCache = null;
}
