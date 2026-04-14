import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import {
  getAdminDashboardMetrics,
  presentAdminMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";

function formatAmount(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export default async function AdminLoansPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const walletConnected = Boolean(walletAddress);

  const supabase = await getServerSupabaseClient();
  const [loansRes, repaymentsRes] = supabase
    ? await Promise.all([
        supabase
          .from("loans")
          .select("id, borrower_id, status, principal_amount, apr_bps, duration_days, due_at")
          .order("requested_at", { ascending: false })
          .limit(40),
        supabase
          .from("loan_repayments")
          .select("id, loan_id, payer_id, amount, paid_at, tx_ref")
          .order("paid_at", { ascending: false })
          .limit(40),
      ])
    : [{ data: [] as Array<Record<string, unknown>> }, { data: [] as Array<Record<string, unknown>> }];

  const loans = loansRes.data ?? [];
  const repayments = repaymentsRes.data ?? [];
  const sanctionedAmount = loans
    .filter((loan) => ["approved", "funded", "active", "repaid", "defaulted"].includes(String(loan.status)))
    .reduce((sum, loan) => sum + Number(loan.principal_amount ?? 0), 0);
  const paidAmount = repayments.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="Loan Operations"
      description="Monitor loan lifecycle, exposure, and maturity timelines across the platform."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[...adminNavLinks]}
      currentPath="/dashboard/admin/loans"
      showProfileAlert={false}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={sanctionedAmount}
          pending={paidAmount}
          inLoansLabel="Sanctioned"
          compact
        />
      )}
    >
      <div className="workspace-stack">
        {!walletConnected ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">Connect wallet first to unlock loan operations data.</p>
          </article>
        ) : (
          <>
            <div className="workspace-table-wrap">
              <table className="workspace-table" aria-label="Admin loans table">
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th>Borrower</th>
                    <th>Status</th>
                    <th>Principal</th>
                    <th>APR</th>
                    <th>Due</th>
                  </tr>
                </thead>
                <tbody>
                  {loans.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="workspace-empty-row">No loan records found.</td>
                    </tr>
                  ) : (
                    loans.map((loan) => (
                      <tr key={String(loan.id)}>
                        <td>{String(loan.id).slice(0, 8)}</td>
                        <td>{String(loan.borrower_id).slice(0, 8)}</td>
                        <td>{String(loan.status)}</td>
                        <td>{formatAmount(Number(loan.principal_amount ?? 0))}</td>
                        <td>{(Number(loan.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                        <td>{loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString() : "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <section className="workspace-card workspace-card--full">
              <h2 className="workspace-card-title">Repayment verification links</h2>
              <div className="workspace-table-wrap">
                <table className="workspace-table" aria-label="Repayment verification table">
                  <thead>
                    <tr>
                      <th>Loan</th>
                      <th>Payer</th>
                      <th>Amount</th>
                      <th>Paid</th>
                      <th>Verify</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repayments.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="workspace-empty-row">No repayments found.</td>
                      </tr>
                    ) : (
                      repayments.map((payment) => {
                        const txHash = String(payment.tx_ref ?? "");
                        return (
                          <tr key={String(payment.id)}>
                            <td>{String(payment.loan_id).slice(0, 8)}</td>
                            <td>{String(payment.payer_id).slice(0, 8)}</td>
                            <td>{formatAmount(Number(payment.amount ?? 0))}</td>
                            <td>{payment.paid_at ? new Date(String(payment.paid_at)).toLocaleString() : "-"}</td>
                            <td>
                              {isLikelyTxHash(txHash) ? (
                                <a href={buildStellarTxVerificationUrl(txHash)} target="_blank" rel="noreferrer" className="workspace-nav-link">
                                  Verify
                                </a>
                              ) : (
                                "-"
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
