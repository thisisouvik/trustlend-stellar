import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { User } from "@supabase/supabase-js";
import {
  getDashboardPath,
  normalizeUserRole,
  type UserRole,
} from "@/lib/auth/roles";
import { getServerSupabaseClient } from "@/lib/supabase/server";

// SECURITY: bypass is disabled in production regardless of env var
const DEV_BYPASS_ENABLED =
  process.env.NODE_ENV !== "production" &&
  process.env.ENABLE_DEV_AUTH_BYPASS === "true";

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function tryGetBypassUser(expectedRole?: UserRole) {
  if (!DEV_BYPASS_ENABLED) {
    return null;
  }

  const headerStore = await headers();
  const bypassUserId = headerStore.get("x-dev-user-id")?.trim() ?? "";
  const bypassRoleRaw = (headerStore.get("x-dev-role")?.trim() ?? "") as UserRole;
  const bypassEmail = headerStore.get("x-dev-email")?.trim() ?? "dev-user@local.test";

  if (!bypassUserId || !isValidUuid(bypassUserId)) {
    return null;
  }

  const role = normalizeUserRole(bypassRoleRaw);

  if (expectedRole && role !== expectedRole) {
    redirect(getDashboardPath(role));
  }

  const user = {
    id: bypassUserId,
    email: bypassEmail,
    app_metadata: {},
    user_metadata: { account_type: role },
  } as unknown as User;

  return { user, role };
}

export async function requireAuthenticatedUser(expectedRole?: UserRole) {
  const bypass = await tryGetBypassUser(expectedRole);
  if (bypass) {
    return bypass;
  }

  const supabase = await getServerSupabaseClient();

  if (!supabase) {
    redirect("/auth");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth");
  }

  const role = normalizeUserRole(user.user_metadata?.account_type);

  if (expectedRole && role !== expectedRole) {
    redirect(getDashboardPath(role));
  }

  return { user, role };
}

function parseAllowedAdminEmails(): Set<string> {
  const value = process.env.TRADE_VAULT_ADMIN_EMAILS;
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isTradeVaultAdminUser(user: {
  email?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}) {
  const allowedAdmins = parseAllowedAdminEmails();
  const email = user.email?.toLowerCase() ?? "";

  // Do not trust user/app metadata claims for admin access.
  // Only allowlisted email + DB role check in requireTradeVaultAdmin grants access.
  return allowedAdmins.has(email);
}

export async function requireTradeVaultAdmin() {
  const { user, role } = await requireAuthenticatedUser();
  const emailAllowlisted = isTradeVaultAdminUser(user);

  const supabase = await getServerSupabaseClient();
  if (!supabase) {
    redirect(getDashboardPath(normalizeUserRole(role)));
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const dbAdmin = profile?.role === "admin";

  if (!emailAllowlisted || !dbAdmin) {
    redirect(getDashboardPath(normalizeUserRole(role)));
  }

  return { user, role };
}