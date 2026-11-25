import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LoanMarketplace } from "@/components/dashboard/LoanMarketplace";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { getFundingProgress } from "@/lib/loans/funding";
import {
  buildStellarTxVerificationUrl,
  isLikelyTxHash,
} from "@/lib/stellar/explorer";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getMarketplaceLoans, getProfile } from "@/lib/db/queries";
import { metaString } from "@/lib/db/metadata";
import { ledgerToRow } from "@/lib/db/rows";
import { ledgerTransactions } from "@/lib/db/schema";
import {
  DEFAULT_SORT,
  DURATION_FILTER_OPTIONS,
  HIGH_REPUTATION_THRESHOLD,
  filterMarketplaceLoans,
  parseDurationFilter,
  parseSortOption,
} from "@/lib/dashboard/marketplace";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readSearchParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export default async function LenderMarketplacePage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const sort = parseSortOption(readSearchParam(resolvedSearchParams, "sort"));
  const highReputationOnly =
    readSearchParam(resolvedSearchParams, "highReputation") === "true";
  const maxDurationDays = parseDurationFilter(
    readSearchParam(resolvedSearchParams, "maxDuration"),
  );

  const { user } = await requireAuthenticatedUser("lender");
  const walletAddress =
    String(user.walletAddress ?? "") || null;
  const metrics = await getLenderDashboardMetrics(user.id);

  const db = getDb();

  const [fundedTxRows, openLoans] = await Promise.all([
    db
      ? db
          .select()
          .from(ledgerTransactions)
          .where(and(eq(ledgerTransactions.userId, user.id), eq(ledgerTransactions.refType, "loan_fund")))
          .orderBy(desc(ledgerTransactions.createdAt))
          .limit(20)
      : Promise.resolve([]),
    getMarketplaceLoans(db),
  ]);

  const fundedTxs = fundedTxRows.map(ledgerToRow);
  const marketplaceLoans = openLoans
    .map((loan) => ({
      id: String(loan.id),
      principal_amount: Number(loan.principal_amount ?? 0),
      funded_amount: Number(loan.funded_amount ?? 0),
      lender_count: Number(loan.lender_count ?? 0),
      apr_bps: Number(loan.apr_bps ?? 0),
      duration_days: Number(loan.duration_days ?? 30),
      trust_score: Number(loan.trust_score ?? 250),
      borrower_name: String(
        loan.borrower_name ?? `Borrower ${String(loan.borrower_id).slice(0, 6)}`,
      ),
      borrower_wallet: String(loan.borrower_wallet ?? ""),
      onchain_loan_id: loan.onchain_loan_id ?? null,
    }))
    // Drop anything already at 100% (the query filters these too; belt and braces).
    .filter((loan) => !getFundingProgress(loan.principal_amount, loan.funded_amount).isFullyFunded);

  const visibleMarketplaceLoans = filterMarketplaceLoans(marketplaceLoans, {
    sort,
    maxDurationDays,
    highReputationOnly,
    highReputationThreshold: HIGH_REPUTATION_THRESHOLD,
  });

  const profile = await getProfile(db, user.id);

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Loan Marketplace"
      description="Browse open borrower requests. Fund directly with Varial or Albedo - XLM goes straight to the borrower's Stellar wallet. Full on-chain transparency."
      email={user.email ?? null}
      userName={String(
        user.fullName ?? profile?.full_name ?? "",
      )}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/marketplace"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">
        {!walletAddress ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet Required</h2>
            <p className="workspace-card-copy">
              Connect your Stellar wallet in Profile & Settings before funding
              loans.
            </p>
          </article>
        ) : (
          <>
            <article
              className="workspace-card workspace-card--full"
              style={{
                background: "color-mix(in srgb, var(--primary) 6%, transparent)",
                border: "1px solid color-mix(in srgb, var(--primary) 20%, transparent)",
              }}
            >
              <h2 className="workspace-card-title">How Direct Lending Works</h2>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: "1rem",
                  marginTop: "0.75rem",
                }}
              >
                {[
                  {
                    step: "1",
                    label: "Browse",
                    desc: "Review open borrower requests - trust score, amount, APR, and duration.",
                  },
                  {
                    step: "2",
                    label: "Fund",
                    desc: "Click Fund, then sign the Stellar payment with your selected wallet.",
                  },
                  {
                    step: "3",
                    label: "On-chain",
                    desc: "XLM goes directly to the borrower's wallet with a TL-FUND memo on Stellar.",
                  },
                  {
                    step: "4",
                    label: "Earn",
                    desc: "When the borrower repays, you receive principal plus interest back to your wallet.",
                  },
                ].map((step) => (
                  <div
                    key={step.step}
                    style={{ display: "flex", gap: "0.75rem" }}
                  >
                    <span
                      style={{
                        width: "1.75rem",
                        height: "1.75rem",
                        borderRadius: "50%",
                        background: "color-mix(in srgb, var(--primary) 25%, transparent)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: "0.85rem",
                        flexShrink: 0,
                      }}
                    >
                      {step.step}
                    </span>
                    <div>
                      <p
                        style={{
                          fontWeight: 600,
                          fontSize: "0.88rem",
                          marginBottom: "0.25rem",
                        }}
                      >
                        {step.label}
                      </p>
                      <p
                        style={{
                          fontSize: "0.8rem",
                          opacity: 0.6,
                          lineHeight: 1.4,
                        }}
                      >
                        {step.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="workspace-card workspace-card--full">
              <form
                method="get"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "1rem",
                  alignItems: "flex-end",
                  marginBottom: "1rem",
                  padding: "1rem",
                  borderRadius: "0.9rem",
                  background: "color-mix(in srgb, var(--primary) 4%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--primary) 12%, transparent)",
                }}
              >
                <label
                  className="workspace-form-group"
                  style={{ minWidth: "220px", flex: "1 1 220px" }}
                >
                  <span
                    style={{
                      fontSize: "0.8rem",
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      textTransform: "uppercase",
                      opacity: 0.7,
                    }}
                  >
                    Sort by
                  </span>
                  <select
                    name="sort"
                    defaultValue={sort}
                    className="workspace-input"
                  >
                    <option value="apr_desc">Interest Rate: High to Low</option>
                    <option value="apr_asc">Interest Rate: Low to High</option>
                    <option value="term_desc">Loan Term: Long to Short</option>
                    <option value="term_asc">Loan Term: Short to Long</option>
                  </select>
                </label>

                <label
                  className="workspace-form-group"
                  style={{ minWidth: "200px", flex: "1 1 200px" }}
                >
                  <span
                    style={{
                      fontSize: "0.8rem",
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      textTransform: "uppercase",
                      opacity: 0.7,
                    }}
                  >
                    Max duration
                  </span>
                  <select
                    name="maxDuration"
                    defaultValue={
                      maxDurationDays === null
                        ? "all"
                        : String(maxDurationDays)
                    }
                    className="workspace-input"
                  >
                    {DURATION_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.65rem",
                    minHeight: "44px",
                    padding: "0.8rem 1rem",
                    borderRadius: "0.75rem",
                    border: "1px solid color-mix(in srgb, var(--primary) 16%, transparent)",
                    background: "color-mix(in srgb, var(--fg) 72%, transparent)",
                  }}
                >
                  <input
                    type="checkbox"
                    name="highReputation"
                    value="true"
                    defaultChecked={highReputationOnly}
                    style={{ accentColor: "var(--primary)" }}
                  />
                  <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                    High Reputation only (score {HIGH_REPUTATION_THRESHOLD}+)
                  </span>
                </label>

                <div
                  style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}
                >
                  <button
                    type="submit"
                    className="workspace-button workspace-button--primary"
                  >
                    Apply
                  </button>
                  <a
                    href="/dashboard/lender/marketplace"
                    className="workspace-button workspace-button--secondary"
                    style={{
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    Reset
                  </a>
                </div>
              </form>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  marginBottom: "1rem",
                  flexWrap: "wrap",
                }}
              >
                <h2 className="workspace-card-title" style={{ margin: 0 }}>
                  Open Requests
                </h2>
                {visibleMarketplaceLoans.length > 0 ? (
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
                    {visibleMarketplaceLoans.length} open
                  </span>
                ) : (
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
                    0 matches
                  </span>
                )}
                {(sort !== DEFAULT_SORT ||
                  highReputationOnly ||
                  maxDurationDays !== null) &&
                marketplaceLoans.length > 0 ? (
                  <span style={{ fontSize: "0.78rem", opacity: 0.65 }}>
                    from {marketplaceLoans.length} total requests
                  </span>
                ) : null}
              </div>

              <LoanMarketplace
                loans={visibleMarketplaceLoans}
                lenderWallet={walletAddress}
                emptyStateTitle={
                  marketplaceLoans.length === 0
                    ? "All loans are funded!"
                    : "No loans match these filters"
                }
                emptyStateDescription={
                  marketplaceLoans.length === 0
                    ? "No open loan requests right now. Check back soon."
                    : "Try a different sort option, a longer duration, or turn off the high-reputation filter."
                }
              />
            </article>

            <article className="workspace-card workspace-card--full">
              <h2 className="workspace-card-title">Loans You Funded</h2>
              {fundedTxs.length === 0 ? (
                <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
                  You haven&apos;t directly funded any loans yet. Pick a request
                  above to get started.
                </p>
              ) : (
                <div className="workspace-table-wrap">
                  <table
                    className="workspace-table"
                    aria-label="Loans you funded"
                  >
                    <thead>
                      <tr>
                        <th>Loan ID</th>
                        <th>Amount Sent</th>
                        <th>Date</th>
                        <th>Stellar TX</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fundedTxs.map((tx) => {
                        const txHash = metaString(tx.metadata, "txHash");

                        return (
                          <tr key={String(tx.id)}>
                            <td
                              style={{
                                fontFamily: "monospace",
                                fontSize: "0.82rem",
                              }}
                            >
                              {String(tx.ref_id ?? "").slice(0, 8)}
                            </td>
                            <td>
                              <strong>
                                {Number(tx.amount ?? 0).toFixed(2)} XLM
                              </strong>
                            </td>
                            <td style={{ fontSize: "0.82rem", opacity: 0.7 }}>
                              {tx.created_at
                                ? new Date(
                                    String(tx.created_at),
                                  ).toLocaleDateString()
                                : "-"}
                            </td>
                            <td>
                              {isLikelyTxHash(txHash) ? (
                                <a
                                  href={buildStellarTxVerificationUrl(txHash)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="workspace-nav-link"
                                  style={{ fontSize: "0.82rem" }}
                                >
                                  Verify on Stellar -&gt;
                                </a>
                              ) : (
                                <span
                                  style={{ opacity: 0.4, fontSize: "0.8rem" }}
                                >
                                  -
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
