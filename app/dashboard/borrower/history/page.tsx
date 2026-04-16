import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getBorrowerDashboardMetrics, presentBorrowerMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/Badge";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";

const BORROWER_NAV = [
  { href: "/dashboard/borrower",         label: "Home" },
  { href: "/dashboard/borrower/loans",   label: "Apply for Loan" },
  { href: "/dashboard/borrower/repay",   label: "Repay Loan" },
  { href: "/dashboard/borrower/history", label: "Loan History" },
  { href: "/dashboard/borrower/tasks",   label: "Trust Tasks" },
  { href: "/dashboard/borrower/profile", label: "Profile & Settings" },
];

export default async function BorrowerHistoryPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics  = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  const [profileRes, loansRes] = supabase
    ? await Promise.all([
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("loans")
          .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, due_at, created_at")
          .eq("borrower_id", user.id)
          .order("created_at", { ascending: false })
          .limit(50),
      ])
    : [{ data: null }, { data: [] }];

  const loans = loansRes.data ?? [];

  // Fetch Stellar TX hashes
  const loanIds = loans.map((l) => String(l.id));
  const ledgerRes = srClient && loanIds.length > 0
    ? await srClient
        .from("ledger_transactions")
        .select("ref_id, metadata, created_at")
        .eq("ref_type", "loan_fund")
        .in("ref_id", loanIds)
    : { data: [] };

  const loanTxMap: Record<string, string> = {};
  for (const entry of ledgerRes.data ?? []) {
    try {
      const meta = JSON.parse(String(entry.metadata ?? "{}"));
      if (meta.txHash) loanTxMap[String(entry.ref_id)] = String(meta.txHash);
    } catch { /* ignore */ }
  }

  // Summary stats
  const totalBorrowed = loans.reduce((s, l) => s + Number(l.principal_amount ?? 0), 0);
  const totalRepaid   = loans.reduce((s, l) => s + Number(l.repaid_amount ?? 0), 0);
  const repaidCount   = loans.filter((l) => l.status === "repaid").length;
  const activeCount   = loans.filter((l) => l.status === "active").length;

  const statusVariant = (s: string): "yellow" | "blue" | "green" | "gold" => {
    if (s === "requested") return "yellow";
    if (s === "approved")  return "blue";
    if (s === "active")    return "green";
    return "gold";
  };

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Loan History"
      description="A complete record of all your loan requests, active loans, and repayments."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profileRes.data?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/history"
      links={BORROWER_NAV}
    >
      <div className="workspace-stack">

        {/* Summary cards */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
          {[
            { label: "Total Borrowed",  value: `${totalBorrowed.toFixed(2)} XLM` },
            { label: "Total Repaid",    value: `${totalRepaid.toFixed(2)} XLM` },
            { label: "Repaid Loans",    value: String(repaidCount) },
            { label: "Active Loans",    value: String(activeCount) },
          ].map((s) => (
            <article key={s.label} className="role-metric-card" style={{ padding: "1.1rem 1.25rem" }}>
              <p className="role-metric-value font-display" style={{ fontSize: "1.3rem" }}>{s.value}</p>
              <p className="role-metric-label">{s.label}</p>
            </article>
          ))}
        </section>

        {/* Full loan table */}
        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title" style={{ marginBottom: "1rem" }}>All Loans</h2>
          {loans.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2rem", opacity: 0.5 }}>
              <p>No loan history yet.</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #eef0f8" }}>
                    {["Date", "Loan ID", "Principal", "Repaid", "Status", "APR", "Duration", "Due", "Stellar TX"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "0.6rem 0.75rem", fontSize: "0.72rem", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loans.map((loan) => {
                    const status = String(loan.status);
                    const loanId = String(loan.id);
                    const txHash = loanTxMap[loanId] ?? "";
                    const hasTx  = isLikelyTxHash(txHash);
                    return (
                      <tr key={loanId} style={{ borderBottom: "1px solid #f3f4f6" }}>
                        <td style={{ padding: "0.75rem", fontSize: "0.8rem", color: "#6b7280", whiteSpace: "nowrap" }}>
                          {loan.created_at ? new Date(String(loan.created_at)).toLocaleDateString() : "—"}
                        </td>
                        <td style={{ padding: "0.75rem", fontFamily: "monospace", fontSize: "0.8rem", color: "#6b7280" }}>
                          {loanId.slice(0, 8)}
                        </td>
                        <td style={{ padding: "0.75rem", fontWeight: 700 }}>
                          {Number(loan.principal_amount).toFixed(2)} XLM
                        </td>
                        <td style={{ padding: "0.75rem", color: "#22cf9d", fontWeight: 600 }}>
                          {Number(loan.repaid_amount ?? 0).toFixed(2)} XLM
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          <Badge variant={statusVariant(status)}>{status.toUpperCase()}</Badge>
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          {(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          {loan.duration_days} days
                        </td>
                        <td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
                          {loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "—"}
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
                            <span style={{ fontSize: "0.75rem", opacity: 0.4, whiteSpace: "nowrap" }}>
                              {status === "requested" || status === "approved" ? "⏳ Pending" : "—"}
                            </span>
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
