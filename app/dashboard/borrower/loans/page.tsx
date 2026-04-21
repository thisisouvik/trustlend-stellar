import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { BorrowerForms } from "@/components/dashboard/BorrowerForms";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getBorrowerDashboardMetrics, presentBorrowerMetrics } from "@/lib/dashboard/metrics";
import { borrowerNavLinks } from "@/lib/dashboard/borrower-links";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function BorrowerLoansPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics  = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const [loansRes, profileRes] = supabase
    ? await Promise.all([
        supabase
          .from("loans")
          .select("id, status, principal_amount, apr_bps, duration_days, repaid_amount, due_at, created_at")
          .eq("borrower_id", user.id)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("profiles")
          .select("full_name, kyc_status")
          .eq("id", user.id)
          .maybeSingle(),
      ])
    : [{ data: [] }, { data: null }];

  const loans   = loansRes.data ?? [];
  const profile = profileRes.data;

  const isKycVerified = profile?.kyc_status === "verified";
  const canApplyLoan  = isKycVerified;
  const maxLoanAmount = canApplyLoan ? metrics.availableCredit : 0;

  const activeLoans = loans.filter((l) => l.status === "active");
  const repayableLoan = activeLoans[0] ?? null;
  const dueAmount = repayableLoan
    ? Math.max(0, Number(repayableLoan.principal_amount ?? 0) - Number(repayableLoan.repaid_amount ?? 0))
    : 0;

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Apply for a Loan"
      description="Submit a new loan request or make a repayment on your active loan."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/loans"
      links={borrowerNavLinks}
    >
      <div className="workspace-stack">
        {!canApplyLoan && (
          <article className="workspace-card workspace-card--full" style={{ background: "rgba(245,166,35,0.04)", borderColor: "rgba(245,166,35,0.25)" }}>
            <h2 className="workspace-card-title">⚠️ KYC Required</h2>
            <p className="workspace-card-copy" style={{ marginTop: "0.4rem" }}>
              Your KYC status is currently <strong>{profile?.kyc_status ?? "pending"}</strong>.{" "}
              {profile?.kyc_status === "submitted"
                ? "Your documents are under admin review. You'll be notified once approved."
                : "Please complete your profile and submit government ID to apply for loans."}
            </p>
            <a href="/dashboard/borrower/profile" style={{ display: "inline-block", marginTop: "0.75rem", fontSize: "0.82rem", color: "#7e2fd0", fontWeight: 600 }}>
              Go to Profile →
            </a>
          </article>
        )}

        <BorrowerForms
          canApplyLoan={canApplyLoan}
          maxLoanAmount={maxLoanAmount}
          selectedRepaymentLoan={repayableLoan as { id: string; due_at: string | null; principal_amount: number; repaid_amount: number } | null}
          dueAmount={dueAmount}
        />
      </div>
    </WorkspaceFrame>
  );
}
