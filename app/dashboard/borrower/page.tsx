import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { BorrowerForms } from "@/components/dashboard/BorrowerForms";
import { FinanceChart } from "@/components/dashboard/FinanceChart";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { Table, TableBody, TableHead, TableTd, TableTh, TableWrap } from "@/components/ui/table";
import { Badge } from "@/components/ui/Badge";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getBorrowerDashboardMetrics,
  presentBorrowerMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { SorobanProfileCard } from "@/components/dashboard/SorobanProfileCard";
import { formatCurrency } from "@/lib/utils/formatting";
import { STELLAR_VERIFY_PORTAL } from "@/lib/stellar/explorer";

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
          .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, requested_at, due_at, closed_at")
          .eq("borrower_id", user.id)
          .order("requested_at", { ascending: false })
          .limit(10),
      ])
    : [{ data: null }, { data: [] }];

  const profile = profileRes.data;
  const loans = loansRes.data ?? [];

  const isKycVerified = profile?.kyc_status === "verified";
  const isKycSubmitted = profile?.kyc_status === "submitted" || isKycVerified;

  const verificationItems = [
    { label: "Email Verified", done: Boolean(user.email_confirmed_at), day: "Initial" },
    { label: "Legal Name Set", done: Boolean(profile?.full_name), day: "Profile" },
    { label: "Phone Number Verified", done: Boolean(profile?.phone), day: "Profile" },
    { label: "Government ID Verified", done: isKycVerified, day: "Admin Review" },
  ];

  const verificationCompleted = verificationItems.filter((item) => item.done).length;
  const verificationProgress = Math.round((verificationCompleted / verificationItems.length) * 100);

  // Loans eligible for repayment (disbursed and active)
  const activeLoans = loans.filter((loan) => ["approved", "funded", "active"].includes(String(loan.status)));
  const closedLoans = loans.filter((loan) => ["repaid", "defaulted", "cancelled"].includes(String(loan.status)));
  // All in-progress loans shown in the dashboard table (includes pending 'requested' loans)
  const currentLoans = loans.filter((loan) => !["repaid", "defaulted", "cancelled"].includes(String(loan.status)));
  const inLoansXlm = activeLoans.reduce((sum, loan) => sum + Number(loan.principal_amount ?? 0), 0);
  const pendingXlm = loans
    .filter((loan) => String(loan.status) === "requested")
    .reduce((sum, loan) => sum + Number(loan.principal_amount ?? 0), 0);

  const selectedRepaymentLoan = activeLoans[0] ?? null;
  const dueAmount = selectedRepaymentLoan
    ? Math.max(0, Number(selectedRepaymentLoan.principal_amount ?? 0) - Number(selectedRepaymentLoan.repaid_amount ?? 0))
    : 0;

  const canApplyLoan = verificationProgress === 100;
  const maxLoanAmount = canApplyLoan ? metrics.availableCredit : 0;
  const missingSecurityItems = verificationItems
    .filter((item) => !item.done)
    .map((item) => item.label);

  const borrowerChartPoints = ["Mar", "Apr", "May", "Jun", "Jul", "Aug"].map((month, index) => {
    const borrowed = Number(loans[index]?.principal_amount ?? 0);
    const repaid = Number(loans[index]?.repaid_amount ?? 0);
    return {
      label: month,
      valueA: borrowed,
      valueB: repaid,
    };
  });

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Borrower Home"
      description="Transparent loan visibility, verification progress, and repayment controls in one place."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={inLoansXlm}
          pending={pendingXlm}
          inLoansLabel="In Loans"
          compact
        />
      )}
      currentPath="/dashboard/borrower"
      profilePath="/dashboard/borrower/profile"
      profileSummary={canApplyLoan ? undefined : {
        completion: verificationProgress,
        kycStatus: String(profile?.kyc_status ?? "pending"),
        warningText: isKycSubmitted && !isKycVerified
          ? "Your documents are currently under admin review."
          : "Profile is incomplete. Complete security details to unlock borrowing.",
        requiredItems: missingSecurityItems.length > 0
          ? missingSecurityItems
          : [],
      }}
      showProfileAlert={!canApplyLoan}
      links={[
        { href: "/dashboard/borrower", label: "Home" },
        { href: "/dashboard/borrower/loans", label: "My loans" },
        { href: "/dashboard/borrower/tasks", label: "Tasks" },
        { href: "/dashboard/borrower/profile", label: "Profile & Settings" },
      ]}
    >
      <style dangerouslySetInnerHTML={{ __html: `
        .workspace-tooltip { position: relative; cursor: help; }
        .workspace-tooltip .workspace-tooltip-content {
          position: absolute; bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%) translateY(4px) scale(0.96);
          opacity: 0; visibility: hidden; background: #1d254a; color: #fff; padding: 0.75rem 0.9rem;
          border-radius: 0.65rem; font-size: 0.8rem; line-height: 1.5; width: max-content; max-width: 260px;
          text-align: left; box-shadow: 0 10px 25px rgba(29, 37, 74, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.08);
          transition: opacity 200ms ease, transform 200ms ease, visibility 200ms; z-index: 100; pointer-events: none;
        }
        .workspace-tooltip:hover .workspace-tooltip-content { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0) scale(1); }
        .workspace-tooltip .workspace-tooltip-content::after {
          content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
          border-width: 5px; border-style: solid; border-color: #1d254a transparent transparent transparent;
        }
        .workspace-tooltip-title { display: block; font-weight: 700; color: #22cf9d; margin-bottom: 0.25rem; font-size: 0.82rem; }
        .workspace-tooltip-text { display: block; color: rgba(255, 255, 255, 0.85); font-weight: 400; font-size: 0.78rem; font-family: sans-serif; }
      `}} />
      <div className="workspace-stack">
        {!walletAddress ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">Connect wallet first to unlock borrowing and repayment workflows.</p>
          </article>
        ) : (
          <>
        <section className="workspace-grid workspace-grid--three">
          <FinanceChart
            title="Borrowing Trend"
            legendA="Borrowed"
            legendB="Repaid"
            points={borrowerChartPoints}
          />

          <article className="workspace-card">
            <h2 className="workspace-card-title">Security Details Needed</h2>
            <p className="workspace-card-copy">Please complete these details to receive loans safely.</p>
            <ul className="workspace-list workspace-list--compact" style={{ marginTop: "0.75rem" }}>
                {verificationItems.map((item) => (
                  <li key={item.label}><span>{item.label}</span></li>
                ))}
            </ul>
          </article>
        </section>

        <section className="workspace-grid workspace-grid--two">
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Your Verification Status</h2>
            <ul className="workspace-list workspace-list--compact" style={{ marginTop: "0.75rem" }}>
              {verificationItems.map((item) => (
                <li key={item.label} style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                  <span>{item.done ? "✓ " : "○ "}{item.label}</span>
                  <span style={{ fontSize: "0.85rem", opacity: 0.6 }}>{item.day}</span>
                </li>
              ))}
            </ul>
            <div style={{ marginTop: "1.2rem", padding: "1rem", borderRadius: "0.5rem", background: "linear-gradient(135deg, rgba(126, 47, 208, 0.05) 0%, rgba(34, 207, 157, 0.05) 100%)" }}>
              <p style={{ fontSize: "0.9rem", marginBottom: "0.5rem", fontWeight: 500 }}>Verification Progress: <strong>{verificationProgress}%</strong></p>
              <div style={{ height: "0.4rem", borderRadius: "0.25rem", background: "#e5e7eb", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${verificationProgress}%`, background: "linear-gradient(90deg, #7e2fd0 0%, #22cf9d 100%)", transition: "width 0.3s ease" }} />
              </div>
              <p style={{ fontSize: "0.85rem", marginTop: "0.5rem", opacity: 0.6 }}>{Math.max(0, verificationItems.length - verificationCompleted)} items remaining</p>
            </div>
          </article>

          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Your Loan Profile</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.8rem", marginTop: "1rem" }}>
              <div className="workspace-mini-stat workspace-tooltip">
                <span className="workspace-mini-stat-label">Risk Level</span>
                <p className="workspace-mini-stat-value" style={{ textTransform: "capitalize" }}>{profile?.risk_status || "Medium"}</p>
                <div className="workspace-tooltip-content">
                  <span className="workspace-tooltip-title">Risk Level</span>
                  <span className="workspace-tooltip-text">Your internal security and compliance risk classification, determined during KYC review.</span>
                </div>
              </div>
              <div className="workspace-mini-stat workspace-tooltip">
                <span className="workspace-mini-stat-label">Credit Score</span>
                <p className="workspace-mini-stat-value">{metrics.reputationScore}</p>
                <div className="workspace-tooltip-content">
                  <span className="workspace-tooltip-title">Credit Score</span>
                  <span className="workspace-tooltip-text">Your decentralized Credit Score, calculated transparently by TrustLend&apos;s Soroban smart contract based on your Stellar on-chain repayment history.</span>
                </div>
              </div>
              <div className="workspace-mini-stat workspace-tooltip">
                <span className="workspace-mini-stat-label">Max Loan</span>
                <p className="workspace-mini-stat-value">{formatCurrency(maxLoanAmount)}</p>
                <div className="workspace-tooltip-content">
                  <span className="workspace-tooltip-title">Max Loan</span>
                  <span className="workspace-tooltip-text">The dynamically calculated maximum loan you are eligible for, which scales up to 10x your Credit Score.</span>
                </div>
              </div>
              <div className="workspace-mini-stat workspace-tooltip">
                <span className="workspace-mini-stat-label">Active Loans</span>
                <p className="workspace-mini-stat-value">{activeLoans.length}</p>
                <div className="workspace-tooltip-content">
                  <span className="workspace-tooltip-title">Active Loans</span>
                  <span className="workspace-tooltip-text">The number of loans you are currently borrowing and paying down.</span>
                </div>
              </div>
              <div className="workspace-mini-stat workspace-tooltip">
                <span className="workspace-mini-stat-label">Closed Loans</span>
                <p className="workspace-mini-stat-value">{closedLoans.length}</p>
                <div className="workspace-tooltip-content">
                  <span className="workspace-tooltip-title">Closed Loans</span>
                  <span className="workspace-tooltip-text">Loans that have been fully paid off or historically completely closed out.</span>
                </div>
              </div>
              <div className="workspace-mini-stat workspace-tooltip">
                <span className="workspace-mini-stat-label">Default History</span>
                <p className="workspace-mini-stat-value">{closedLoans.some((loan) => loan.status === "defaulted") ? "Has defaults" : "None"}</p>
                <div className="workspace-tooltip-content">
                  <span className="workspace-tooltip-title">Default History</span>
                  <span className="workspace-tooltip-text">If you have previously defaulted on a loan, it leaves a permanent flag on your Stellar on-chain history.</span>
                </div>
              </div>
            </div>
          </article>
        </section>
        
        <SorobanProfileCard walletAddress={walletAddress} />

        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title">Your Loans</h2>
          {currentLoans.length === 0 ? (
            <p className="workspace-card-copy" style={{ marginTop: "0.75rem" }}>
              You have no loans yet. Apply below to get started.
            </p>
          ) : (
            <div style={{ marginTop: "1rem" }}>
              <TableWrap>
                <Table aria-label="Borrower loans">
                  <TableHead>
                    <tr>
                      <TableTh>Loan ID</TableTh>
                      <TableTh>Amount</TableTh>
                      <TableTh>Status</TableTh>
                      <TableTh>APR</TableTh>
                      <TableTh>Due</TableTh>
                      <TableTh>Actions</TableTh>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {currentLoans.map((loan) => {
                      const status = String(loan.status);
                      const badgeVariant =
                        status === "requested" ? "yellow" :
                        status === "active"    ? "green"  : "blue";
                      return (
                        <tr key={String(loan.id)}>
                          <TableTd>{String(loan.id).slice(0, 8)}</TableTd>
                          <TableTd>{formatCurrency(Number(loan.principal_amount ?? 0))}</TableTd>
                          <TableTd><Badge variant={badgeVariant}>{status.toUpperCase()}</Badge></TableTd>
                          <TableTd>{(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%</TableTd>
                          <TableTd>{loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "Pending"}</TableTd>
                          <TableTd>
                            {status === "requested" ? (
                              <span style={{ fontSize: "0.75rem", opacity: 0.6 }}>Awaiting approval</span>
                            ) : (
                              <button className="workspace-button workspace-button--secondary" style={{ fontSize: "0.75rem", padding: "0.4rem 0.6rem", height: "auto" }}>Make Payment</button>
                            )}
                          </TableTd>
                        </tr>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableWrap>
            </div>
          )}
        </article>

        <section className="workspace-grid workspace-grid--two">
          <BorrowerForms 
            canApplyLoan={canApplyLoan}
            maxLoanAmount={maxLoanAmount}
            selectedRepaymentLoan={selectedRepaymentLoan}
            dueAmount={dueAmount}
          />

          <article className="workspace-card">
            <h2 className="workspace-card-title">Profile & Security</h2>
            <ul className="workspace-list workspace-list--compact" style={{ marginTop: "0.75rem" }}>
              <li>
                <span>Full Name</span>
                <strong>{String(profile?.full_name ?? "Not set")}</strong>
              </li>
              <li>
                <span>Email</span>
                <strong>{user.email ?? "Unknown"}</strong>
              </li>
              <li>
                <span>Phone</span>
                <strong>{String(profile?.phone ?? "Not set")}</strong>
              </li>
              <li>
                <span>KYC Status</span>
                <strong style={{ color: String(profile?.kyc_status) === "verified" ? "#22cf9d" : "#ff6b6b" }}>{String(profile?.kyc_status ?? "pending").toUpperCase()}</strong>
              </li>
            </ul>
            <div className="workspace-inline-actions" style={{ marginTop: "1rem" }}>
              <button className="workspace-nav-link">Enable 2FA</button>
              <button className="workspace-nav-link">Change Password</button>
            </div>
          </article>
        </section>

        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title">Help & Support</h2>
          <p className="workspace-card-copy" style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>Email: support@trustlend.com | Live chat: 9AM-6PM UTC</p>
          <p className="workspace-card-copy" style={{ fontSize: "0.9rem" }}>Blockchain verification portal: {STELLAR_VERIFY_PORTAL}</p>
          <div className="workspace-inline-actions" style={{ marginTop: "1rem" }}>
            <button className="workspace-nav-link">FAQ</button>
            <button className="workspace-nav-link">Create Support Ticket</button>
            <button className="workspace-nav-link">Video Tutorials</button>
          </div>
        </article>
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
