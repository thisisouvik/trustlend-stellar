/**
 * lib/db/client.ts
 *
 * Drizzle + Neon database access.
 *
 * - `getDb()` — HTTP driver. One round-trip per query, no connection to keep
 *   alive: the right choice for Vercel serverless / edge handlers and for the
 *   vast majority of reads and single-statement writes.
 * - `getPooledDb()` — WebSocket pool driver. Required for interactive
 *   transactions (`db.transaction(...)`), including referral attribution, and
 *   for long-running scripts (keepers, backfills) that issue many statements.
 *
 * Both return `null` when DATABASE_URL is not configured so callers can degrade
 * gracefully (the app renders an empty dashboard instead of crashing at build
 * time, matching the previous behaviour when Supabase env was absent).
 *
 * SERVER-ONLY. Never import from a client component. (Not guarded with the
 * `server-only` package because keeper scripts and vitest import this too.)
 */

import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzleWs, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;
export type PooledDb = NeonDatabase<typeof schema>;

let httpDb: Db | null | undefined;
let pooledDb: PooledDb | null | undefined;

function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  return url && url.trim().length > 0 ? url : null;
}

/** True when the database is configured. */
export function isDatabaseConfigured(): boolean {
  return databaseUrl() !== null;
}

/** Drizzle over Neon's HTTP driver. Cached per runtime. */
export function getDb(): Db | null {
  if (httpDb !== undefined) return httpDb;
  const url = databaseUrl();
  if (!url) {
    httpDb = null;
    return null;
  }
  httpDb = drizzleHttp(neon(url), { schema });
  return httpDb;
}

/** Drizzle over a Neon WebSocket pool — use for transactions and scripts. */
export function getPooledDb(): PooledDb | null {
  if (pooledDb !== undefined) return pooledDb;
  const url = databaseUrl();
  if (!url) {
    pooledDb = null;
    return null;
  }
  // Node < 22 has no global WebSocket; the `ws` package is pulled in by
  // @neondatabase/serverless when needed. Vercel's runtime provides one.
  if (typeof WebSocket === "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    neonConfig.webSocketConstructor = require("ws");
  }
  pooledDb = drizzleWs(new Pool({ connectionString: url }), { schema });
  return pooledDb;
}

/**
 * Like `getDb()` but throws a descriptive error instead of returning null.
 * Use in API routes where "database not configured" is a hard 503.
 */
export function requireDb(): Db {
  const db = getDb();
  if (!db) {
    throw new DatabaseNotConfiguredError();
  }
  return db;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("Database is not configured (DATABASE_URL is missing).");
    this.name = "DatabaseNotConfiguredError";
  }
}

export { schema };
