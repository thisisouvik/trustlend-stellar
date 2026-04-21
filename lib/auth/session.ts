import { redirect } from "next/navigation";
import {
  getDashboardPath,
  normalizeUserRole,
  type UserRole,
} from "@/lib/auth/roles";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export async function requireAuthenticatedUser(expectedRole?: UserRole) {
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