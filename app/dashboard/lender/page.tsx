import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils/formatting";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import Link from "next/link";

export default async function LenderHomePage() {
  const { user } = await requireAuthenticatedUser("lender");
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getLenderDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  const [positionsRes, profileRes] = supabase
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
      ])
    : [{ data: [] }, { data: null }];

  // Open loan count — service role to bypass RLS
  const openLoanCountRes = srClient
    ? await srClient
        .from("loans")
        .select("id", { count: "exact", head: true })
        .in("status", ["requested", "approved"])
    : { count: 0 };

  const positions     = positionsRes.data ?? [];
  const profile       = profileRes.data;
  const openLoanCount = openLoanCountRes.count ?? 0;
  const isKycVerified = profile?.kyc_status === "verified";

  const insurancePaid = metrics.deployedCapital * 0.005;
  const netEarnings   = metrics.totalEarnings - insurancePaid;

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
          pending={0}
          inLoansLabel="Deployed"
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
        <section className="workspace-grid workspace-grid--three">
          {[
            {
              label: "Total Deployed",
              value: `${metrics.deployedCapital.toFixed(2)} XLM`,
              sub: `${metrics.activePositions} active pool position${metrics.activePositions !== 1 ? "s" : ""}`,
            },
            {
              label: "Net Earnings",
              value: formatCurrency(netEarnings),
              sub: `${metrics.totalEarnings.toFixed(4)} XLM gross interest`,
              highlight: true,
              positive: netEarnings >= 0,
            },
            {
              label: "Platform Default Rate",
              value: `${metrics.defaultRate.toFixed(2)}%`,
              sub: "Across all funded loans",
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
