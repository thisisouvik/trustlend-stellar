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

export default async function AdminDashboardPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const walletConnected = Boolean(walletAddress);

  const supabase = await getServerSupabaseClient();

  const [profilesRes, loansRes, repaymentsRes, ledgerRes, fraudRes] = supabase
    ? await Promise.all([
        supabase
          .from("profiles")
          .select("id, role, kyc_status, risk_status, full_name, phone, country_code, created_at")
          .order("created_at", { ascending: false })
          .limit(300),
        supabase
          .from("loans")
          .select("id, status, principal_amount, approved_at")
          .order("requested_at", { ascending: false })
          .limit(300),
        supabase
          .from("loan_repayments")
          .select("id, payer_id, amount, paid_at, tx_ref")
          .order("paid_at", { ascending: false })
          .limit(120),
        supabase
          .from("ledger_transactions")
          .select("id, user_id, amount, category, status, created_at, metadata")
          .order("created_at", { ascending: false })
          .limit(400),
        supabase
          .from("fraud_signals")
          .select("id, user_id, signal_type, severity, resolved, created_at")
          .order("created_at", { ascending: false })
          .limit(120),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const profiles = profilesRes.data ?? [];
  const loans = loansRes.data ?? [];
  const repayments = repaymentsRes.data ?? [];
  const ledgerRows = ledgerRes.data ?? [];
  const fraudSignals = fraudRes.data ?? [];

  const anchorTime = new Date(
    String(ledgerRows[0]?.created_at ?? user.last_sign_in_at ?? user.created_at),
  ).getTime();
  const baseTime = Number.isFinite(anchorTime) ? anchorTime : 0;
  const baseDate = new Date(baseTime);
  const dayStartDate = new Date(baseDate);
  dayStartDate.setHours(0, 0, 0, 0);

  const todayStart = dayStartDate.getTime();
  const weeklyStart = baseTime - 7 * 24 * 60 * 60 * 1000;
  const monthlyStart = baseTime - 30 * 24 * 60 * 60 * 1000;
  const activeWindowStart = baseTime - 15 * 60 * 1000;

  const ledgerAmounts = ledgerRows.map((row) => ({
    amount: Number(row.amount ?? 0),
    createdAt: String(row.created_at ?? ""),
  }));

  const txToday = sumByPeriod(ledgerAmounts, todayStart);
  const txWeekly = sumByPeriod(ledgerAmounts, weeklyStart);
  const txMonthly = sumByPeriod(ledgerAmounts, monthlyStart);
  const txAllTime = ledgerAmounts.reduce((sum, row) => sum + row.amount, 0);

  const sanctionedLoans = loans.filter((loan) =>
    ["approved", "funded", "active", "repaid", "defaulted"].includes(String(loan.status)),
  );
  const sanctionedAmount = sanctionedLoans.reduce((sum, loan) => sum + Number(loan.principal_amount ?? 0), 0);
  const repaidAmount = repayments.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const lendersCount = profiles.filter((profile) => String(profile.role) === "lender").length;
  const borrowersCount = profiles.filter((profile) => String(profile.role) === "borrower").length;
  const activeUsers = new Set(
    ledgerRows
      .filter((row) => new Date(String(row.created_at)).getTime() >= activeWindowStart)
      .map((row) => String(row.user_id)),
  ).size;

  const incompleteProfiles = profiles.filter((profile) =>
    !String(profile.full_name ?? "").trim()
    || !String(profile.phone ?? "").trim()
    || !String(profile.country_code ?? "").trim(),
  );

  const pendingKycProfiles = profiles.filter((profile) =>
    ["pending", "submitted", "rejected"].includes(String(profile.kyc_status)),
  );

  const maliciousUserIds = new Set(
    fraudSignals
      .filter((signal) => !signal.resolved && Number(signal.severity ?? 0) >= 4)
      .map((signal) => String(signal.user_id)),
  );

  const blockedUserIds = profiles
    .filter((profile) => ["high", "blocked"].includes(String(profile.risk_status)))
    .map((profile) => String(profile.id));

  blockedUserIds.forEach((id) => maliciousUserIds.add(id));

  const topUsersMap = new Map<string, number>();
  for (const row of ledgerRows) {
    const userId = String(row.user_id ?? "");
    const amount = Number(row.amount ?? 0);
    if (!userId) {
      continue;
    }
    topUsersMap.set(userId, (topUsersMap.get(userId) ?? 0) + amount);
  }

  const topUsers = [...topUsersMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([userId, amount]) => ({
      userId,
      amount,
      profile: profiles.find((profile) => String(profile.id) === userId),
    }));

  const recentChainRows = ledgerRows
    .map((row) => {
      const hashFromMeta = extractPossibleTxHash(row.metadata);
      return {
        id: String(row.id),
        category: String(row.category ?? "unknown"),
        amount: Number(row.amount ?? 0),
        status: String(row.status ?? "pending"),
        userId: String(row.user_id ?? ""),
        createdAt: String(row.created_at ?? ""),
        txHash: hashFromMeta,
      };
    })
    .slice(0, 10);

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="Control Panel"
      description="Monitor platform health, credit activity, and security posture across TrustLend operations."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[...adminNavLinks]}
      currentPath="/dashboard/admin"
      showProfileAlert={false}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={sanctionedAmount}
          pending={txToday}
          inLoansLabel="Sanctioned"
          compact
        />
      )}
    >
      <div className="workspace-stack">
        {!walletConnected ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">
              Connect your Stellar wallet to unlock admin analytics and chain-linked verification data.
            </p>
          </article>
        ) : (
          <>
            <section className="workspace-grid workspace-grid--three">
              <article className="workspace-card">
                <h2 className="workspace-card-title">Users & access</h2>
                <p className="workspace-card-copy">Active now: {activeUsers}</p>
                <p className="workspace-card-copy">Total users: {profiles.length}</p>
                <p className="workspace-card-copy">Borrowers: {borrowersCount}</p>
                <p className="workspace-card-copy">Lenders: {lendersCount}</p>
              </article>

              <article className="workspace-card">
                <h2 className="workspace-card-title">Loan economy</h2>
                <p className="workspace-card-copy">Loans sanctioned: {sanctionedLoans.length}</p>
                <p className="workspace-card-copy">Amount sanctioned: {formatAmount(sanctionedAmount)}</p>
                <p className="workspace-card-copy">Amount repaid: {formatAmount(repaidAmount)}</p>
              </article>

              <article className="workspace-card">
                <h2 className="workspace-card-title">Transaction flow</h2>
                <p className="workspace-card-copy">Today: {formatAmount(txToday)}</p>
                <p className="workspace-card-copy">Weekly: {formatAmount(txWeekly)}</p>
                <p className="workspace-card-copy">Monthly: {formatAmount(txMonthly)}</p>
                <p className="workspace-card-copy">All-time: {formatAmount(txAllTime)}</p>
              </article>
            </section>

            <section className="workspace-grid workspace-grid--two">
              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Flagged and non-compliant accounts</h2>
                <ul className="workspace-list workspace-list--compact">
                  <li><span>Flagged accounts (high/blocked risk)</span><strong>{blockedUserIds.length}</strong></li>
                  <li><span>KYC incomplete or rejected</span><strong>{pendingKycProfiles.length}</strong></li>
                  <li><span>Missing profile details</span><strong>{incompleteProfiles.length}</strong></li>
                  <li><span>Malicious indicators</span><strong>{maliciousUserIds.size}</strong></li>
                </ul>
              </article>

              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Top users by transaction volume</h2>
                <ul className="workspace-list workspace-list--compact">
                  {topUsers.length === 0 ? (
                    <li>No transaction activity yet.</li>
                  ) : (
                    topUsers.map((entry) => (
                      <li key={entry.userId}>
                        <span>
                          {String(entry.profile?.full_name ?? entry.userId.slice(0, 8))}
                        </span>
                        <strong>{formatAmount(entry.amount)}</strong>
                      </li>
                    ))
                  )}
                </ul>
              </article>
            </section>

            <section className="workspace-card workspace-card--full">
              <h2 className="workspace-card-title">Blockchain verification stream</h2>
              <p className="workspace-card-copy">
                Network: {STELLAR_NETWORK_LABEL}. Verify signed transactions at {STELLAR_VERIFY_PORTAL}.
              </p>
              <div className="workspace-table-wrap">
                <table className="workspace-table" aria-label="Recent chain-linked transactions">
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
                    {recentChainRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="workspace-empty-row">No transaction rows available.</td>
                      </tr>
                    ) : (
                      recentChainRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.category}</td>
                          <td>{row.userId.slice(0, 8)}</td>
                          <td>{formatAmount(row.amount)}</td>
                          <td>{row.status}</td>
                          <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                          <td>
                            {row.txHash ? (
                              <a
                                href={buildStellarTxVerificationUrl(row.txHash)}
                                target="_blank"
                                rel="noreferrer"
                                className="workspace-nav-link"
                              >
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
