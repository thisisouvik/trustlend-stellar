import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LoanMarketplace } from "@/components/dashboard/LoanMarketplace";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import {
  buildStellarTxVerificationUrl,
  isLikelyTxHash,
} from "@/lib/stellar/explorer";
import {
  getServerSupabaseClient,
  getServiceRoleClient,
} from "@/lib/supabase/server";

type MarketplaceSortOption = "apr_desc" | "apr_asc" | "term_desc" | "term_asc";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type MarketplaceLoanRow = {
  id: string;
  principal_amount: number;
  apr_bps: number;
  duration_days: number;
  borrower_id: string;
  borrower_name: string;
  borrower_wallet: string;
  trust_score: number;
};

const DEFAULT_SORT: MarketplaceSortOption = "apr_desc";
const HIGH_REPUTATION_THRESHOLD = 500;

function readSearchParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseSortOption(value: string | undefined): MarketplaceSortOption {
  switch (value) {
    case "apr_asc":
    case "term_desc":
    case "term_asc":
      return value;
    case "apr_desc":
    default:
      return DEFAULT_SORT;
  }
}

function sortMarketplaceLoans<
  T extends { apr_bps: number; duration_days: number },
>(loans: T[], sort: MarketplaceSortOption) {
  return [...loans].sort((left, right) => {
    switch (sort) {
      case "apr_asc":
        return left.apr_bps - right.apr_bps;
      case "term_desc":
        return right.duration_days - left.duration_days;
      case "term_asc":
        return left.duration_days - right.duration_days;
      case "apr_desc":
      default:
        return right.apr_bps - left.apr_bps;
    }
  });
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

  const { user } = await requireAuthenticatedUser("lender");
  const walletAddress =
    String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getLenderDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  const fundedTxsRes = srClient
    ? await srClient
        .from("ledger_transactions")
        .select("id, ref_id, amount, metadata, created_at")
        .eq("user_id", user.id)
        .eq("ref_type", "loan_fund")
        .order("created_at", { ascending: false })
        .limit(20)
    : { data: [] };

  const openLoansRes = srClient
    ? await srClient.rpc("get_marketplace_loans")
    : { data: null, error: null };

  let openLoans: MarketplaceLoanRow[] = [];

  if (!openLoansRes.error) {
    openLoans = (openLoansRes.data ?? []) as MarketplaceLoanRow[];
  } else if (srClient) {
    const fallbackLoansRes = await srClient
      .from("loans")
      .select("id, principal_amount, apr_bps, duration_days, borrower_id")
      .in("status", ["requested", "approved"])
      .order(
        sort === "term_asc" || sort === "term_desc"
          ? "duration_days"
          : "apr_bps",
        { ascending: sort === "apr_asc" || sort === "term_asc" },
      );

    const fallbackLoans = fallbackLoansRes.data ?? [];
    const borrowerIds = Array.from(
      new Set(fallbackLoans.map((loan) => String(loan.borrower_id))),
    );

    const [profilesRes, snapshotsRes] =
      borrowerIds.length > 0
        ? await Promise.all([
            srClient
              .from("profiles")
              .select("id, full_name, wallet_address")
              .in("id", borrowerIds),
            srClient
              .from("reputation_snapshots")
              .select("user_id, score_total")
              .in("user_id", borrowerIds),
          ])
        : [{ data: [] }, { data: [] }];

    const profileMap = new Map(
      (profilesRes.data ?? []).map((profile) => [String(profile.id), profile]),
    );
    const scoreMap = new Map(
      (snapshotsRes.data ?? []).map((snapshot) => [
        String(snapshot.user_id),
        Number(snapshot.score_total ?? 250),
      ]),
    );

    openLoans = fallbackLoans.map((loan) => {
      const borrowerId = String(loan.borrower_id);
      const profile = profileMap.get(borrowerId);

      return {
        id: String(loan.id),
        principal_amount: Number(loan.principal_amount ?? 0),
        apr_bps: Number(loan.apr_bps ?? 0),
        duration_days: Number(loan.duration_days ?? 30),
        borrower_id: borrowerId,
        borrower_name:
          profile?.full_name && String(profile.full_name).trim() !== ""
            ? String(profile.full_name)
            : `Borrower ${borrowerId.slice(0, 6)}`,
        borrower_wallet: String(profile?.wallet_address ?? ""),
        trust_score: Number(scoreMap.get(borrowerId) ?? 250),
      };
    });
  }

  const fundedTxs = fundedTxsRes.data ?? [];
  const marketplaceLoans = openLoans.map((loan) => ({
    id: String(loan.id),
    principal_amount: Number(loan.principal_amount ?? 0),
    apr_bps: Number(loan.apr_bps ?? 0),
    duration_days: Number(loan.duration_days ?? 30),
    trust_score: Number(loan.trust_score ?? 250),
    borrower_name: String(
      loan.borrower_name ?? `Borrower ${String(loan.borrower_id).slice(0, 6)}`,
    ),
    borrower_wallet: String(loan.borrower_wallet ?? ""),
  }));

  const visibleMarketplaceLoans = sortMarketplaceLoans(
    highReputationOnly
      ? marketplaceLoans.filter(
          (loan) => loan.trust_score >= HIGH_REPUTATION_THRESHOLD,
        )
      : marketplaceLoans,
    sort,
  );

  const profileRes = supabase
    ? await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null };
  const profile = profileRes.data;

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Loan Marketplace"
      description="Browse open borrower requests. Fund directly with Freighter or Albedo - XLM goes straight to the borrower's Stellar wallet. Full on-chain transparency."
      email={user.email ?? null}
      userName={String(
        user.user_metadata?.full_name ?? profile?.full_name ?? "",
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
                background: "rgba(126,47,208,0.06)",
                border: "1px solid rgba(126,47,208,0.2)",
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
                        background: "rgba(126,47,208,0.25)",
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
                  background: "rgba(126,47,208,0.04)",
                  border: "1px solid rgba(126,47,208,0.12)",
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
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.65rem",
                    minHeight: "44px",
                    padding: "0.8rem 1rem",
                    borderRadius: "0.75rem",
                    border: "1px solid rgba(126,47,208,0.16)",
                    background: "rgba(255,255,255,0.72)",
                  }}
                >
                  <input
                    type="checkbox"
                    name="highReputation"
                    value="true"
                    defaultChecked={highReputationOnly}
                    style={{ accentColor: "#7e2fd0" }}
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
                      background: "rgba(255,107,107,0.15)",
                      color: "#ff9966",
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
                      background: "rgba(34,207,157,0.12)",
                      color: "#22cf9d",
                      borderRadius: "9999px",
                      padding: "0.2rem 0.7rem",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                    }}
                  >
                    0 matches
                  </span>
                )}
                {(sort !== DEFAULT_SORT || highReputationOnly) &&
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
                    : "Try a different sort option or turn off the high-reputation filter."
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
                        let meta: Record<string, string> = {};

                        try {
                          meta = JSON.parse(String(tx.metadata ?? "{}"));
                        } catch {
                          meta = {};
                        }

                        const txHash = meta.txHash ?? "";

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
