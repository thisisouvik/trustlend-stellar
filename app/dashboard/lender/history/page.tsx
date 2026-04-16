import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";

export default async function LenderHistoryPage() {
  const { user }  = await requireAuthenticatedUser("lender");
  const metrics   = await getLenderDashboardMetrics(user.id);
  const supabase  = await getServerSupabaseClient();
  const srClient  = getServiceRoleClient();

  const [profileRes, fundedTxsRes] = supabase
    ? await Promise.all([
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("ledger_transactions")
          .select("id, ref_id, amount, currency, status, metadata, created_at")
          .eq("user_id", user.id)
          .eq("ref_type", "loan_fund")
          .order("created_at", { ascending: false })
          .limit(50),
      ])
    : [{ data: null }, { data: [] }];

  const txs = fundedTxsRes.data ?? [];

  // Enrich with loan status from service role
  const loanIds = txs.map((t) => String(t.ref_id));
  const loansRes = srClient && loanIds.length > 0
    ? await srClient
        .from("loans")
        .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, due_at")
        .in("id", loanIds)
    : { data: [] };

  const loanMap = Object.fromEntries(
    (loansRes.data ?? []).map((l) => [String(l.id), l])
  );

  // Summary
  const totalDeployed = txs.reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const activeCount   = txs.filter((t) => {
    const loan = loanMap[String(t.ref_id)];
    return loan?.status === "active";
  }).length;
  const repaidCount   = txs.filter((t) => {
    const loan = loanMap[String(t.ref_id)];
    return loan?.status === "repaid";
  }).length;

  const loanStatusColor = (s: string) =>
    s === "active" ? "#22cf9d" : s === "repaid" ? "#9b6fe0" : s === "defaulted" ? "#ef4444" : "#f5a623";

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Transaction History"
      description="A full record of every loan you have funded, with on-chain verification links."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profileRes.data?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/history"
      links={lenderNavLinks}
    >
      <div className="workspace-stack">

        {/* Summary strip */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
          {[
            { label: "Total Deployed",    value: `${totalDeployed.toFixed(2)} XLM` },
            { label: "Loans Funded",      value: String(txs.length) },
            { label: "Currently Active",  value: String(activeCount) },
            { label: "Fully Repaid",      value: String(repaidCount) },
          ].map((s) => (
            <article key={s.label} className="role-metric-card" style={{ padding: "1.1rem 1.25rem" }}>
              <p className="role-metric-value font-display" style={{ fontSize: "1.3rem" }}>{s.value}</p>
              <p className="role-metric-label">{s.label}</p>
            </article>
          ))}
        </section>

        {/* Transaction table */}
        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title" style={{ marginBottom: "1rem" }}>Funded Loans</h2>
          {txs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2rem", opacity: 0.5 }}>
              <p>You haven't funded any loans yet.</p>
              <a href="/dashboard/lender/marketplace" style={{ display: "inline-block", marginTop: "0.75rem", fontSize: "0.85rem", color: "#7e2fd0", fontWeight: 600 }}>
                Browse Loan Marketplace →
              </a>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #eef0f8" }}>
                    {["Date", "Loan ID", "Amount Sent", "Loan Status", "APR", "Due Date", "Repaid", "Stellar TX"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "0.6rem 0.75rem", fontSize: "0.72rem", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {txs.map((tx) => {
                    const loanId = String(tx.ref_id);
                    const loan   = loanMap[loanId];
                    let txHash   = "";
                    try {
                      const meta = JSON.parse(String(tx.metadata ?? "{}"));
                      txHash = String(meta.txHash ?? "");
                    } catch { /* ok */ }
                    const hasTx = isLikelyTxHash(txHash);
                    const status = loan?.status ?? "unknown";

                    return (
                      <tr key={String(tx.id)} style={{ borderBottom: "1px solid #f3f4f6" }}>
                        <td style={{ padding: "0.75rem", fontSize: "0.8rem", color: "#6b7280", whiteSpace: "nowrap" }}>
                          {tx.created_at ? new Date(String(tx.created_at)).toLocaleDateString() : "—"}
                        </td>
                        <td style={{ padding: "0.75rem", fontFamily: "monospace", fontSize: "0.8rem", color: "#6b7280" }}>
                          {loanId.slice(0, 8)}
                        </td>
                        <td style={{ padding: "0.75rem", fontWeight: 700 }}>
                          {Number(tx.amount).toFixed(2)} {tx.currency ?? "XLM"}
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          <span style={{ fontSize: "0.78rem", fontWeight: 700, color: loanStatusColor(status), background: `${loanStatusColor(status)}15`, padding: "0.15rem 0.6rem", borderRadius: "9999px", border: `1px solid ${loanStatusColor(status)}33` }}>
                            {status.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          {loan ? `${(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%` : "—"}
                        </td>
                        <td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
                          {loan?.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "—"}
                        </td>
                        <td style={{ padding: "0.75rem", color: "#22cf9d", fontWeight: 600 }}>
                          {loan ? `${Number(loan.repaid_amount ?? 0).toFixed(2)} XLM` : "—"}
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          {hasTx ? (
                            <a
                              href={buildStellarTxVerificationUrl(txHash)}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: "0.78rem", color: "#22cf9d", fontWeight: 600, whiteSpace: "nowrap" }}
                            >
                              ✅ Verify ↗
                            </a>
                          ) : (
                            <span style={{ fontSize: "0.75rem", opacity: 0.4 }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

      </div>
    </WorkspaceFrame>
  );
}
