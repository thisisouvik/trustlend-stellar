/**
 * lib/auth/session.ts
 *
 * Server-side session helpers for pages, server actions and API routes.
 *
 *   getSessionUser()            → SessionUser | null
 *   requireAuthenticatedUser()  → SessionUser (redirects to /auth otherwise)
 *   requireApiUser()            → SessionUser (throws UnauthorizedError — for JSON routes)
 *   requireTradeVaultAdmin()    → SessionUser (allowlisted e-mail/wallet AND profiles.role = admin)
 *
 * The session cookie holds a signed JWT (see session-token.ts). We still read
 * the user row on every call so a deleted or re-roled user is reflected
 * immediately rather than at token expiry.
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { profiles, users } from "@/lib/db/schema";
import { getDashboardPath, normalizeUserRole, type UserRole } from "@/lib/auth/roles";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session-token";

/** The authenticated identity as seen by the application layer. */
export interface SessionUser {
  id: string;
  walletAddress: string;
  role: UserRole;
  /** Display name from the profile ("" when the user never set one). */
  fullName: string;
  /** Optional contact e-mail (SIWS users have none unless they add one). */
  email: string | null;
  createdAt: string;
  lastSignInAt: string | null;
}

export class UnauthorizedError extends Error {
  readonly status: 401 | 403;

  constructor(message = "Not authenticated", status?: 401 | 403) {
    super(message);
    this.name = "UnauthorizedError";
    this.status = status ?? (message === "Not authenticated" ? 401 : 403);
  }
}

const DEV_BYPASS_ENABLED =
  process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_AUTH_BYPASS === "true";

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Local-dev / e2e escape hatch: `x-dev-user-id` + `x-dev-role` headers act as
 * the session. Only honoured outside production with ENABLE_DEV_AUTH_BYPASS.
 */
async function devBypassUser(): Promise<SessionUser | null> {
  if (!DEV_BYPASS_ENABLED) return null;
  const h = await headers();
  const id = h.get("x-dev-user-id")?.trim() ?? "";
  if (!id || !isValidUuid(id)) return null;
  const role = normalizeUserRole(h.get("x-dev-role")?.trim());
  const db = getDb();
  const row = db
    ? await db
        .select({ wallet: users.walletAddress, fullName: profiles.fullName, email: users.email })
        .from(users)
        .leftJoin(profiles, eq(profiles.id, users.id))
        .where(eq(users.id, id))
        .limit(1)
        .then((r) => r[0])
    : undefined;
  return {
    id,
    walletAddress: row?.wallet ?? "",
    role,
    fullName: row?.fullName ?? "Dev User",
    email: row?.email ?? null,
    createdAt: new Date(0).toISOString(),
    lastSignInAt: null,
  };
}

/** Resolve the current user from the session cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const bypass = await devBypassUser();
  if (bypass) return bypass;

  const cookieStore = await cookies();
  const claims = await verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (!claims) return null;

  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({
      id: users.id,
      walletAddress: users.walletAddress,
      role: users.role,
      email: users.email,
      createdAt: users.createdAt,
      lastSignInAt: users.lastSignInAt,
      fullName: profiles.fullName,
    })
    .from(users)
    .leftJoin(profiles, eq(profiles.id, users.id))
    .where(eq(users.id, claims.sub))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    walletAddress: row.walletAddress,
    role: normalizeUserRole(row.role),
    fullName: row.fullName ?? "",
    email: row.email ?? null,
    createdAt: row.createdAt.toISOString(),
    lastSignInAt: row.lastSignInAt ? row.lastSignInAt.toISOString() : null,
  };
}

/**
 * For server components / actions: redirect to /auth when signed out, or to
 * the user's own dashboard when they are the wrong role for this page.
 */
export async function requireAuthenticatedUser(expectedRole?: UserRole): Promise<{
  user: SessionUser;
  role: UserRole;
}> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/auth");
  }
  if (expectedRole && user.role !== expectedRole) {
    redirect(getDashboardPath(user.role));
  }
  return { user, role: user.role };
}

/** For API routes: throw instead of redirecting so the caller can return JSON. */
export async function requireApiUser(expectedRole?: UserRole): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError("Not authenticated", 401);
  if (expectedRole && user.role !== expectedRole) {
    throw new UnauthorizedError(`This action requires the ${expectedRole} role.`, 403);
  }
  return user;
}

function parseAllowedAdmins(): Set<string> {
  const value = process.env.TRADE_VAULT_ADMIN_EMAILS;
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Admin allowlist check. TRADE_VAULT_ADMIN_EMAILS accepts e-mails and Stellar
 * addresses (comma-separated) so wallet-only accounts can be admins too.
 */
export function isTradeVaultAdminUser(user: Pick<SessionUser, "email" | "walletAddress">): boolean {
  const allowed = parseAllowedAdmins();
  const email = user.email?.toLowerCase() ?? "";
  const wallet = user.walletAddress?.toLowerCase() ?? "";
  return (email !== "" && allowed.has(email)) || (wallet !== "" && allowed.has(wallet));
}

/** Allowlisted AND profiles.role = 'admin' — both are required. */
export async function requireTradeVaultAdmin(): Promise<{ user: SessionUser; role: UserRole }> {
  const { user, role } = await requireAuthenticatedUser();

  const db = getDb();
  const [profile] = db
    ? await db.select({ role: profiles.role }).from(profiles).where(eq(profiles.id, user.id)).limit(1)
    : [];

  const dbAdmin = profile?.role === "admin";
  if (!isTradeVaultAdminUser(user) || !dbAdmin) {
    redirect(getDashboardPath(normalizeUserRole(role)));
  }
  return { user, role };
}

/** API-route flavour of requireTradeVaultAdmin (throws instead of redirecting). */
export async function requireApiAdmin(): Promise<SessionUser> {
  const user = await requireApiUser();
  const db = getDb();
  const [profile] = db
    ? await db.select({ role: profiles.role }).from(profiles).where(eq(profiles.id, user.id)).limit(1)
    : [];
  if (!isTradeVaultAdminUser(user) || profile?.role !== "admin") {
    throw new UnauthorizedError("Admin access required.", 403);
  }
  return user;
}
