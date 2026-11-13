import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { metaString } from "@/lib/db/metadata";
import { getProfile } from "@/lib/db/queries";
import { ledgerToRow, loanToRow, positionToRow } from "@/lib/db/rows";
import { ledgerTransactions, loans as loansTable, poolPositions } from "@/lib/db/schema";
import { formatTokenBalance } from "@/lib/utils/formatting";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { LenderUtilizationChart } from "@/components/dashboard/LenderUtilizationChart";
import Link from "next/link";

export default async function LenderHomePage() {
  const { user } = await requireAuthenticatedUser("lender");
  const walletAddress =
    String(user.walletAddress ?? "") || null;
  const metrics = await getLenderDashboardMetrics(user.id);
  const db = getDb();

  const [positionRows, profile, p2pRows, [openLoanCountRow], allLoanRows, repayRows] = db
    ? await Promise.all([
        db
          .select()
          .from(poolPositions)
          .where(eq(poolPositions.lenderId, user.id))
          .orderBy(desc(poolPositions.createdAt))
          .limit(5),
        getProfile(db, user.id),
        db
          .select()
          .from(ledgerTransactions)
          .where(and(eq(ledgerTransactions.userId, user.id), eq(ledgerTransactions.refType, "loan_fund")))
          .orderBy(desc(ledgerTransactions.createdAt))
          .limit(20),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(loansTable)
          .where(inArray(loansTable.status, ["requested", "approved"])),
        db.select().from(loansTable),
        db
          .select({ ref_id: ledgerTransactions.refId, metadata: ledgerTransactions.metadata })
          .from(ledgerTransactions)
          .where(eq(ledgerTransactions.refType, "loan_repay")),
      ])
    : [[], null, [], [{ count: 0 }], [], []];

  const positions = positionRows.map(positionToRow);
  const p2pInvestments = p2pRows.map(ledgerToRow);
  const openLoanCount = openLoanCountRow?.count ?? 0;
  const isKycVerified = profile?.kyc_status === "verified";

  const loanMap = Object.fromEntries(allLoanRows.map(loanToRow).map((l) => [l.id, l]));

  const repayMap: Record<string, string> = {};
  for (const r of repayRows) {
    const hash = metaString(r.metadata, "txHash");
    if (hash && r.ref_id) repayMap[r.ref_id] = hash;
  }

  const netEarnings = metrics.totalEarnings;

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Welcome back 👋"
      description="Your lending overview at a glance. Use the navigation to fund loans or manage your pool investments."
      email={user.email ?? null}
      userName={String(
        user.fullName ?? profile?.full_name ?? "",
      )}
      metrics={presentLenderMetrics(metrics)}
      headerWidget={
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={metrics.deployedCapital}
          pending={metrics.totalEarnings}
          inLoansLabel="Deployed"
          pendingLabel="Total Profit Earned"
          compact
        />
      }
      currentPath="/dashboard/lender"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">
        {/* ── Quick action cards ──────────────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          {/* P2P Marketplace CTA */}
          <Link
            href="/dashboard/lender/marketplace"
            style={{ textDecoration: "none" }}
          >
            <article
              className="workspace-card"
              style={{
                cursor: "pointer",
                border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)",
                transition: "border-color 0.2s, transform 0.15s",
                height: "100%",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: "0.75rem",
                }}
              >
                <span style={{ fontSize: "2rem" }}>🏪</span>
                {openLoanCount > 0 && (
                  <span
                    style={{
                      background: "color-mix(in srgb, var(--danger) 15%, transparent)",
                      color: "var(--warning)",
                      borderRadius: "9999px",
                      padding: "0.2rem 0.7rem",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                    }}
                  >
                    {openLoanCount} open
                  </span>
                )}
              </div>
              <h2 className="workspace-card-title">Loan Marketplace</h2>
              <p
                className="workspace-card-copy"
                style={{ opacity: 0.65, fontSize: "0.875rem" }}
              >
                Browse open borrower requests. Fund directly with Varial or
                Albedo — XLM goes straight to the borrower&apos;s Stellar
                wallet. Earn interest on repayment.
              </p>
              <p
                style={{
                  marginTop: "1rem",
                  fontSize: "0.85rem",
                  color: "var(--primary)",
                  fontWeight: 600,
                }}
              >
                Go to Marketplace →
              </p>
            </article>
          </Link>

          {/* Pool Investment CTA */}
          <Link
            href="/dashboard/lender/pools"
            style={{ textDecoration: "none" }}
          >
            <article
              className="workspace-card"
              style={{
                cursor: "pointer",
                border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                transition: "border-color 0.2s, transform 0.15s",
                height: "100%",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: "0.75rem",
                }}
              >
                <span style={{ fontSize: "2rem" }}>🏦</span>
                {positions.length > 0 && (
                  <span
                    style={{
                      background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                      color: "var(--accent)",
                      borderRadius: "9999px",
                      padding: "0.2rem 0.7rem",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                    }}
                  >
                    {positions.length} position
                    {positions.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <h2 className="workspace-card-title">Pool Investment</h2>
              <p
                className="workspace-card-copy"
                style={{ opacity: 0.65, fontSize: "0.875rem" }}
              >
                Deposit XLM into a lending pool and earn passive APR. The pool
                automatically funds matching borrower requests — no action
                needed from your side.
              </p>
              <p
                style={{
                  marginTop: "1rem",
                  fontSize: "0.85rem",
                  color: "var(--accent)",
                  fontWeight: 600,
                }}
              >
                Manage Pools →
              </p>
            </article>
          </Link>
        </section>

        {/* ── Summary stats row ───────────────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          {[
            {
              label: "Total Deployed",
              value: formatTokenBalance(metrics.deployedCapital),
              sub: `${metrics.activePositions} active pool position${metrics.activePositions !== 1 ? "s" : ""}`,
            },
            {
              label: "Net Earnings",
              value: formatTokenBalance(netEarnings),
              sub: "Total accumulated interest",
              highlight: true,
              positive: netEarnings >= 0,
            },
          ].map((stat) => (
            <article key={stat.label} className="workspace-card">
              <p
                style={{
                  fontSize: "0.78rem",
                  opacity: 0.55,
                  marginBottom: "0.35rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                {stat.label}
              </p>
              <p
                style={{
                  fontSize: "1.6rem",
                  fontWeight: 700,
                  color: stat.highlight
                    ? stat.positive
                      ? "var(--accent)"
                      : "var(--danger)"
                    : "inherit",
                  lineHeight: 1.1,
                }}
              >
                {stat.value}
              </p>
              <p
                style={{
                  fontSize: "0.78rem",
                  opacity: 0.45,
                  marginTop: "0.3rem",
                }}
              >
                {stat.sub}
              </p>
            </article>
          ))}
        </section>

        {/* ── Pool utilization history ─────────────────────────────── */}
        <section className="workspace-grid workspace-grid--full">
          <LenderUtilizationChart range="30d" />
        </section>

        {/* ── Recent positions ────────────────────────────────────── */}
        <section style={{ display: "grid", gap: "1.5rem" }}>
          {positions.length > 0 && (
            <article className="workspace-card workspace-card--full">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.75rem",
                }}
              >
                <h2 className="workspace-card-title" style={{ margin: 0 }}>
                  Recent Pool Deposits
                </h2>
                <Link
                  href="/dashboard/lender/pools"
                  className="workspace-nav-link"
                  style={{ fontSize: "0.83rem" }}
                >
                  View all →
                </Link>
              </div>
              <div className="workspace-table-wrap">
                <table className="workspace-table">
                  <thead>
                    <tr>
                      <th>Pool ID</th>
                      <th>Status</th>
                      <th>Your Capital</th>
                      <th>Earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((pos) => (
                      <tr key={String(pos.id)}>
                        <td
                          style={{
                            fontFamily: "monospace",
                            fontSize: "0.82rem",
                          }}
                        >
                          {String(pos.pool_id).slice(0, 8)}
                        </td>
                        <td>
                          <span
                            style={{
                              padding: "0.15rem 0.5rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              background:
                                pos.status === "active"
                                  ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                                  : "color-mix(in srgb, var(--danger) 12%, transparent)",
                              color:
                                pos.status === "active" ? "var(--accent)" : "var(--danger)",
                            }}
                          >
                            {String(pos.status ?? "active").toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <strong>
                            {formatTokenBalance(Number(pos.principal_amount ?? 0))}
                          </strong>
                        </td>
                        <td style={{ color: "var(--accent)" }}>
                          {formatTokenBalance(Number(pos.earned_interest ?? 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}

          {p2pInvestments.length > 0 && (
            <article className="workspace-card workspace-card--full">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.75rem",
                }}
              >
                <h2 className="workspace-card-title" style={{ margin: 0 }}>
                  Recent Direct P2P Loans
                </h2>
                <Link
                  href="/dashboard/lender/history"
                  className="workspace-nav-link"
                  style={{ fontSize: "0.83rem" }}
                >
                  View history →
                </Link>
              </div>
              <div className="workspace-table-wrap">
                <table className="workspace-table">
                  <thead>
                    <tr>
                      <th>Loan ID</th>
                      <th>Deployed</th>
                      <th>Status</th>
                      <th>Profit Earned</th>
                      <th>Verification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p2pInvestments.map((tx) => {
                      const fundTxHash = metaString(tx.metadata, "txHash");

                      // Find actual loan data
                      const actualLoan = loanMap[String(tx.ref_id)];
                      const rawStatus: string = actualLoan?.status ?? "processing";

                      const repaid = Number(actualLoan?.repaid_amount ?? 0);
                      const profit = Math.max(0, repaid - Number(tx.amount));
                      const isRepaid = rawStatus === "repaid";
                      const isDefaulted = rawStatus === "defaulted";
                      const isProcessing = rawStatus === "processing";
                      const stColor = isRepaid
                        ? "var(--primary-muted)"
                        : isDefaulted
                          ? "var(--danger)"
                          : isProcessing
                            ? "var(--fg-muted)"
                            : "var(--accent)";
                      const stBg = isRepaid
                        ? "color-mix(in srgb, var(--primary) 12%, transparent)"
                        : isDefaulted
                          ? "color-mix(in srgb, var(--danger) 12%, transparent)"
                          : isProcessing
                            ? "color-mix(in srgb, var(--fg-muted) 12%, transparent)"
                            : "color-mix(in srgb, var(--accent) 12%, transparent)";

                      // Use repayment hash if it's repaid, otherwise fallback to funding hash
                      const finalTxHash =
                        isRepaid && repayMap[String(tx.ref_id)]
                          ? repayMap[String(tx.ref_id)]
                          : fundTxHash;

                      return (
                        <tr key={String(tx.id)}>
                          <td
                            style={{
                              fontFamily: "monospace",
                              fontSize: "0.82rem",
                            }}
                          >
                            {String(tx.ref_id).slice(0, 8)}
                          </td>
                          <td>
                            <strong>
                              {formatTokenBalance(Number(tx.amount ?? 0))}
                            </strong>
                          </td>
                          <td>
                            <span
                              style={{
                                padding: "0.15rem 0.5rem",
                                borderRadius: "9999px",
                                fontSize: "0.75rem",
                                fontWeight: 600,
                                background: stBg,
                                color: stColor,
                              }}
                            >
                              {String(rawStatus).toUpperCase()}
                            </span>
                          </td>
                          <td
                            style={{
                              color: profit > 0 ? "var(--accent)" : "var(--fg-subtle)",
                              fontWeight: profit > 0 ? 700 : 400,
                            }}
                          >
                            {profit > 0
                              ? `+${profit.toFixed(4)} XLM`
                              : "0.00 XLM"}
                          </td>
                          <td>
                            {finalTxHash ? (
                              <a
                                href={`https://stellar.expert/explorer/testnet/tx/${finalTxHash}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "0.3rem",
                                  padding: "0.25rem 0.6rem",
                                  borderRadius: "0.4rem",
                                  background: "color-mix(in srgb, var(--primary) 10%, transparent)",
                                  border: "1px solid color-mix(in srgb, var(--primary) 25%, transparent)",
                                  fontSize: "0.72rem",
                                  fontWeight: 700,
                                  color: "var(--primary)",
                                  textDecoration: "none",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                ✅ Verify {isRepaid ? "Repayment" : "Funding"} ↗
                              </a>
                            ) : (
                              <span
                                style={{ fontSize: "0.7rem", color: "var(--fg-subtle)" }}
                              >
                                Off-chain
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          )}
        </section>

        {/* ── KYC warning ─────────────────────────────────────────── */}
        {!isKycVerified && (
          <article
            className="workspace-card workspace-card--full"
            style={{
              border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
              background: "color-mix(in srgb, var(--warning) 5%, transparent)",
            }}
          >
            <h2 className="workspace-card-title">⚠️ KYC Not Verified</h2>
            <p className="workspace-card-copy">
              Complete your KYC verification to unlock loan funding. Lenders
              must be verified before deploying capital.
            </p>
            <Link
              href="/dashboard/lender/profile"
              className="workspace-nav-link"
              style={{ display: "inline-block", marginTop: "0.75rem" }}
            >
              Complete KYC →
            </Link>
          </article>
        )}
      </div>
    </WorkspaceFrame>
  );
}
