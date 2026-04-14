import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LenderForms } from "@/components/dashboard/LenderForms";
import { FinanceChart } from "@/components/dashboard/FinanceChart";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils/formatting";
import { buildStellarTxVerificationUrl, isLikelyTxHash, STELLAR_VERIFY_PORTAL } from "@/lib/stellar/explorer";

export default async function LenderDashboardPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getLenderDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();

  const [positionsRes, poolsRes, loansRes, repaymentRes, profileRes, verificationRes] = supabase
    ? await Promise.all([
        supabase
          .from("pool_positions")
          .select("id, pool_id, status, principal_amount, earned_interest, opened_at")
          .eq("lender_id", user.id)
          .order("opened_at", { ascending: false })
          .limit(12),
        supabase
          .from("lending_pools")
          .select("id, name, status, apr_bps, total_liquidity, available_liquidity")
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("loans")
          .select("id, pool_id, status, principal_amount, apr_bps, duration_days, due_at")
          .order("requested_at", { ascending: false })
          .limit(20),
        supabase
          .from("loan_repayments")
          .select("id, loan_id, amount, paid_at, tx_ref")
          .order("paid_at", { ascending: false })
          .limit(10),
        supabase
          .from("profiles")
          .select("full_name, phone, country_code, kyc_status")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("external_verifications")
          .select("verification_type, status")
          .eq("user_id", user.id),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: null }, { data: [] }];

  const positions = positionsRes.data ?? [];
  const pools = poolsRes.data ?? [];
  const loans = loansRes.data ?? [];
  const repayments = repaymentRes.data ?? [];
  const profile = profileRes.data;
  const verifications = verificationRes.data ?? [];

  const verificationMap = new Map(
    verifications.map((item) => [String(item.verification_type), String(item.status)]),
  );

  const insurancePaid = metrics.deployedCapital * 0.005;
  const netEarnings = metrics.totalEarnings - insurancePaid;
  const annualProjection = netEarnings > 0 ? netEarnings * 12 : 0;

  const totalCurrent = loans.filter((loan) => String(loan.status) === "active").length;
  const totalLate = loans.filter((loan) => String(loan.status) === "funded").length;
  const totalDefaulted = loans.filter((loan) => String(loan.status) === "defaulted").length;

  const portfolioLoans = positions.length > 0
    ? loans.filter((loan) =>
        positions.some((position) => String(position.pool_id) === String(loan.pool_id)),
      )
    : [];

  const securityChecklist = [
    { label: "Email confirmed", done: Boolean(user.email_confirmed_at) },
    { label: "Legal name provided", done: Boolean(profile?.full_name) },
    { label: "Phone verified", done: Boolean(profile?.phone) },
    { label: "Government ID", done: verificationMap.get("government_id") === "verified" },
    { label: "Bank verification", done: verificationMap.get("bank_data") === "verified" },
  ];

  const lenderProfileCompletion = Math.round(
    (securityChecklist.filter((item) => item.done).length / securityChecklist.length) * 100,
  );

  const lenderChartPoints = ["Mar", "Apr", "May", "Jun", "Jul", "Aug"].map((month, index) => {
    const inflow = Number(repayments[index]?.amount ?? 0);
    const outflow = Number(positions[index]?.principal_amount ?? 0);
    return {
      label: month,
      valueA: inflow,
      valueB: outflow,
    };
  });

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Lender Home"
      description="Data-driven lending operations with transparent pool performance, risk signals, and earnings visibility."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={metrics.deployedCapital}
          pending={0}
          inLoansLabel="In Pools"
          compact
        />
      )}
      currentPath="/dashboard/lender"
      profilePath="/dashboard/lender/profile"
      profileSummary={{
        completion: lenderProfileCompletion,
        kycStatus: String(profile?.kyc_status ?? "pending"),
        warningText: lenderProfileCompletion < 100
          ? "Incomplete profile increases funding risk. Finish KYC to grant loans safely."
          : "Profile and KYC checks are complete.",
        requiredItems: securityChecklist.filter((item) => !item.done).length > 0
          ? securityChecklist
              .filter((item) => !item.done)
              .map((item) => item.label)
              .slice(0, 4)
          : ["2FA enabled", "KYC documents verified"],
      }}
      links={[
        { href: "/dashboard/lender", label: "Home" },
        { href: "/dashboard/lender/pools", label: "Pools" },
        { href: "/dashboard/lender/portfolio", label: "Portfolio" },
        { href: "/dashboard/lender/risk", label: "Risk" },
        { href: "/dashboard/lender/profile", label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-stack">
        {!walletAddress ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">Connect wallet first to unlock lending operations and portfolio data.</p>
          </article>
        ) : (
          <>
        <section className="workspace-grid workspace-grid--three">
          <FinanceChart
            title="Cashflow Analytics"
            legendA="Repayment Inflow"
            legendB="Deployed Capital"
            points={lenderChartPoints}
          />

          <article className="workspace-card">
            <h2 className="workspace-card-title">Security Details Needed</h2>
            <p className="workspace-card-copy">Complete these details before granting more loans:</p>
            <ul className="workspace-list workspace-list--compact">
              <li><span>Government ID verification</span></li>
              <li><span>Beneficiary bank account proof</span></li>
              <li><span>Phone and country confirmation</span></li>
              <li><span>Enable 2FA for account</span></li>
              <li><span>Set withdrawal security PIN</span></li>
            </ul>
          </article>
        </section>

        <section className="workspace-grid workspace-grid--two">
          <article className="workspace-card">
            <h2 className="workspace-card-title">Your Total Earnings</h2>
            <p className="workspace-card-copy">Total Deposited: {formatCurrency(metrics.deployedCapital)}</p>
            <p className="workspace-card-copy">Interest Earned: {formatCurrency(metrics.totalEarnings)}</p>
            <p className="workspace-card-copy">Insurance Paid (0.5%): -{formatCurrency(insurancePaid)}</p>
            <p className="workspace-card-copy">Net Earnings: {formatCurrency(netEarnings)}</p>
            <p className="workspace-card-copy">Annual Projection: {formatCurrency(annualProjection)}</p>
          </article>

          <article className="workspace-card">
            <h2 className="workspace-card-title">Portfolio Summary</h2>
            <p className="workspace-card-copy">Active Loans: {portfolioLoans.length}</p>
            <p className="workspace-card-copy">Current: {totalCurrent}</p>
            <p className="workspace-card-copy">Late: {totalLate}</p>
            <p className="workspace-card-copy">Defaulted: {totalDefaulted}</p>
            <p className="workspace-card-copy">Default Rate: {metrics.defaultRate.toFixed(2)}%</p>
          </article>
        </section>

        <section className="workspace-card">
          <h2 className="workspace-card-title">Available Lending Pools</h2>
          <div className="workspace-table-wrap">
            <table className="workspace-table" aria-label="Available lending pools table">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>Status</th>
                  <th>APR</th>
                  <th>Current Size</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {pools.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="workspace-empty-row">No pools available yet.</td>
                  </tr>
                ) : (
                  pools.map((pool) => (
                    <tr key={String(pool.id)}>
                      <td>{String(pool.name)}</td>
                      <td>{String(pool.status)}</td>
                      <td>{(Number(pool.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                      <td>{formatCurrency(Number(pool.total_liquidity ?? 0))}</td>
                      <td>{formatCurrency(Number(pool.available_liquidity ?? 0))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="workspace-grid workspace-grid--two">
          <LenderForms pools={pools} positions={positions} />

          <article className="workspace-card">
            <h2 className="workspace-card-title">Individual Loans You Funded</h2>
            <ul className="workspace-list workspace-list--compact">
              {portfolioLoans.length === 0 ? (
                <li>No individual loans mapped yet.</li>
              ) : (
                portfolioLoans.slice(0, 6).map((loan) => (
                  <li key={String(loan.id)}>
                    Loan {String(loan.id).slice(0, 8)} | {String(loan.status)} | {formatCurrency(Number(loan.principal_amount ?? 0))}
                  </li>
                ))
              )}
            </ul>
          </article>

          <article className="workspace-card">
            <h2 className="workspace-card-title">Recent Activity</h2>
            <ul className="workspace-list workspace-list--compact">
              {repayments.length === 0 ? (
                <li>No repayment activity yet.</li>
              ) : (
                repayments.slice(0, 6).map((item) => (
                  <li key={String(item.id)}>
                    Repayment {formatCurrency(Number(item.amount ?? 0))} on {item.paid_at ? new Date(String(item.paid_at)).toLocaleDateString() : "-"}
                    {isLikelyTxHash(String(item.tx_ref ?? "")) ? (
                      <a
                        href={buildStellarTxVerificationUrl(String(item.tx_ref))}
                        target="_blank"
                        rel="noreferrer"
                        className="workspace-nav-link"
                        style={{ marginLeft: "0.5rem" }}
                      >
                        Verify tx
                      </a>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
            <p className="workspace-card-copy">Verification portal: {STELLAR_VERIFY_PORTAL}</p>
          </article>
        </section>

        <section className="workspace-card">
          <h2 className="workspace-card-title">Lender Preferences & Support</h2>
          <div className="workspace-grid workspace-grid--two">
            <div>
              <p className="workspace-card-copy">Risk tolerance: Moderate</p>
              <p className="workspace-card-copy">Auto-reinvest: Enabled</p>
              <p className="workspace-card-copy">Notifications: Payment due, repayment received, monthly report</p>
              <div className="workspace-inline-actions">
                <button type="button" className="workspace-nav-link" suppressHydrationWarning>Save Preferences</button>
              </div>
            </div>
            <div>
              <p className="workspace-card-copy">Support: support@trustlend.com</p>
              <p className="workspace-card-copy">Live Chat: 9AM-6PM UTC</p>
              <div className="workspace-inline-actions">
                <button type="button" className="workspace-nav-link" suppressHydrationWarning>FAQ</button>
                <button type="button" className="workspace-nav-link" suppressHydrationWarning>Create Ticket</button>
                <button type="button" className="workspace-nav-link" suppressHydrationWarning>Export Data</button>
              </div>
            </div>
          </div>
        </section>
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
