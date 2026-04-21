import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LenderForms } from "@/components/dashboard/LenderForms";
import { InteractiveLineChart } from "@/components/dashboard/InteractiveLineChart";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { formatCurrency } from "@/lib/utils/formatting";
import { isLikelyTxHash, buildStellarTxVerificationUrl } from "@/lib/stellar/explorer";

export default async function LenderPoolsPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();

  const [poolsRes, positionsRes, profileRes, txHistoryRes] = supabase
    ? await Promise.all([
        supabase
          .from("lending_pools")
          .select("id, name, status, apr_bps, total_liquidity, available_liquidity")
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("pool_positions")
          .select("id, pool_id, status, principal_amount, earned_interest, opened_at")
          .eq("lender_id", user.id)
          .order("opened_at", { ascending: true }),
        supabase
          .from("profiles")
          .select("full_name, kyc_status")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("ledger_transactions")
          .select("id, amount, category, metadata, status, created_at")
          .eq("user_id", user.id)
          .eq("ref_type", "pool_position")
          .order("created_at", { ascending: false })
          .limit(10),
      ])
    : [{ data: [] }, { data: [] }, { data: null }, { data: [] }];

  const pools     = poolsRes.data     ?? [];
  const positions = positionsRes.data ?? [];
  const profile   = profileRes.data;
  const txHistory = txHistoryRes.data ?? [];

  const totalDeployed = positions.reduce((s, p) => s + Number(p.principal_amount ?? 0), 0);
  const totalEarned   = positions.reduce((s, p) => s + Number(p.earned_interest   ?? 0), 0);

  // Generate cumulative portfolio growth data for the interactive chart based on pool positions
  let cumulativeValue = 0;
  const chartData = positions.length > 0 
    ? positions.map(p => {
        cumulativeValue += (Number(p.principal_amount) + Number(p.earned_interest));
        return {
           label: `Account Value on ${p.opened_at ? new Date(String(p.opened_at)).toLocaleDateString() : "Active"}`,
           value: cumulativeValue
        };
      })
    : [
       { label: 'Jan Growth Projection', value: 100 },
       { label: 'Feb Growth Projection', value: 250 },
       { label: 'Mar Growth Projection', value: 400 },
       { label: 'Apr Growth Projection', value: 850 }
      ];

  if (chartData.length === 1) {
    // Inject a starting zero-point if there is only one position so the graph spans out
    chartData.unshift({ label: 'Initial Deposit', value: 0 });
  }

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Pool Investment"
      description="Deposit XLM into a lending pool and earn passive APR. The pool auto-matches your capital to open borrower requests."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/pools"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">

        {/* ── My positions summary ──────────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {[
              { label: "Your Total Deployed", value: `${totalDeployed.toFixed(2)} XLM` },
              { label: "Total Interest Earned", value: `${totalEarned.toFixed(4)} XLM`, green: true },
              { label: "Active Positions", value: String(positions.filter((p) => p.status === "active").length) },
            ].map((stat) => (
              <article key={stat.label} className="workspace-card" style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <p style={{ fontSize: "0.78rem", opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.35rem" }}>
                  {stat.label}
                </p>
                <p style={{ fontSize: "1.6rem", fontWeight: 700, color: stat.green ? "#22cf9d" : "inherit" }}>
                  {stat.value}
                </p>
              </article>
            ))}
          </div>

          <article className="workspace-card" style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "2rem" }}>
             <h3 style={{ fontSize: "0.85rem", opacity: 0.6, marginBottom: "1rem", marginTop: 0, textTransform: "uppercase", letterSpacing: "0.05em" }}>Cumulative Pool Portfolio Growth</h3>
             <InteractiveLineChart points={chartData} color="#22cf9d" />
          </article>
        </section>

        {/* ── Available pools table ─────────────────────────────── */}
        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title">Available Lending Pools</h2>
          {pools.length === 0 ? (
            <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
              No lending pools have been created yet. Check back soon.
            </p>
          ) : (
            <div className="workspace-table-wrap">
              <table className="workspace-table" aria-label="Lending pools">
                <thead>
                  <tr>
                    <th>Pool Name</th>
                    <th>Status</th>
                    <th>APR</th>
                    <th>Total Size</th>
                    <th>Available</th>
                    <th>My Stake</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((pool) => {
                    const myPos = positions.find((p) => String(p.pool_id) === String(pool.id));
                    return (
                      <tr key={String(pool.id)}>
                        <td><strong>{String(pool.name)}</strong></td>
                        <td>
                          <span style={{
                            padding: "0.15rem 0.5rem", borderRadius: "9999px",
                            fontSize: "0.75rem", fontWeight: 600,
                            background: pool.status === "active" ? "rgba(34,207,157,0.12)" : "rgba(255,107,107,0.12)",
                            color: pool.status === "active" ? "#22cf9d" : "#ff6b6b",
                          }}>
                            {String(pool.status).toUpperCase()}
                          </span>
                        </td>
                        <td>{(Number(pool.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                        <td>{formatCurrency(Number(pool.total_liquidity ?? 0))}</td>
                        <td>{Number(pool.available_liquidity ?? 0).toFixed(2)} XLM</td>
                        <td style={{ color: myPos ? "#22cf9d" : "inherit", fontWeight: myPos ? 600 : 400 }}>
                          {myPos ? `${Number(myPos.principal_amount ?? 0).toFixed(2)} XLM ✅` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

        {/* ── Deposit / Withdraw forms ──────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          <LenderForms pools={pools} positions={positions} />

          {/* My positions detail */}
          <article className="workspace-card">
            <h2 className="workspace-card-title">Your Positions</h2>
            {positions.length === 0 ? (
              <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
                No positions yet. Make your first deposit using the form.
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                {positions.map((pos) => {
                  const pool = pools.find((p) => String(p.id) === String(pos.pool_id));
                  return (
                    <li
                      key={String(pos.id)}
                      style={{
                        padding: "0.75rem",
                        borderRadius: "0.6rem",
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.07)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                        <span style={{ fontWeight: 600, fontSize: "0.88rem" }}>
                          {pool ? String(pool.name) : `Pool ${String(pos.pool_id).slice(0, 6)}`}
                        </span>
                        <span style={{
                          fontSize: "0.75rem", fontWeight: 600, padding: "0.1rem 0.45rem",
                          borderRadius: "9999px",
                          background: pos.status === "active" ? "rgba(34,207,157,0.12)" : "rgba(255,107,107,0.12)",
                          color: pos.status === "active" ? "#22cf9d" : "#ff6b6b",
                        }}>
                          {String(pos.status ?? "active").toUpperCase()}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.83rem", opacity: 0.75 }}>
                        <span>Deployed: <strong>{Number(pos.principal_amount ?? 0).toFixed(2)} XLM</strong></span>
                        <span>Earned: <strong style={{ color: "#22cf9d" }}>{Number(pos.earned_interest ?? 0).toFixed(4)} XLM</strong></span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </section>

        {/* ── Transaction History ──────────────────────────── */}
        {txHistory.length > 0 && (
          <section className="workspace-card workspace-card--full" style={{ marginTop: "1rem" }}>
            <h2 className="workspace-card-title">Recent Activity</h2>
            <div className="workspace-table-wrap">
              <table className="workspace-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {txHistory.map((tx) => {
                    let txHash = "";
                    try {
                      const meta = JSON.parse(String(tx.metadata || "{}"));
                      txHash = meta.txHash ?? "";
                    } catch {}

                    const isDeposit = tx.category === "deposit";

                    return (
                      <tr key={String(tx.id)}>
                        <td style={{ opacity: 0.8, fontSize: "0.85rem" }}>
                          {tx.created_at ? new Date(String(tx.created_at)).toLocaleDateString() : "—"}
                        </td>
                        <td>
                          <span style={{ 
                            padding: "0.15rem 0.5rem", borderRadius: "9999px", fontSize: "0.75rem", fontWeight: 600,
                            background: isDeposit ? "rgba(34,207,157,0.12)" : "rgba(155,111,224,0.12)",
                            color: isDeposit ? "#22cf9d" : "#9b6fe0" 
                          }}>
                            {String(tx.category ?? "Unknown").toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{Number(tx.amount || 0).toFixed(2)} XLM</td>
                        <td style={{ opacity: 0.7, fontSize: "0.85rem", textTransform: "capitalize" }}>{tx.status}</td>
                        <td>
                          {isLikelyTxHash(txHash) ? (
                            <a
                              href={buildStellarTxVerificationUrl(txHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="workspace-nav-link"
                              style={{ display: "inline-block", background: "rgba(34,207,157,0.1)", color: "#22cf9d", padding: "0.3rem 0.6rem", borderRadius: "0.4rem", fontSize: "0.75rem" }}
                            >
                              ✅ Verify Tx ↗
                            </a>
                          ) : (
                            <span style={{ opacity: 0.4, fontSize: "0.8rem", fontStyle: "italic" }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

      </div>
    </WorkspaceFrame>
  );
}
