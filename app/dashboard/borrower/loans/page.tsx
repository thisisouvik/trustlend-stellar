import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getBorrowerDashboardMetrics,
  presentBorrowerMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function BorrowerLoansPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const [loansRes, profileRes] = supabase
    ? await Promise.all([
        supabase
          .from("loans")
          .select("id, status, principal_amount, apr_bps, duration_days, requested_at, due_at")
          .eq("borrower_id", user.id)
          .order("requested_at", { ascending: false })
          .limit(8),
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
      ])
    : [{ data: [] }, { data: null }];

  const loans = loansRes.data ?? [];
  const profile = profileRes.data;

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="My Loans"
      description="View requested, active, and completed loans with repayment context."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/loans"
      links={[
        { href: "/dashboard/borrower", label: "Home" },
        { href: "/dashboard/borrower/loans", label: "My loans" },
        { href: "/dashboard/borrower/tasks", label: "Tasks" },
        { href: "/dashboard/borrower/profile", label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-table-wrap">
        <table className="workspace-table" aria-label="Borrower loans table">
          <thead>
            <tr>
              <th>Loan</th>
              <th>Status</th>
              <th>Principal</th>
              <th>APR</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {(loans ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="workspace-empty-row">No loan records yet.</td>
              </tr>
            ) : (
              (loans ?? []).map((loan) => (
                <tr key={String(loan.id)}>
                  <td>{String(loan.id).slice(0, 8)}</td>
                  <td>{String(loan.status)}</td>
                  <td>{Number(loan.principal_amount ?? 0).toFixed(2)}</td>
                  <td>{(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                  <td>{String(loan.duration_days)} days</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </WorkspaceFrame>
  );
}
