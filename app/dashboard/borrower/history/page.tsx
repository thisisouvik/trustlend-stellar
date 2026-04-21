import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getBorrowerDashboardMetrics, presentBorrowerMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";
import { borrowerNavLinks } from "@/lib/dashboard/borrower-links";

export default async function BorrowerHistoryPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics  = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();

  const [profileRes, loansRes] = supabase
    ? await Promise.all([
        supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
        supabase
          .from("loans")
          .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, due_at, created_at")
          .eq("borrower_id", user.id)
          .order("created_at", { ascending: false })
          .limit(50),
      ])
    : [{ data: null }, { data: [] }];

  const loans = loansRes.data ?? [];
  const loanIds = loans.map((l) => String(l.id));

  // Fetch Stellar TX hashes for funded loans
  const ledgerRes = supabase && loanIds.length > 0
    ? await supabase
        .from("ledger_transactions")
        .select("ref_id, metadata, created_at, amount")
        .eq("ref_type", "loan_fund")
        .in("ref_id", loanIds)
    : { data: [] };

  const loanTxMap: Record<string, { hash: string; amount: number; date: string }> = {};
  for (const entry of ledgerRes.data ?? []) {
    try {
      const meta = JSON.parse(String(entry.metadata ?? "{}"));
      if (String(entry.ref_id)) {
        loanTxMap[String(entry.ref_id)] = {
          hash:   String(meta.txHash ?? ""),
          amount: Number(entry.amount ?? 0),
          date:   String(entry.created_at ?? ""),
        };
      }
    } catch { /* ignore */ }
  }

  // Fetch all repayments for borrower's loans using the primary table
  const repaymentsRes = supabase && loanIds.length > 0
    ? await supabase
        .from("loan_repayments")
        .select("id, loan_id, amount, created_at")
        .in("loan_id", loanIds)
        .order("created_at", { ascending: false })
        .limit(100)
    : { data: [] };

  const repayments = repaymentsRes.data ?? [];
  const repaymentIds = repayments.map(r => String(r.id));

  // Fetch stellar transaction details for those repayments (if on-chain)
  const repayTxsRes = supabase && repaymentIds.length > 0
    ? await supabase
        .from("ledger_transactions")
        .select("ref_id, metadata")
        .eq("ref_type", "loan_repay")
        .in("ref_id", repaymentIds)
    : { data: [] };

  const repayTxMap: Record<string, string> = {};
  for (const t of repayTxsRes.data ?? []) {
    try {
      const meta = JSON.parse(String(t.metadata ?? "{}"));
      if (meta.txHash) repayTxMap[String(t.ref_id)] = String(meta.txHash);
    } catch { /* ignore */ }
  }

  // Build unified transaction feed
  interface TxEntry {
    id: string;
    type: "funding_received" | "repayment_made";
    loanId: string;
    amount: number;
    date: string;
    txHash: string;
    loanStatus: string;
  }

  const transactions: TxEntry[] = [];

  // Funding events
  for (const loan of loans) {
    const loanId = String(loan.id);
    const ledger = loanTxMap[loanId];
    if (ledger && ledger.amount > 0) {
      transactions.push({
        id: `fund-${loanId}`,
        type: "funding_received",
        loanId,
        amount: ledger.amount,
        date: ledger.date || String(loan.created_at ?? ""),
        txHash: ledger.hash,
        loanStatus: String(loan.status),
      });
    }
  }

  // Repayment events
  for (const r of repayments) {
    const loan = loans.find((l) => String(l.id) === String(r.loan_id));
    const txHash = repayTxMap[String(r.id)] ?? "";

    transactions.push({
      id: `repay-${r.id}`,
      type: "repayment_made",
      loanId: String(r.loan_id),
      amount: Number(r.amount),
      date: String(r.created_at ?? ""),
      txHash,
      loanStatus: String(loan?.status ?? ""),
    });
  }

  // Sort by date descending
  transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Summary stats
  const totalFunded  = transactions.filter((t) => t.type === "funding_received").reduce((s, t) => s + t.amount, 0);
  const totalRepaid  = transactions.filter((t) => t.type === "repayment_made").reduce((s, t) => s + t.amount, 0);

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Transaction History"
      description="Every funding received and repayment made — with on-chain verification links."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profileRes.data?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/history"
      links={borrowerNavLinks}
    >
      <div className="workspace-stack">

        {/* Summary cards */}
        {/* Summary cards */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
          {[
            { label: "Total Received",   value: `${totalFunded.toFixed(2)} XLM`,   icon: "📥", color: "#7e2fd0" },
            { label: "Total Repaid",     value: `${totalRepaid.toFixed(2)} XLM`,   icon: "📤", color: "#22cf9d" },
            { label: "Transactions",     value: String(transactions.length),        icon: "🔢", color: "#6b7280" },
          ].map((s) => (
            <article key={s.label} style={{
              padding: "1.1rem 1.25rem", borderRadius: "0.9rem",
              background: "#fff", border: "1px solid #eef0f8",
              boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
            }}>
              <div style={{ fontSize: "1.5rem", marginBottom: "0.35rem" }}>{s.icon}</div>
              <p style={{ fontSize: "1.2rem", fontWeight: 800, color: s.color, margin: "0 0 0.2rem", fontFamily: "system-ui" }}>{s.value}</p>
              <p style={{ fontSize: "0.75rem", color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", margin: 0 }}>{s.label}</p>
            </article>
          ))}
        </section>

        {/* Unified transaction feed */}
        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title" style={{ marginBottom: "1.25rem" }}>All Transactions</h2>

          {transactions.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2.5rem", opacity: 0.5 }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>📋</div>
              <p>No transactions yet.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              {transactions.map((tx) => {
                const isFunding = tx.type === "funding_received";
                const hasTx     = isLikelyTxHash(tx.txHash);
                return (
                  <div key={tx.id} style={{
                    display: "flex", alignItems: "center", gap: "1rem",
                    padding: "0.9rem 1rem", borderRadius: "0.65rem",
                    background: isFunding ? "rgba(126,47,208,0.04)" : "rgba(34,207,157,0.04)",
                    border: `1px solid ${isFunding ? "rgba(126,47,208,0.12)" : "rgba(34,207,157,0.12)"}`,
                    flexWrap: "wrap",
                  }}>
                    {/* Icon */}
                    <div style={{
                      width: "38px", height: "38px", borderRadius: "50%", flexShrink: 0,
                      background: isFunding ? "rgba(126,47,208,0.1)" : "rgba(34,207,157,0.1)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: "1.1rem",
                    }}>
                      {isFunding ? "📥" : "📤"}
                    </div>

                    {/* Details */}
                    <div style={{ flex: 1, minWidth: "200px" }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: "0.88rem", color: "#111827" }}>
                        {isFunding ? "Funding Received" : "Repayment Made"}
                      </p>
                      <p style={{ margin: "0.15rem 0 0", fontSize: "0.75rem", color: "#9ca3af", fontFamily: "monospace" }}>
                        Loan #{tx.loanId.slice(0, 8)}
                        {" · "}
                        {tx.date ? new Date(tx.date).toLocaleString() : "—"}
                      </p>
                    </div>

                    {/* Amount */}
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <p style={{ margin: 0, fontWeight: 800, fontSize: "0.95rem", color: isFunding ? "#7e2fd0" : "#22cf9d" }}>
                        {isFunding ? "+" : "-"}{tx.amount.toFixed(2)} XLM
                      </p>
                      <span style={{
                        fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase",
                        color: tx.loanStatus === "repaid" ? "#22cf9d" : tx.loanStatus === "active" || tx.loanStatus === "funded" ? "#f5a623" : "#9ca3af",
                      }}>
                        {tx.loanStatus || "—"}
                      </span>
                    </div>

                    {/* Verify link */}
                    {hasTx ? (
                      <a
                        href={buildStellarTxVerificationUrl(tx.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          display: "inline-flex", alignItems: "center", gap: "0.3rem",
                          padding: "0.35rem 0.75rem", borderRadius: "0.4rem",
                          background: "rgba(34,207,157,0.1)", border: "1px solid rgba(34,207,157,0.25)",
                          fontSize: "0.75rem", fontWeight: 700, color: "#22cf9d",
                          textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0,
                        }}
                      >
                        ✅ Verify on Stellar ↗
                      </a>
                    ) : isFunding ? (
                      <span style={{ fontSize: "0.72rem", color: "#d1d5db", whiteSpace: "nowrap", flexShrink: 0 }}>
                        ⏳ Awaiting TX
                      </span>
                    ) : (
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: "0.3rem",
                        padding: "0.35rem 0.75rem", borderRadius: "0.4rem",
                        background: "rgba(107,114,128,0.08)", border: "1px solid rgba(107,114,128,0.15)",
                        fontSize: "0.72rem", color: "#6b7280", whiteSpace: "nowrap", flexShrink: 0,
                      }}>
                        📋 Off-chain record
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </article>

      </div>
    </WorkspaceFrame>
  );
}
