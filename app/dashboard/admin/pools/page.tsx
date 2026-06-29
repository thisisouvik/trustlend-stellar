import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import { getAdminDashboardMetrics, presentAdminMetrics } from "@/lib/dashboard/metrics";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { fetchAdminDashboardPools } from "@/lib/db/pools";
import AdminPoolsClient from "./pools-client";

/**
 * Admin Pools Page
 * 
 * OPTIMIZATION (Issue #39):
 * - Uses fetchAdminDashboardPools from lib/db/pools.ts
 * - Parallel queries instead of waterfall
 * - Explicit column selection (no SELECT *)
 * - Consistent type handling
 */
export default async function AdminPoolsPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const admin = getServiceRoleClient();

  if (!admin) {
    throw new Error("Database service unavailable");
  }

  // Fetch pools and pending loans using optimized function
  // Queries execute in parallel for better performance
  const { pools: rawPools, pendingLoans: rawLoans } =
    await fetchAdminDashboardPools(admin);

  // Transform to component-friendly format
  const pools = rawPools.map((p) => ({
    id: String(p.id),
    name: String(p.name ?? ""),
    description: p.description ? String(p.description) : null,
    status: String(p.status ?? "paused"),
    apr_bps: Number(p.apr_bps ?? 0),
    total_liquidity: Number(p.total_liquidity ?? 0),
    available_liquidity: Number(p.available_liquidity ?? 0),
  }));

  const pendingLoans = rawLoans.map((l) => ({
    id: String(l.id),
    status: String(l.status ?? "requested"),
    principal_amount: Number(l.principal_amount ?? 0),
    apr_bps: Number(l.apr_bps ?? 0),
    duration_days: Number(l.duration_days ?? 30),
    requested_at: String(l.requested_at ?? ""),
    borrower_profile: l.borrower_profile
      ? { full_name: l.borrower_profile.full_name ?? null }
      : null,
  }));

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
