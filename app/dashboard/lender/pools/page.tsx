import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LenderForms } from "@/components/dashboard/LenderForms";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { formatCurrency } from "@/lib/utils/formatting";

export default async function LenderPoolsPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();

  const [poolsRes, positionsRes, profileRes] = supabase
    ? await Promise.all([
        supabase
          .from("lending_pools")
          .select("id, name, status, apr_bps, total_liquidity, available_liquidity")
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("pool_positions")
          .select("id, pool_id, status, principal_amount, earned_interest")
          .eq("lender_id", user.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("profiles")
          .select("full_name, kyc_status")
          .eq("id", user.id)
          .maybeSingle(),
      ])
    : [{ data: [] }, { data: [] }, { data: null }];

  const pools     = poolsRes.data     ?? [];
  const positions = positionsRes.data ?? [];
  const profile   = profileRes.data;

  const totalDeployed = positions.reduce((s, p) => s + Number(p.principal_amount ?? 0), 0);
  const totalEarned   = positions.reduce((s, p) => s + Number(p.earned_interest   ?? 0), 0);

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
        <section className="workspace-grid workspace-grid--three">
          {[
            { label: "Your Total Deployed", value: `${totalDeployed.toFixed(2)} XLM` },
            { label: "Total Interest Earned", value: `${totalEarned.toFixed(4)} XLM`, green: true },
            { label: "Active Positions", value: String(positions.filter((p) => p.status === "active").length) },
          ].map((stat) => (
            <article key={stat.label} className="workspace-card">
              <p style={{ fontSize: "0.78rem", opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.35rem" }}>
                {stat.label}
              </p>
              <p style={{ fontSize: "1.6rem", fontWeight: 700, color: stat.green ? "#22cf9d" : "inherit" }}>
                {stat.value}
              </p>
            </article>
          ))}
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

      </div>
    </WorkspaceFrame>
  );
}
