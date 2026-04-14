import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function LenderPortfolioPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const [positionsRes, profileRes] = supabase
    ? await Promise.all([
        supabase
          .from("pool_positions")
          .select("id, pool_id, status, principal_amount, earned_interest, opened_at")
          .eq("lender_id", user.id)
          .order("opened_at", { ascending: false })
          .limit(8),
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
      ])
    : [{ data: [] }, { data: null }];

  const positions = positionsRes.data ?? [];
  const profile = profileRes.data;

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Portfolio Positions"
      description="Track active pool positions, principal exposure, and cumulative interest earned."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/portfolio"
      links={[
        { href: "/dashboard/lender", label: "Home" },
        { href: "/dashboard/lender/pools", label: "Pools" },
        { href: "/dashboard/lender/portfolio", label: "Portfolio" },
        { href: "/dashboard/lender/risk", label: "Risk" },
        { href: "/dashboard/lender/profile", label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-grid">
        {(positions ?? []).length === 0 ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">No portfolio positions yet</h2>
            <p className="workspace-card-copy">
              Once capital is deposited into pools, your exposure and earnings will appear here.
            </p>
          </article>
        ) : (
          (positions ?? []).map((position) => (
            <article key={String(position.id)} className="workspace-card">
              <h2 className="workspace-card-title">Pool #{String(position.pool_id).slice(0, 8)}</h2>
              <p className="workspace-card-copy">Status: {String(position.status)}</p>
              <p className="workspace-card-copy">Principal: {Number(position.principal_amount ?? 0).toFixed(2)}</p>
              <p className="workspace-card-copy">Interest: {Number(position.earned_interest ?? 0).toFixed(2)}</p>
            </article>
          ))
        )}
      </div>
    </WorkspaceFrame>
  );
}
