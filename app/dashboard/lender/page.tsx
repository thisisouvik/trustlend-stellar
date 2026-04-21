import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils/formatting";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import Link from "next/link";

export default async function LenderHomePage() {
  const { user } = await requireAuthenticatedUser("lender");
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getLenderDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();

  const [positionsRes, profileRes, p2pRes, openLoanCountRes, allLoansRes, repaysRes] = supabase
    ? await Promise.all([
        supabase
          .from("pool_positions")
          .select("id, pool_id, status, principal_amount, earned_interest")
          .eq("lender_id", user.id)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("profiles")
          .select("full_name, kyc_status")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("ledger_transactions")
          .select("id, ref_id, amount, status, metadata, created_at")
          .eq("user_id", user.id)
          .eq("ref_type", "loan_fund")
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("loans")
          .select("id", { count: "exact", head: true })
          .in("status", ["requested", "approved"]),
        supabase
          .from("loans")
          .select("id, status, repaid_amount, principal_amount"),
        supabase
          .from("ledger_transactions")
          .select("ref_id, metadata")
          .eq("ref_type", "loan_repay")
      ])
    : [{ data: [] }, { data: null }, { data: [] }, { count: 0 }, { data: [] }, { data: [] }];

  const positions     = positionsRes.data ?? [];
  const p2pInvestments = p2pRes.data ?? [];
  const profile       = profileRes.data;
  const openLoanCount = openLoanCountRes.count ?? 0;
  const isKycVerified = profile?.kyc_status === "verified";
  
  const allLoansArray = allLoansRes.data ?? [];
  const loanMap = Object.fromEntries(allLoansArray.map(l => [String(l.id), l]));

  const repayMap: Record<string, string> = {};
  for (const r of (repaysRes.data ?? [])) {
     try {
       const m = JSON.parse(String(r.metadata || "{}"));
       if (m.txHash) repayMap[String(r.ref_id)] = m.txHash;
     } catch {}
  }

  const netEarnings = metrics.totalEarnings;

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Welcome back 👋"
      description="Your lending overview at a glance. Use the navigation to fund loans or manage your pool investments."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={metrics.deployedCapital}
          pending={metrics.totalEarnings}
          inLoansLabel="Deployed"
          pendingLabel="Total Profit Earned"
          compact
        />
      )}
      currentPath="/dashboard/lender"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">

        {/* ── Quick action cards ──────────────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">

          {/* P2P Marketplace CTA */}
          <Link href="/dashboard/lender/marketplace" style={{ textDecoration: "none" }}>
            <article
              className="workspace-card"
              style={{
                cursor: "pointer",
                border: "1px solid rgba(126,47,208,0.35)",
                transition: "border-color 0.2s, transform 0.15s",
                height: "100%",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                <span style={{ fontSize: "2rem" }}>🏪</span>
                {openLoanCount > 0 && (
                  <span style={{ background: "rgba(255,107,107,0.15)", color: "#ff9966", borderRadius: "9999px", padding: "0.2rem 0.7rem", fontSize: "0.75rem", fontWeight: 700 }}>
                    {openLoanCount} open
                  </span>
                )}
              </div>
              <h2 className="workspace-card-title">Loan Marketplace</h2>
              <p className="workspace-card-copy" style={{ opacity: 0.65, fontSize: "0.875rem" }}>
                Browse open borrower requests. Fund directly via Freighter — XLM goes
                straight to the borrower&apos;s Stellar wallet. Earn interest on repayment.
              </p>
              <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#7e2fd0", fontWeight: 600 }}>
                Go to Marketplace →
              </p>
            </article>
          </Link>

          {/* Pool Investment CTA */}
          <Link href="/dashboard/lender/pools" style={{ textDecoration: "none" }}>
            <article
              className="workspace-card"
              style={{
                cursor: "pointer",
                border: "1px solid rgba(34,207,157,0.25)",
                transition: "border-color 0.2s, transform 0.15s",
                height: "100%",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                <span style={{ fontSize: "2rem" }}>🏦</span>
                {positions.length > 0 && (
                  <span style={{ background: "rgba(34,207,157,0.12)", color: "#22cf9d", borderRadius: "9999px", padding: "0.2rem 0.7rem", fontSize: "0.75rem", fontWeight: 700 }}>
                    {positions.length} position{positions.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <h2 className="workspace-card-title">Pool Investment</h2>
              <p className="workspace-card-copy" style={{ opacity: 0.65, fontSize: "0.875rem" }}>
                Deposit XLM into a lending pool and earn passive APR. The pool automatically
                funds matching borrower requests — no action needed from your side.
              </p>
              <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#22cf9d", fontWeight: 600 }}>
                Manage Pools →
              </p>
            </article>
          </Link>
        </section>

        {/* ── Summary stats row ───────────────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          {[
            {
              label: "Total Deployed",
              value: `${metrics.deployedCapital.toFixed(2)} XLM`,
              sub: `${metrics.activePositions} active pool position${metrics.activePositions !== 1 ? "s" : ""}`,
            },
            {
              label: "Net Earnings",
              value: formatCurrency(netEarnings),
              sub: "Total accumulated interest",
              highlight: true,
              positive: netEarnings >= 0,
            },
          ].map((stat) => (
            <article key={stat.label} className="workspace-card">
              <p style={{ fontSize: "0.78rem", opacity: 0.55, marginBottom: "0.35rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {stat.label}
              </p>
              <p style={{ fontSize: "1.6rem", fontWeight: 700, color: stat.highlight ? (stat.positive ? "#22cf9d" : "#ff6b6b") : "inherit", lineHeight: 1.1 }}>
                {stat.value}
              </p>
              <p style={{ fontSize: "0.78rem", opacity: 0.45, marginTop: "0.3rem" }}>{stat.sub}</p>
            </article>
          ))}
        </section>

        {/* ── Recent positions ────────────────────────────────────── */}
        <section style={{ display: "grid", gap: "1.5rem" }}>
          {positions.length > 0 && (
            <article className="workspace-card workspace-card--full">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <h2 className="workspace-card-title" style={{ margin: 0 }}>Recent Pool Deposits</h2>
                <Link href="/dashboard/lender/pools" className="workspace-nav-link" style={{ fontSize: "0.83rem" }}>
                  View all →
                </Link>
              </div>
              <div className="workspace-table-wrap">
                <table className="workspace-table">
                  <thead>
                    <tr><th>Pool ID</th><th>Status</th><th>Your Capital</th><th>Earned</th></tr>
                  </thead>
                  <tbody>
                    {positions.map((pos) => (
                      <tr key={String(pos.id)}>
                        <td style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>{String(pos.pool_id).slice(0, 8)}</td>
                        <td>
                          <span style={{ padding: "0.15rem 0.5rem", borderRadius: "9999px", fontSize: "0.75rem", fontWeight: 600, background: pos.status === "active" ? "rgba(34,207,157,0.12)" : "rgba(255,107,107,0.12)", color: pos.status === "active" ? "#22cf9d" : "#ff6b6b" }}>
                            {String(pos.status ?? "active").toUpperCase()}
                          </span>
                        </td>
                        <td><strong>{Number(pos.principal_amount ?? 0).toFixed(2)} XLM</strong></td>
                        <td style={{ color: "#22cf9d" }}>{Number(pos.earned_interest ?? 0).toFixed(4)} XLM</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}

          {p2pInvestments.length > 0 && (
            <article className="workspace-card workspace-card--full">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <h2 className="workspace-card-title" style={{ margin: 0 }}>Recent Direct P2P Loans</h2>
                <Link href="/dashboard/lender/history" className="workspace-nav-link" style={{ fontSize: "0.83rem" }}>
                  View history →
                </Link>
              </div>
              <div className="workspace-table-wrap">
                <table className="workspace-table">
                  <thead>
                    <tr><th>Loan ID</th><th>Deployed</th><th>Status</th><th>Profit Earned</th><th>Verification</th></tr>
                  </thead>
                  <tbody>
                    {p2pInvestments.map((tx) => {
                       let fundTxHash = "";
                       try {
                         const meta = JSON.parse(String(tx.metadata || "{}"));
                         fundTxHash = meta.txHash ?? "";
                       } catch {}

                       // Find actual loan data
                       const actualLoan = loanMap[String(tx.ref_id)];
                       const rawStatus = actualLoan?.status ?? "processing";


                       const repaid = Number(actualLoan?.repaid_amount ?? 0);
                       const profit = Math.max(0, repaid - Number(tx.amount));
                       const isRepaid = rawStatus === "repaid";
                       const isDefaulted = rawStatus === "defaulted";
                       const isProcessing = rawStatus === "processing";
                       const stColor = isRepaid
                         ? "#9b6fe0"
                         : isDefaulted
                           ? "#ff6b6b"
                           : isProcessing
                             ? "#6b7280"
                             : "#22cf9d";
                       const stBg = isRepaid
                         ? "rgba(155,111,224,0.12)"
                         : isDefaulted
                           ? "rgba(255,107,107,0.12)"
                           : isProcessing
                             ? "rgba(107,114,128,0.12)"
                             : "rgba(34,207,157,0.12)";

                       // Use repayment hash if it's repaid, otherwise fallback to funding hash
                       const finalTxHash = (isRepaid && repayMap[String(tx.ref_id)]) ? repayMap[String(tx.ref_id)] : fundTxHash;

                       return (
                        <tr key={String(tx.id)}>
                          <td style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>{String(tx.ref_id).slice(0, 8)}</td>
                          <td><strong>{Number(tx.amount ?? 0).toFixed(2)} XLM</strong></td>
                          <td>
                            <span style={{ padding: "0.15rem 0.5rem", borderRadius: "9999px", fontSize: "0.75rem", fontWeight: 600, background: stBg, color: stColor }}>
                              {String(rawStatus).toUpperCase()}
                            </span>
                          </td>
                          <td style={{ color: profit > 0 ? "#22cf9d" : "#9ca3af", fontWeight: profit > 0 ? 700 : 400 }}>
                            {profit > 0 ? `+${profit.toFixed(4)} XLM` : "0.00 XLM"}
                          </td>
                          <td>
                            {finalTxHash ? (
                              <a
                                href={`https://stellar.expert/explorer/testnet/tx/${finalTxHash}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: "0.3rem",
                                  padding: "0.25rem 0.6rem", borderRadius: "0.4rem",
                                  background: "rgba(126,47,208,0.1)", border: "1px solid rgba(126,47,208,0.25)",
                                  fontSize: "0.72rem", fontWeight: 700, color: "#7e2fd0",
                                  textDecoration: "none", whiteSpace: "nowrap"
                                }}
                              >
                                ✅ Verify {isRepaid ? "Repayment" : "Funding"} ↗
                              </a>
                            ) : (
                              <span style={{ fontSize: "0.7rem", color: "#9ca3af" }}>Off-chain</span>
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
        </section>

        {/* ── KYC warning ─────────────────────────────────────────── */}
        {!isKycVerified && (
          <article className="workspace-card workspace-card--full" style={{ border: "1px solid rgba(245,166,35,0.3)", background: "rgba(245,166,35,0.05)" }}>
            <h2 className="workspace-card-title">⚠️ KYC Not Verified</h2>
            <p className="workspace-card-copy">
              Complete your KYC verification to unlock loan funding. Lenders must be verified before deploying capital.
            </p>
            <Link href="/dashboard/lender/profile" className="workspace-nav-link" style={{ display: "inline-block", marginTop: "0.75rem" }}>
              Complete KYC →
            </Link>
          </article>
        )}

      </div>
    </WorkspaceFrame>
  );
}
