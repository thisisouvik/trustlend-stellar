import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";

export default async function LenderPortfolioPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();

  // 1. Fetch Pool Positions
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

  // 2. Fetch Direct Marketplace Loans for Profit
  // P2P Funds
  const { data: p2pFunds } = supabase
    ? await supabase
        .from("ledger_transactions")
        .select("amount, ref_id")
        .eq("user_id", user.id)
        .eq("ref_type", "loan_fund")
    : { data: [] };

  const { data: p2pRepays } = supabase
    ? await supabase
        .from("ledger_transactions")
        .select("amount, metadata, ref_id")
        .eq("ref_type", "loan_repay")
    : { data: [] };

  const lenderRepays = (p2pRepays ?? []).filter(tx => {
    try {
      const meta = JSON.parse(String(tx.metadata || "{}"));
      return String(meta.lenderUserId) === String(user.id) || String(meta.lenderAddress) === String(user.id);
    } catch { return false; }
  });

  // Calculate Marketplace net
  const marketplaceDeployed = (p2pFunds ?? []).reduce((s, t) => s + Number(t.amount), 0);
  const marketplaceReceived = lenderRepays.reduce((s, t) => s + Number(t.amount), 0);
  const marketplaceProfit = Math.max(0, marketplaceReceived - marketplaceDeployed);

  const poolProfit = positions.reduce((s, r) => s + Number(r.earned_interest ?? 0), 0);

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Portfolio & Profits"
      description="Track total profits across automated pools and direct marketplace loans."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/portfolio"
      links={lenderNavLinks}
    >
      <div className="workspace-stack">

        {/* Profit Breakdown */}
        <section className="workspace-grid workspace-grid--two">
           <article className="workspace-card" style={{ background: "linear-gradient(135deg, #7e2fd0, #5a1fad)", color: "#fff", border: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
                 <div style={{ fontSize: "2rem" }}>🏪</div>
                 <div>
                    <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Marketplace Profits</h2>
                    <p style={{ margin: 0, opacity: 0.8, fontSize: "0.8rem" }}>Direct P2P Lending</p>
                 </div>
              </div>
              <p style={{ fontSize: "2rem", fontWeight: 800, margin: "0 0 0.5rem" }}>
                {marketplaceProfit > 0 ? "+" : ""}{marketplaceProfit.toFixed(2)} XLM
              </p>
              <div style={{ fontSize: "0.85rem", opacity: 0.8, display: "flex", justifyContent: "space-between", borderTop: "1px solid rgba(255,255,255,0.2)", paddingTop: "0.5rem", marginTop: "0.5rem" }}>
                 <span>Deployed: {marketplaceDeployed.toFixed(2)} XLM</span>
                 <span>Received: {marketplaceReceived.toFixed(2)} XLM</span>
              </div>
           </article>

           <article className="workspace-card" style={{ background: "linear-gradient(135deg, #22cf9d, #149972)", color: "#fff", border: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
                 <div style={{ fontSize: "2rem" }}>🏦</div>
                 <div>
                    <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Pool Profits</h2>
                    <p style={{ margin: 0, opacity: 0.8, fontSize: "0.8rem" }}>Automated E2E Liquidity</p>
                 </div>
              </div>
              <p style={{ fontSize: "2rem", fontWeight: 800, margin: "0 0 0.5rem" }}>
                {poolProfit > 0 ? "+" : ""}{poolProfit.toFixed(4)} XLM
              </p>
              <div style={{ fontSize: "0.85rem", opacity: 0.8, display: "flex", justifyContent: "space-between", borderTop: "1px solid rgba(255,255,255,0.2)", paddingTop: "0.5rem", marginTop: "0.5rem" }}>
                 <span>Total Deployed: {positions.reduce((s,p) => s + Number(p.principal_amount), 0).toFixed(2)} XLM</span>
                 <span>Positions: {positions.length}</span>
              </div>
           </article>
        </section>

        <section className="workspace-grid">
          {(positions ?? []).length === 0 && (p2pFunds ?? []).length === 0 ? (
            <article className="workspace-card workspace-card--full">
              <h2 className="workspace-card-title">No portfolio positions yet</h2>
              <p className="workspace-card-copy">
                Once capital is deployed, your core exposure and earnings will appear here.
              </p>
            </article>
          ) : null}

          {positions.length > 0 && (
             <article className="workspace-card workspace-card--full">
               <h2 className="workspace-card-title" style={{ marginBottom: "1rem" }}>Active Pool Positions</h2>
               <div className="workspace-table-wrap">
                  <table className="workspace-table">
                     <thead>
                        <tr><th>Pool ID</th><th>Status</th><th>Principal</th><th>Earned Interest</th></tr>
                     </thead>
                     <tbody>
                        {positions.map((position) => (
                          <tr key={String(position.id)}>
                             <td style={{ fontFamily: "monospace" }}>#{String(position.pool_id).slice(0, 8)}</td>
                             <td>
                               <span style={{ padding: "0.15rem 0.5rem", borderRadius: "9999px", fontSize: "0.75rem", fontWeight: 600, background: "rgba(34,207,157,0.12)", color: "#22cf9d" }}>
                                  {String(position.status).toUpperCase()}
                               </span>
                             </td>
                             <td>{Number(position.principal_amount ?? 0).toFixed(2)} XLM</td>
                             <td style={{ color: "#22cf9d", fontWeight: "bold" }}>+{Number(position.earned_interest ?? 0).toFixed(4)} XLM</td>
                          </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
             </article>
          )}
        </section>
      </div>
    </WorkspaceFrame>
  );
}
