import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { BorrowerRepayWidget } from "@/components/dashboard/BorrowerRepayWidget";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getBorrowerDashboardMetrics, presentBorrowerMetrics } from "@/lib/dashboard/metrics";
import { borrowerNavLinks } from "@/lib/dashboard/borrower-links";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/Badge";

export default async function BorrowerRepayPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics  = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const [loansRes, profileRes] = supabase
    ? await Promise.all([
        supabase
          .from("loans")
          .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, due_at, created_at")
          .eq("borrower_id", user.id)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
      ])
    : [{ data: [] }, { data: null }];

  const loans   = loansRes.data ?? [];
  const profile = profileRes.data;

  // Repayable = any loan that has been funded/disbursed (not yet repaid or defaulted)
  // Statuses: "funded" (just funded by lender), "active" (repayment in progress)
  const REPAYABLE_STATUSES = ["active", "funded", "approved"];
  const repayableLoans = loans.filter((l) => REPAYABLE_STATUSES.includes(String(l.status)));
  const repayableLoan  = repayableLoans[0] ?? null;
  const pendingLoans = loans.filter((l) => String(l.status) === "requested");
  const dueAmount = repayableLoan
    ? Math.max(0, Number(repayableLoan.principal_amount ?? 0) - Number(repayableLoan.repaid_amount ?? 0))
    : 0;

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Repay Loan"
      description="Make a repayment on your active loan. Each repayment increases your Trust Score."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/repay"
      links={borrowerNavLinks}
    >
      <div className="workspace-stack">
        {!repayableLoan ? (
          <article className="workspace-card workspace-card--full" style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>✅</div>
            <h2 className="workspace-card-title">No Active Loans</h2>
            <p className="workspace-card-copy" style={{ marginTop: "0.4rem" }}>
              {loans.some((l) => ["requested"].includes(String(l.status)))
                ? "Your loan request is pending lender funding. Repayment will be available once a lender funds it."
                : "You have no loans to repay. Apply for a new loan using the 'Apply for Loan' section."}
            </p>
            <a href="/dashboard/borrower/loans" style={{ display: "inline-block", marginTop: "1rem", padding: "0.6rem 1.5rem", background: "#7e2fd0", color: "#fff", borderRadius: "0.5rem", fontSize: "0.875rem", fontWeight: 700, textDecoration: "none" }}>
              Apply for a Loan →
            </a>
          </article>
        ) : (
          <>
            {/* Trust score incentive */}
            <article className="workspace-card workspace-card--full" style={{ background: "rgba(34,207,157,0.04)", borderColor: "rgba(34,207,157,0.2)" }}>
              <p style={{ fontSize: "0.875rem", color: "#20bd8e", fontWeight: 600, margin: 0 }}>
                💡 Each on-time repayment earns you <strong>+5 Trust Points</strong>. Fully repaying earns <strong>+20 points</strong> and increases your credit limit.
              </p>
            </article>

            <BorrowerRepayWidget
              loan={{
                id: String(repayableLoan.id),
                principal_amount: Number(repayableLoan.principal_amount),
                repaid_amount: Number(repayableLoan.repaid_amount ?? 0),
                due_at: repayableLoan.due_at ? String(repayableLoan.due_at) : null,
              }}
              dueAmount={dueAmount}
            />

            {/* All loans history */}
            {loans.length > 1 && (
              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title" style={{ marginBottom: "1rem" }}>Loan History</h2>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #eef0f8" }}>
                        {["Loan ID", "Amount", "Status", "Repaid", "Due Date"].map((h) => (
                          <th key={h} style={{ textAlign: "left", padding: "0.6rem 0.75rem", fontSize: "0.72rem", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {loans.map((loan) => (
                        <tr key={String(loan.id)} style={{ borderBottom: "1px solid #f9fafb" }}>
                          <td style={{ padding: "0.75rem", fontFamily: "monospace", fontSize: "0.8rem", color: "#6b7280" }}>{String(loan.id).slice(0, 8)}</td>
                          <td style={{ padding: "0.75rem", fontWeight: 700 }}>{Number(loan.principal_amount).toFixed(2)} XLM</td>
                          <td style={{ padding: "0.75rem" }}>
                            <Badge variant={
                              (loan.status === "active" || loan.status === "funded") ? "green"  :
                              loan.status === "repaid"    ? "gold"   :
                              loan.status === "requested" ? "yellow" : "blue"
                            }>
                              {String(loan.status).toUpperCase()}
                            </Badge>
                          </td>
                          <td style={{ padding: "0.75rem" }}>{Number(loan.repaid_amount ?? 0).toFixed(2)} XLM</td>
                          <td style={{ padding: "0.75rem" }}>{loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            )}
          </>
        )}

        {pendingLoans.length > 0 && (
          <article className="workspace-card workspace-card--full" style={{ borderColor: "rgba(245,166,35,0.25)", background: "rgba(245,166,35,0.04)" }}>
            <h2 className="workspace-card-title">Pending Loan Request{pendingLoans.length > 1 ? "s" : ""}</h2>
            <p className="workspace-card-copy" style={{ marginTop: "0.35rem" }}>
              You have {pendingLoans.length} submitted request{pendingLoans.length > 1 ? "s" : ""} waiting for funding.
            </p>
            <div style={{ display: "grid", gap: "0.75rem", marginTop: "1rem" }}>
              {pendingLoans.slice(0, 3).map((loan) => (
                <div
                  key={String(loan.id)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "1rem",
                    alignItems: "center",
                    padding: "0.85rem 1rem",
                    borderRadius: "0.7rem",
                    background: "rgba(255,255,255,0.75)",
                    border: "1px solid rgba(245,166,35,0.18)",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <p style={{ fontWeight: 700, margin: 0 }}>Loan #{String(loan.id).slice(0, 8)}</p>
                    <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0.15rem 0 0" }}>
                      Requested {loan.created_at ? new Date(String(loan.created_at)).toLocaleDateString() : "recently"}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ margin: 0, fontWeight: 800, color: "#7e2fd0" }}>{Number(loan.principal_amount ?? 0).toFixed(2)} XLM</p>
                    <p style={{ fontSize: "0.75rem", color: "#f59e0b", fontWeight: 700, margin: "0.15rem 0 0" }}>REQUESTED</p>
                  </div>
                </div>
              ))}
            </div>
          </article>
        )}
      </div>
    </WorkspaceFrame>
  );
}
