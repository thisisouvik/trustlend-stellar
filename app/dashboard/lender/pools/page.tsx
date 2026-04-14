import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function LenderPoolsPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const [poolsRes, profileRes] = supabase
    ? await Promise.all([
        supabase
          .from("lending_pools")
          .select("id, name, status, apr_bps, total_liquidity, available_liquidity")
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
      ])
    : [{ data: [] }, { data: null }];

  const pools = poolsRes.data ?? [];
  const profile = profileRes.data;

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Pool Directory"
      description="Review available liquidity pools, APR, and allocation capacity before deploying capital."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/pools"
      links={[
        { href: "/dashboard/lender", label: "Home" },
        { href: "/dashboard/lender/pools", label: "Pools" },
        { href: "/dashboard/lender/portfolio", label: "Portfolio" },
        { href: "/dashboard/lender/risk", label: "Risk" },
        { href: "/dashboard/lender/profile", label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-table-wrap">
        <table className="workspace-table" aria-label="Lending pools table">
          <thead>
            <tr>
              <th>Pool</th>
              <th>Status</th>
              <th>APR</th>
              <th>Total</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            {(pools ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="workspace-empty-row">No pools available yet.</td>
              </tr>
            ) : (
              (pools ?? []).map((pool) => (
                <tr key={String(pool.id)}>
                  <td>{String(pool.name ?? "Unnamed")}</td>
                  <td>{String(pool.status)}</td>
                  <td>{(Number(pool.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                  <td>{Number(pool.total_liquidity ?? 0).toFixed(2)}</td>
                  <td>{Number(pool.available_liquidity ?? 0).toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </WorkspaceFrame>
  );
}
