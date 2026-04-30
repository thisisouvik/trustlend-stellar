import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import { getAdminDashboardMetrics, presentAdminMetrics } from "@/lib/dashboard/metrics";
import { getServiceRoleClient } from "@/lib/supabase/server";
import AdminPoolsClient from "./pools-client";

export default async function AdminPoolsPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const admin = getServiceRoleClient();

  const [poolsRes, pendingLoansRes] = admin
    ? await Promise.all([
        admin
          .from("lending_pools")
          .select("id, name, description, status, apr_bps, total_liquidity, available_liquidity")
          .order("created_at", { ascending: false }),
        admin
          .from("loans")
          .select("id, status, principal_amount, apr_bps, duration_days, requested_at, borrower_id, profiles:borrower_id(full_name)")
          .eq("status", "requested")
          .order("requested_at", { ascending: true }),
      ])
    : [{ data: [] }, { data: [] }];


  const pools = (poolsRes.data ?? []).map((p) => ({
    id: String(p.id),
    name: String(p.name ?? ""),
    description: p.description ? String(p.description) : null,
    status: String(p.status ?? "paused"),
    apr_bps: Number(p.apr_bps ?? 0),
    total_liquidity: Number(p.total_liquidity ?? 0),
    available_liquidity: Number(p.available_liquidity ?? 0),
  }));

  const pendingLoans = (pendingLoansRes.data ?? []).map((l) => {
    // Supabase returns joined relations as array or object depending on cardinality
    const raw = l.profiles;
    const profileData = Array.isArray(raw)
      ? (raw[0] as { full_name: string | null } | undefined) ?? null
      : (raw as { full_name: string | null } | null);
    return {
      id: String(l.id),
      status: String(l.status ?? "requested"),
      principal_amount: Number(l.principal_amount ?? 0),
      apr_bps: Number(l.apr_bps ?? 0),
      duration_days: Number(l.duration_days ?? 30),
      requested_at: String(l.requested_at ?? ""),
      borrower_profile: profileData
        ? { full_name: profileData.full_name ?? null }
        : null,
    };
  });

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="Pool Management"
      description="Create lending pools, approve borrower loans, and run auto-matching to deploy capital efficiently."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[
        ...adminNavLinks,
        { href: "/dashboard/admin/pools", label: "Pool Management" },
      ]}
      currentPath="/dashboard/admin/pools"
      showProfileAlert={false}
    >
      <AdminPoolsClient pools={pools} pendingLoans={pendingLoans} />
    </WorkspaceFrame>
  );
}
