import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import {
  getAdminDashboardMetrics,
  presentAdminMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import {
  buildStellarTxVerificationUrl,
  extractPossibleTxHash,
  STELLAR_NETWORK_LABEL,
  STELLAR_VERIFY_PORTAL,
} from "@/lib/stellar/explorer";

function formatAmount(value: number) {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} XLM`;
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

  const srClient = getServiceRoleClient();
  const { data: ledgerRows } = srClient
    ? await srClient
        .from("ledger_transactions")
        .select("id, user_id, amount, category, status, created_at, metadata")
        .order("created_at", { ascending: false })
        .limit(500)
    : { data: [] as Array<Record<string, unknown>> };

  const rows = ledgerRows ?? [];

  const anchorTime = new Date().getTime();
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
      heading="Treasury & Platform Activity"
      description="Track platform-wide transaction throughput, treasury movement, and full chronological on-chain verification."
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
          inLoansLabel="Platform All-time"
          compact
        />
      )}
    >
      <div className="workspace-stack">
        {!walletConnected ? (
          <article className="workspace-card workspace-card--full" style={{
            background: "linear-gradient(to right, rgba(155,111,224,0.05), rgba(155,111,224,0.15))",
            border: "1px solid rgba(155,111,224,0.2)"
          }}>
            <h2 className="workspace-card-title" style={{ color: "#9b6fe0" }}>Wallet Connection Required</h2>
            <p className="workspace-card-copy">Connect your Admin Treasury wallet first to unlock platform flow analytics.</p>
          </article>
        ) : (
          <>
            <section className="workspace-grid workspace-grid--three">
              <article className="workspace-card" style={{ background: "linear-gradient(145deg, rgba(34,207,157,0.05), transparent)", border: "1px solid rgba(34,207,157,0.15)" }}>
                <h2 className="workspace-card-title" style={{ fontSize: "0.85rem", opacity: 0.8 }}>Transactions Today</h2>
                <p className="workspace-card-copy" style={{ fontSize: "1.75rem", fontWeight: 700, color: "#22cf9d", margin: "0.25rem 0 0 0" }}>
                  {formatAmount(today)}
                </p>
              </article>
              <article className="workspace-card" style={{ background: "linear-gradient(145deg, rgba(84,160,255,0.05), transparent)", border: "1px solid rgba(84,160,255,0.15)" }}>
                <h2 className="workspace-card-title" style={{ fontSize: "0.85rem", opacity: 0.8 }}>Transactions Weekly</h2>
                <p className="workspace-card-copy" style={{ fontSize: "1.75rem", fontWeight: 700, color: "#54a0ff", margin: "0.25rem 0 0 0" }}>
                  {formatAmount(weekly)}
                </p>
              </article>
              <article className="workspace-card" style={{ background: "linear-gradient(145deg, rgba(155,111,224,0.05), transparent)", border: "1px solid rgba(155,111,224,0.15)" }}>
                <h2 className="workspace-card-title" style={{ fontSize: "0.85rem", opacity: 0.8 }}>Transactions Monthly</h2>
                <p className="workspace-card-copy" style={{ fontSize: "1.75rem", fontWeight: 700, color: "#9b6fe0", margin: "0.25rem 0 0 0" }}>
                  {formatAmount(monthly)}
                </p>
              </article>
            </section>

            <section className="workspace-grid workspace-grid--two">
              <article className="workspace-card workspace-card--full" style={{ position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: "-50px", right: "-50px", width: "150px", height: "150px", background: "radial-gradient(circle, rgba(155,111,224,0.1) 0%, transparent 70%)", borderRadius: "50%" }} />
                <h2 className="workspace-card-title" style={{ fontSize: "0.9rem", letterSpacing: "1px", textTransform: "uppercase" }}>Global Ecosystem Volume</h2>
                <p className="workspace-card-copy" style={{ fontSize: "2.5rem", fontWeight: 800, margin: "0.5rem 0", background: "linear-gradient(90deg, #fff, #9b6fe0)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  {formatAmount(allTime)}
                </p>
                <div style={{ display: "flex", gap: "1rem", marginTop: "1.5rem" }}>
                  <span style={{ fontSize: "0.8rem", padding: "0.3rem 0.8rem", background: "rgba(255,255,255,0.05)", borderRadius: "9999px", border: "1px solid rgba(255,255,255,0.1)" }}>
                    🌐 {STELLAR_NETWORK_LABEL}
                  </span>
                  <span style={{ fontSize: "0.8rem", padding: "0.3rem 0.8rem", background: "rgba(84,160,255,0.1)", color: "#54a0ff", borderRadius: "9999px", border: "1px solid rgba(84,160,255,0.2)" }}>
                    🛡️ Authenticated
                  </span>
                </div>
              </article>

              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title" style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: "0.75rem" }}>Active Whales (Top Protocol Users)</h2>
                <ul className="workspace-list workspace-list--compact" style={{ marginTop: "1rem" }}>
                  {topUsers.length === 0 ? (
                    <li style={{ opacity: 0.5 }}>No activity recorded yet.</li>
                  ) : (
                    topUsers.map(([userId, amount], index) => (
                      <li key={userId} style={{ display: "flex", justifyContent: "space-between", padding: "0.4rem 0", borderBottom: index === topUsers.length -1 ? "none" : "1px solid rgba(255,255,255,0.05)" }}>
                        <span style={{ fontFamily: "monospace", opacity: 0.7, fontSize: "0.85rem" }}>{userId.slice(0, 12)}...</span>
                        <strong style={{ color: "#22cf9d", fontSize: "0.9rem" }}>{formatAmount(amount)}</strong>
                      </li>
                    ))
                  )}
                </ul>
              </article>
            </section>

            <section className="workspace-card workspace-card--full" style={{ padding: "0", overflow: "hidden" }}>
              <div style={{ padding: "1.5rem", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(0,0,0,0.1)" }}>
                <h2 className="workspace-card-title" style={{ margin: 0 }}>Platform Ledger Verifications</h2>
                <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.8rem", opacity: 0.6 }}>Immutable feed of all platform transactions interacting with Stellar testnet</p>
              </div>
              <div className="workspace-table-wrap">
                <table className="workspace-table" style={{ margin: 0, width: "100%" }} aria-label="Ledger activity table">
                  <thead style={{ background: "rgba(255,255,255,0.02)" }}>
                    <tr>
                      <th style={{ padding: "1rem" }}>Date</th>
                      <th>Category</th>
                      <th>User</th>
                      <th>Amount</th>
                      <th>Network Verification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chainRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="workspace-empty-row" style={{ padding: "3rem", opacity: 0.5 }}>No transaction rows found on the network.</td>
                      </tr>
                    ) : (
                      chainRows.map((row) => (
                        <tr key={row.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                          <td style={{ padding: "1rem", fontSize: "0.85rem", opacity: 0.7 }}>
                            {row.createdAt ? new Date(row.createdAt).toLocaleDateString() + " " + new Date(row.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "—"}
                          </td>
                          <td>
                            <span style={{ 
                              padding: "0.2rem 0.6rem", borderRadius: "9999px", fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase",
                              background: row.category.includes("fund") || row.category.includes("deposit") ? "rgba(34,207,157,0.1)" : "rgba(84,160,255,0.1)",
                              color: row.category.includes("fund") || row.category.includes("deposit") ? "#22cf9d" : "#54a0ff",
                              border: `1px solid ${row.category.includes("fund") || row.category.includes("deposit") ? "rgba(34,207,157,0.2)" : "rgba(84,160,255,0.2)"}`
                            }}>
                              {row.category.replace("_", " ")}
                            </span>
                          </td>
                          <td style={{ fontFamily: "monospace", fontSize: "0.8rem", opacity: 0.8 }}>{row.userId.slice(0, 8)}</td>
                          <td style={{ fontWeight: 600 }}>{formatAmount(row.amount)}</td>
                          <td>
                            {row.txHash ? (
                              <a 
                                href={buildStellarTxVerificationUrl(row.txHash)} 
                                target="_blank" 
                                rel="noreferrer" 
                                className="workspace-nav-link"
                                style={{ display: "inline-block", background: "rgba(155,111,224,0.1)", color: "#9b6fe0", padding: "0.35rem 0.75rem", borderRadius: "9999px", fontSize: "0.75rem", fontWeight: 600, border: "1px solid rgba(155,111,224,0.3)" }}
                              >
                                ✅ View Hash ↗
                              </a>
                            ) : (
                              <span style={{ opacity: 0.3, fontSize: "0.8rem", fontStyle: "italic", display: "inline-block", padding: "0.35rem 0" }}>Pending On-chain</span>
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
