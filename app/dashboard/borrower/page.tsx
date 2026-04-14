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

function daysSince(value: string | null | undefined) {
  if (!value) return 0;
  const start = new Date(value).getTime();
  const diff = Date.now() - start;
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

export default async function BorrowerDashboardPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();

  const [profileRes, loansRes, verificationRes] = supabase
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
        supabase
          .from("external_verifications")
          .select("verification_type, status")
          .eq("user_id", user.id),
      ])
    : [{ data: null }, { data: [] }, { data: [] }];

  const profile = profileRes.data;
  const loans = loansRes.data ?? [];
  const verifications = verificationRes.data ?? [];

  const verificationMap = new Map(
    verifications.map((item) => [String(item.verification_type), String(item.status)]),
  );

  const monitoringDays = daysSince(user.created_at);
  const monitoringComplete = monitoringDays >= 30;

  const verificationItems = [
    { label: "Email Verified", done: Boolean(user.email_confirmed_at), day: "Day 1" },
    { label: "Phone Verified", done: Boolean(profile?.phone), day: "Day 2" },
    { label: "Government ID Verified", done: verificationMap.get("government_id") === "verified", day: "Day 3" },
    { label: "Facial Recognition OK", done: verificationMap.get("facial_recognition") === "verified", day: "Day 3" },
    { label: "Employment Verified", done: verificationMap.get("employment") === "verified", day: "Day 5" },
    { label: "Bank Data Verified", done: verificationMap.get("bank_data") === "verified", day: "Day 7" },
    { label: "Monitoring Period", done: monitoringComplete, day: `Day ${Math.min(monitoringDays, 30)}/30` },
  ];

  const verificationCompleted = verificationItems.filter((item) => item.done).length;
  const verificationProgress = Math.round((verificationCompleted / verificationItems.length) * 100);

  const activeLoans = loans.filter((loan) => ["approved", "funded", "active"].includes(String(loan.status)));
  const closedLoans = loans.filter((loan) => ["repaid", "defaulted", "cancelled"].includes(String(loan.status)));
  const inLoansXlm = activeLoans.reduce((sum, loan) => sum + Number(loan.principal_amount ?? 0), 0);
  const pendingXlm = loans
    .filter((loan) => String(loan.status) === "requested")
    .reduce((sum, loan) => sum + Number(loan.principal_amount ?? 0), 0);

  const selectedRepaymentLoan = activeLoans[0] ?? null;
  const dueAmount = selectedRepaymentLoan
    ? Math.max(0, Number(selectedRepaymentLoan.principal_amount ?? 0) - Number(selectedRepaymentLoan.repaid_amount ?? 0))
    : 0;

  const canApplyLoan = verificationProgress >= 90 && monitoringComplete;
  const maxLoanAmount = canApplyLoan ? metrics.availableCredit : 0;
  const missingSecurityItems = verificationItems
    .filter((item) => !item.done)
    .map((item) => item.label)
    .slice(0, 4);

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
      profileSummary={{
        completion: verificationProgress,
        kycStatus: String(profile?.kyc_status ?? "pending"),
        warningText: canApplyLoan
          ? "Profile is strong. Keep security details up to date."
          : "Profile is incomplete. Complete security details to unlock borrowing.",
        requiredItems: missingSecurityItems.length > 0
          ? missingSecurityItems
          : ["Enable 2FA", "Keep employment and bank details updated"],
      }}
      links={[
        { href: "/dashboard/borrower", label: "Home" },
        { href: "/dashboard/borrower/loans", label: "My loans" },
        { href: "/dashboard/borrower/tasks", label: "Tasks" },
        { href: "/dashboard/borrower/profile", label: "Profile & Settings" },
      ]}
    >
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
              <li><span>Legal full name</span></li>
              <li><span>Primary phone number</span></li>
              <li><span>Government-issued ID</span></li>
              <li><span>Selfie and facial verification</span></li>
              <li><span>Bank statement verification</span></li>
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
              <p style={{ fontSize: "0.85rem", marginTop: "0.5rem", opacity: 0.6 }}>Estimated completion: {Math.max(0, 30 - monitoringDays)} days</p>
            </div>
          </article>

          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Your Loan Profile</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.8rem", marginTop: "1rem" }}>
              <div className="workspace-mini-stat">
                <span className="workspace-mini-stat-label">Verified Income</span>
                <p className="workspace-mini-stat-value">{formatCurrency(1200)}/mo</p>
              </div>
              <div className="workspace-mini-stat">
                <span className="workspace-mini-stat-label">Credit Score</span>
                <p className="workspace-mini-stat-value">{metrics.reputationScore}</p>
              </div>
              <div className="workspace-mini-stat">
                <span className="workspace-mini-stat-label">Max Loan</span>
                <p className="workspace-mini-stat-value">{formatCurrency(maxLoanAmount)}</p>
              </div>
              <div className="workspace-mini-stat">
                <span className="workspace-mini-stat-label">Active Loans</span>
                <p className="workspace-mini-stat-value">{activeLoans.length}</p>
              </div>
              <div className="workspace-mini-stat">
                <span className="workspace-mini-stat-label">Closed Loans</span>
                <p className="workspace-mini-stat-value">{closedLoans.length}</p>
              </div>
              <div className="workspace-mini-stat">
                <span className="workspace-mini-stat-label">Default History</span>
                <p className="workspace-mini-stat-value">{closedLoans.some((loan) => loan.status === "defaulted") ? "Has defaults" : "None"}</p>
              </div>
            </div>
          </article>
        </section>
        
        <SorobanProfileCard walletAddress={walletAddress} />

        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title">Your Active Loans</h2>
          {activeLoans.length === 0 ? (
            <p className="workspace-card-copy" style={{ marginTop: "0.75rem" }}>
              You have no active loans yet. Complete verification milestones to unlock loan eligibility.
            </p>
          ) : (
            <div style={{ marginTop: "1rem" }}>
              <TableWrap>
                <Table aria-label="Active borrower loans">
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
                    {activeLoans.map((loan) => (
                      <tr key={String(loan.id)}>
                        <TableTd>{String(loan.id).slice(0, 8)}</TableTd>
                        <TableTd>{formatCurrency(Number(loan.principal_amount ?? 0))}</TableTd>
                        <TableTd><Badge variant="blue">{String(loan.status).toUpperCase()}</Badge></TableTd>
                        <TableTd>{(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%</TableTd>
                        <TableTd>{loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "-"}</TableTd>
                        <TableTd><button className="workspace-button workspace-button--secondary" style={{ fontSize: "0.75rem", padding: "0.4rem 0.6rem", height: "auto" }}>Make Payment</button></TableTd>
                      </tr>
                    ))}
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
