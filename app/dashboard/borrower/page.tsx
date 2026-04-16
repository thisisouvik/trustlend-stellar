import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { Badge } from "@/components/ui/Badge";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getBorrowerDashboardMetrics,
  presentBorrowerMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";
import { BorrowerRepayWidget } from "@/components/dashboard/BorrowerRepayWidget";
import { borrowerNavLinks } from "@/lib/dashboard/borrower-links";

export default async function BorrowerDashboardPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();

  const [profileRes, loansRes] = supabase
    ? await Promise.all([
        supabase
          .from("profiles")
          .select("full_name, phone, country_code, kyc_status, risk_status")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("loans")
          .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, due_at, created_at")
          .eq("borrower_id", user.id)
          .order("created_at", { ascending: false })
          .limit(20),
      ])
    : [{ data: null }, { data: [] }];

  const profile = profileRes.data;
  const loans = loansRes.data ?? [];

  // Stellar TX lookups
  const srClient = getServiceRoleClient();
  const loanIds = loans.map((l) => String(l.id));
  const ledgerRes = srClient && loanIds.length > 0
    ? await srClient
        .from("ledger_transactions")
        .select("ref_id, metadata")
        .eq("ref_type", "loan_fund")
        .in("ref_id", loanIds)
    : { data: [] };
  const loanTxMap: Record<string, string> = {};
  for (const entry of ledgerRes.data ?? []) {
    try {
      const meta = JSON.parse(String(entry.metadata ?? "{}"));
      if (meta.txHash && String(entry.ref_id)) loanTxMap[String(entry.ref_id)] = String(meta.txHash);
    } catch { /* ignore */ }
  }

  const isKycVerified = profile?.kyc_status === "verified";

  const verificationItems = [
    { label: "Email Verified",          done: Boolean(user.email_confirmed_at) },
    { label: "Legal Name Set",          done: Boolean(profile?.full_name) },
    { label: "Phone Number",            done: Boolean(profile?.phone) },
    { label: "Government ID (KYC)",     done: isKycVerified },
  ];
  const verificationProgress = Math.round((verificationItems.filter((i) => i.done).length / verificationItems.length) * 100);
  const canApplyLoan = verificationProgress === 100;

  const activeLoans = loans.filter((l) => l.status === "active");
  const pendingLoans = loans.filter((l) => ["requested", "approved"].includes(String(l.status)));
  const inLoansXlm = activeLoans.reduce((sum, l) => sum + Number(l.principal_amount ?? 0), 0);
  const pendingXlm = pendingLoans.reduce((sum, l) => sum + Number(l.principal_amount ?? 0), 0);

  // Active loan for repayment widget
  const repayableLoan = activeLoans[0] ?? null;
  const dueAmount = repayableLoan
    ? Math.max(0, Number(repayableLoan.principal_amount ?? 0) - Number(repayableLoan.repaid_amount ?? 0))
    : 0;

  const statusBadge = (s: string): "yellow" | "blue" | "green" | "gold" => {
    if (s === "requested") return "yellow";
    if (s === "approved")  return "blue";
    if (s === "active")    return "green";
    return "gold";
  };

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="My Dashboard"
      description="Your active loans, verification status, and quick actions — all in one place."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      headerWidget={
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={inLoansXlm}
          pending={pendingXlm}
          inLoansLabel="In Loans"
          compact
        />
      }
      currentPath="/dashboard/borrower"
      profilePath="/dashboard/borrower/profile"
      profileSummary={canApplyLoan ? undefined : {
        completion: verificationProgress,
        kycStatus: String(profile?.kyc_status ?? "pending"),
        warningText: profile?.kyc_status === "submitted" && !isKycVerified
          ? "Your documents are under admin review."
          : "Complete your profile to unlock borrowing.",
        requiredItems: verificationItems.filter((i) => !i.done).map((i) => i.label),
      }}
      showProfileAlert={!canApplyLoan}
      links={borrowerNavLinks}
    >
      <div className="workspace-stack">

        {/* ── Wallet prompt ── */}
        {!walletAddress && (
          <article className="workspace-card workspace-card--full" style={{ borderColor: "rgba(245,166,35,0.3)", background: "rgba(245,166,35,0.04)" }}>
            <h2 className="workspace-card-title">⚠️ Connect Your Wallet</h2>
            <p className="workspace-card-copy" style={{ marginTop: "0.4rem" }}>
              You need to connect a Stellar wallet before you can receive or repay loans.
              Head to <strong>Profile &amp; Settings</strong> to set it up.
            </p>
          </article>
        )}

        {/* ── KYC / verification status strip ── */}
        <article className="workspace-card workspace-card--full">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 className="workspace-card-title" style={{ margin: 0 }}>Verification Status</h2>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: verificationProgress === 100 ? "#22cf9d" : "#f5a623" }}>
              {verificationProgress}% Complete
            </span>
          </div>
          <div style={{ height: "6px", borderRadius: "9999px", background: "#eef0f8", marginBottom: "1rem", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${verificationProgress}%`, background: "linear-gradient(90deg,#7e2fd0,#22cf9d)", borderRadius: "9999px", transition: "width 0.4s ease" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.6rem" }}>
            {verificationItems.map((item) => (
              <div
                key={item.label}
                style={{
                  display: "flex", alignItems: "center", gap: "0.5rem",
                  padding: "0.5rem 0.75rem", borderRadius: "0.5rem",
                  background: item.done ? "rgba(34,207,157,0.06)" : "rgba(0,0,0,0.03)",
                  border: `1px solid ${item.done ? "rgba(34,207,157,0.2)" : "rgba(0,0,0,0.06)"}`,
                }}
              >
                <span style={{ fontSize: "1rem" }}>{item.done ? "✅" : "○"}</span>
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: item.done ? "#20bd8e" : "#6b7280" }}>{item.label}</span>
              </div>
            ))}
          </div>
          {!canApplyLoan && (
            <a
              href="/dashboard/borrower/profile"
              style={{ display: "inline-block", marginTop: "1rem", fontSize: "0.82rem", color: "#7e2fd0", fontWeight: 600, textDecoration: "underline" }}
            >
              Complete profile →
            </a>
          )}
        </article>

        {/* ── Active / pending loans summary ── */}
        {loans.length > 0 && (
          <article className="workspace-card workspace-card--full">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h2 className="workspace-card-title" style={{ margin: 0 }}>Your Loans</h2>
              <a href="/dashboard/borrower/history" style={{ fontSize: "0.82rem", color: "#7e2fd0", fontWeight: 600, textDecoration: "none" }}>
                View full history →
              </a>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #eef0f8" }}>
                    {["Loan ID", "Amount", "Status", "APR", "Due", "Stellar TX"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "0.6rem 0.75rem", fontSize: "0.72rem", fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loans.slice(0, 5).map((loan) => {
                    const status = String(loan.status);
                    const loanId = String(loan.id);
                    const txHash = loanTxMap[loanId] ?? "";
                    const hasTx  = isLikelyTxHash(txHash);
                    return (
                      <tr key={loanId} style={{ borderBottom: "1px solid #f9fafb" }}>
                        <td style={{ padding: "0.75rem", fontFamily: "monospace", fontSize: "0.8rem", color: "#6b7280" }}>{loanId.slice(0, 8)}</td>
                        <td style={{ padding: "0.75rem", fontWeight: 700 }}>{Number(loan.principal_amount).toFixed(2)} XLM</td>
                          <td style={{ padding: "0.75rem" }}>
                            <Badge variant={statusBadge(status)}>{status.toUpperCase()}</Badge>
                          </td>
                        <td style={{ padding: "0.75rem" }}>{(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                        <td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
                          {loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "—"}
                        </td>
                        <td style={{ padding: "0.75rem" }}>
                          {hasTx ? (
                            <a href={buildStellarTxVerificationUrl(txHash)} target="_blank" rel="noreferrer"
                              style={{ fontSize: "0.78rem", color: "#22cf9d", fontWeight: 600, whiteSpace: "nowrap" }}>
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
          </article>
        )}

        {/* ── Quick Repayment Widget (if active loan) ── */}
        {repayableLoan && (
          <BorrowerRepayWidget
            loan={{
              id: String(repayableLoan.id),
              principal_amount: Number(repayableLoan.principal_amount),
              repaid_amount: Number(repayableLoan.repaid_amount ?? 0),
              due_at: repayableLoan.due_at ? String(repayableLoan.due_at) : null,
            }}
            dueAmount={dueAmount}
          />
        )}

        {/* ── Empty state (no loans) ── */}
        {loans.length === 0 && (
          <article className="workspace-card workspace-card--full" style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}>
            <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>📋</div>
            <h2 className="workspace-card-title">No Loans Yet</h2>
            <p className="workspace-card-copy" style={{ margin: "0.5rem auto", maxWidth: "380px" }}>
              {canApplyLoan
                ? "You're verified and ready! Head to 'Apply for Loan' to submit your first loan request."
                : "Complete your verification first, then you can apply for a loan."}
            </p>
            <a
              href={canApplyLoan ? "/dashboard/borrower/loans" : "/dashboard/borrower/profile"}
              style={{ display: "inline-block", marginTop: "1rem", padding: "0.6rem 1.5rem", background: "#7e2fd0", color: "#fff", borderRadius: "0.5rem", fontSize: "0.875rem", fontWeight: 700, textDecoration: "none" }}
            >
              {canApplyLoan ? "Apply for a Loan →" : "Complete Profile →"}
            </a>
          </article>
        )}

      </div>
    </WorkspaceFrame>
  );
}
