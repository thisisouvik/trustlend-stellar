import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import {
  getAdminDashboardMetrics,
  presentAdminMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import {
  buildStellarTxVerificationUrl,
  extractPossibleTxHash,
  STELLAR_NETWORK_LABEL,
  STELLAR_VERIFY_PORTAL,
} from "@/lib/stellar/explorer";

function formatAmount(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function sumByPeriod(
  rows: Array<{ amount: number; createdAt: string }>,
  startTime: number,
) {
  return rows
    .filter((row) => new Date(row.createdAt).getTime() >= startTime)
    .reduce((sum, row) => sum + row.amount, 0);
}

export default async function AdminActivityPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const walletConnected = Boolean(walletAddress);

  const supabase = await getServerSupabaseClient();
  const { data: ledgerRows } = supabase
    ? await supabase
        .from("ledger_transactions")
        .select("id, user_id, amount, category, status, created_at, metadata")
        .order("created_at", { ascending: false })
        .limit(500)
    : { data: [] as Array<Record<string, unknown>> };

  const rows = ledgerRows ?? [];

  const anchorTime = new Date(
    String(rows[0]?.created_at ?? user.last_sign_in_at ?? user.created_at),
  ).getTime();
  const baseTime = Number.isFinite(anchorTime) ? anchorTime : 0;
  const baseDate = new Date(baseTime);
  const dayStartDate = new Date(baseDate);
  dayStartDate.setHours(0, 0, 0, 0);

  const todayStart = dayStartDate.getTime();
  const weeklyStart = baseTime - 7 * 24 * 60 * 60 * 1000;
  const monthlyStart = baseTime - 30 * 24 * 60 * 60 * 1000;

  const amounts = rows.map((row) => ({
    amount: Number(row.amount ?? 0),
    createdAt: String(row.created_at ?? ""),
  }));

  const today = sumByPeriod(amounts, todayStart);
  const weekly = sumByPeriod(amounts, weeklyStart);
  const monthly = sumByPeriod(amounts, monthlyStart);
  const allTime = amounts.reduce((sum, row) => sum + row.amount, 0);

  const topUsersMap = new Map<string, number>();
  for (const row of rows) {
    const userId = String(row.user_id ?? "");
    const amount = Number(row.amount ?? 0);
    if (!userId) {
      continue;
    }
    topUsersMap.set(userId, (topUsersMap.get(userId) ?? 0) + amount);
  }

  const topUsers = [...topUsersMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const chainRows = rows
    .map((row) => {
      const txHash = extractPossibleTxHash(row.metadata);
      return {
        id: String(row.id),
        userId: String(row.user_id ?? ""),
        amount: Number(row.amount ?? 0),
        category: String(row.category ?? "unknown"),
        status: String(row.status ?? "pending"),
        createdAt: String(row.created_at ?? ""),
        txHash,
      };
    })
    .slice(0, 30);

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="Treasury and Activity"
      description="Track transaction throughput, treasury movement, and on-chain verification coverage."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[...adminNavLinks]}
      currentPath="/dashboard/admin/activity"
      showProfileAlert={false}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={allTime}
          pending={today}
          inLoansLabel="All-time"
          compact
        />
      )}
    >
      <div className="workspace-stack">
        {!walletConnected ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">Connect wallet first to unlock treasury and activity analytics.</p>
          </article>
        ) : (
          <>
            <section className="workspace-grid workspace-grid--three">
              <article className="workspace-card">
                <h2 className="workspace-card-title">Transactions today</h2>
                <p className="workspace-card-copy">{formatAmount(today)}</p>
              </article>
              <article className="workspace-card">
                <h2 className="workspace-card-title">Transactions weekly</h2>
                <p className="workspace-card-copy">{formatAmount(weekly)}</p>
              </article>
              <article className="workspace-card">
                <h2 className="workspace-card-title">Transactions monthly</h2>
                <p className="workspace-card-copy">{formatAmount(monthly)}</p>
              </article>
            </section>

            <section className="workspace-grid workspace-grid--two">
              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">All-time transaction amount</h2>
                <p className="workspace-card-copy">{formatAmount(allTime)}</p>
                <p className="workspace-card-copy">Network: {STELLAR_NETWORK_LABEL}</p>
                <p className="workspace-card-copy">Verification portal: {STELLAR_VERIFY_PORTAL}</p>
              </article>

              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Top users by activity</h2>
                <ul className="workspace-list workspace-list--compact">
                  {topUsers.length === 0 ? (
                    <li>No activity recorded yet.</li>
                  ) : (
                    topUsers.map(([userId, amount]) => (
                      <li key={userId}><span>{userId.slice(0, 8)}</span><strong>{formatAmount(amount)}</strong></li>
                    ))
                  )}
                </ul>
              </article>
            </section>

            <section className="workspace-card workspace-card--full">
              <h2 className="workspace-card-title">Recent ledger rows with verification</h2>
              <div className="workspace-table-wrap">
                <table className="workspace-table" aria-label="Ledger activity table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>User</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th>Verify</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chainRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="workspace-empty-row">No transaction rows found.</td>
                      </tr>
                    ) : (
                      chainRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.category}</td>
                          <td>{row.userId.slice(0, 8)}</td>
                          <td>{formatAmount(row.amount)}</td>
                          <td>{row.status}</td>
                          <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                          <td>
                            {row.txHash ? (
                              <a href={buildStellarTxVerificationUrl(row.txHash)} target="_blank" rel="noreferrer" className="workspace-nav-link">
                                Verify
                              </a>
                            ) : (
                              "-"
                            )}
                          </td>
                        </tr>
                      ))
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
