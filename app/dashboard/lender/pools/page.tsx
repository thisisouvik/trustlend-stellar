import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LenderForms } from "@/components/dashboard/LenderForms";
import { InteractiveLineChart } from "@/components/dashboard/InteractiveLineChart";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { formatTokenBalance } from "@/lib/utils/formatting";
import {
  isLikelyTxHash,
  buildStellarTxVerificationUrl,
} from "@/lib/stellar/explorer";
import { STELLAR_TESTNET } from "@/lib/stellar/testnet";

export default async function LenderPoolsPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();

  const walletAddress =
    String(user.user_metadata?.wallet_address ?? "") || null;

  const [poolsRes, positionsRes, profileRes, txHistoryRes] = supabase
    ? await Promise.all([
        supabase
          .from("lending_pools")
          .select(
            "id, name, status, apr_bps, total_liquidity, available_liquidity",
          )
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("pool_positions")
          .select(
            "id, pool_id, status, principal_amount, earned_interest, opened_at",
          )
          .eq("lender_id", user.id)
          .order("opened_at", { ascending: true }),
        supabase
          .from("profiles")
          .select("full_name, kyc_status")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("ledger_transactions")
          .select("id, amount, category, metadata, status, created_at")
          .eq("user_id", user.id)
          .eq("ref_type", "pool_position")
          .order("created_at", { ascending: false })
          .limit(10),
      ])
    : [{ data: [] }, { data: [] }, { data: null }, { data: [] }];

  const pools = poolsRes.data ?? [];
  const positions = positionsRes.data ?? [];
  const profile = profileRes.data;
  const txHistory = txHistoryRes.data ?? [];

  const totalDeployed = positions.reduce(
    (s, p) => s + Number(p.principal_amount ?? 0),
    0,
  );
  const totalEarned = positions.reduce(
    (s, p) => s + Number(p.earned_interest ?? 0),
    0,
  );

  // Fetch live XLM balance from Stellar Horizon (server-side, best-effort)
  let availableWalletBalance = 0;
  if (walletAddress) {
    try {
      const horizonUrl =
        process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
        STELLAR_TESTNET.horizonUrl;
      const accountRes = await fetch(
        `${horizonUrl}/accounts/${walletAddress}`,
        {
          next: { revalidate: 30 },
        },
      );
      if (accountRes.ok) {
        const accountData = await accountRes.json();
        const nativeBalance = (accountData.balances ?? []).find(
          (b: { asset_type: string; balance: string }) =>
            b.asset_type === "native",
        );
        availableWalletBalance = nativeBalance
          ? parseFloat(nativeBalance.balance)
          : 0;
      }
    } catch {
      // Horizon unreachable — WalletCard will fetch live on the client side
    }
  }

  // Generate cumulative portfolio growth data for the chart
  let cumulativeValue = 0;
  const chartData =
    positions.length > 0
      ? positions.map((p) => {
          cumulativeValue +=
            Number(p.principal_amount) + Number(p.earned_interest);
          return {
            label: `Account Value on ${
              p.opened_at
                ? new Date(String(p.opened_at)).toLocaleDateString()
                : "Active"
            }`,
            value: cumulativeValue,
          };
        })
      : [
          { label: "Jan Growth Projection", value: 100 },
          { label: "Feb Growth Projection", value: 250 },
          { label: "Mar Growth Projection", value: 400 },
          { label: "Apr Growth Projection", value: 850 },
        ];

  if (chartData.length === 1) {
    chartData.unshift({ label: "Initial Deposit", value: 0 });
  }

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Pool Investment"
      description="Deposit XLM into a lending pool and earn passive APR. The pool auto-matches your capital to open borrower requests."
      email={user.email ?? null}
      userName={String(
        user.user_metadata?.full_name ?? profile?.full_name ?? "",
      )}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/pools"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">
        {/* ── Available to Invest banner ────────────────────────── */}
        <section aria-label="Available to Invest">
          <article
            style={{
              background:
                "linear-gradient(135deg, rgba(34,207,157,0.12) 0%, rgba(34,207,157,0.04) 100%)",
              border: "1px solid rgba(34,207,157,0.3)",
              borderRadius: "1rem",
              padding: "1.5rem 2rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <div
                style={{
                  width: "3rem",
                  height: "3rem",
                  borderRadius: "50%",
                  background: "rgba(34,207,157,0.15)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "1.4rem",
                  flexShrink: 0,
                }}
              >
                💰
              </div>
              <div>
                <p
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    opacity: 0.55,
                    marginBottom: "0.25rem",
                  }}
                >
                  Available to Invest
                </p>
                <p
                  style={{
                    fontSize: "2rem",
                    fontWeight: 800,
                    color: "#22cf9d",
                    lineHeight: 1,
                    margin: 0,
                  }}
                >
                  {availableWalletBalance > 0
                    ? `${availableWalletBalance.toFixed(2)} XLM`
                    : walletAddress
                      ? "Connect a wallet to load balance"
                      : "Wallet not connected"}
                </p>
                {walletAddress && (
                  <p
                    style={{
                      fontSize: "0.75rem",
                      opacity: 0.45,
                      marginTop: "0.3rem",
                      fontFamily: "monospace",
                    }}
                  >
                    {walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}
                  </p>
                )}
              </div>
            </div>

            {/* Quick stats */}
            <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
              {[
                {
                  label: "Deployed in Pools",
                  value: `${totalDeployed.toFixed(2)} XLM`,
                },
                {
                  label: "Interest Earned",
                  value: `${totalEarned.toFixed(4)} XLM`,
                  green: true,
                },
                {
                  label: "Active Positions",
                  value: String(
                    positions.filter((p) => p.status === "active").length,
                  ),
                },
              ].map((stat) => (
                <div key={stat.label} style={{ textAlign: "center" }}>
                  <p
                    style={{
                      fontSize: "0.7rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      opacity: 0.5,
                      marginBottom: "0.2rem",
                    }}
                  >
                    {stat.label}
                  </p>
                  <p
                    style={{
                      fontWeight: 700,
                      fontSize: "1.1rem",
                      color: stat.green ? "#22cf9d" : "inherit",
                      margin: 0,
                    }}
                  >
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          </article>
        </section>

        {/* TODO (Lender Earnings Calculator Integration):
            1. Interactive APR Calculator Component Design:
               - Implement a component container matching the modern dark mode and glassmorphism styling of the dashboard (using `workspace-card` or similar CSS class).
               - Add header: "Lender Earnings Estimator".
            2. Sliders for Input Adjustments:
               - Deposit Amount (in XLM): Add a range input slider from 100 XLM to 100,000 XLM with a dynamic number input to show the current value.
               - Lock-up Duration (in days): Add a range input slider from 30 days to 365 days with a text label displaying selected days.
            3. Borrower Reputation Tier Toggles:
               - Add group of toggle buttons (Bronze, Silver, Gold, Platinum) to represent the target borrower credit/reputation tier.
               - Based on selected tier, adjust the base APR multiplier or reputation point factor used in the dynamic yield calculation:
                 * Bronze: 1.0x multiplier, base APR
                 * Silver: 1.1x multiplier, +5% dynamic rate adjustment
                 * Gold: 1.25x multiplier, +10% dynamic rate adjustment
                 * Platinum: 1.5x multiplier, +15% dynamic rate adjustment
            4. Dynamic Computations & Yields:
               - Interest Yield = (Deposit Amount * (Pool APR / 10000) * (Duration Days / 365)) * Tier Multiplier
               - Platform Fee = Interest Yield * 0.01 (1% platform fee)
               - Net Expected Rewards = Interest Yield - Platform Fee
               - Expected Reputation Point Gains = (Deposit Amount * 0.01) * (Duration Days / 30) * Tier Multiplier
            5. UI Layout & Visuals:
               - Left column: Sliders for Deposit Amount and Lock-up Duration, and Toggle group for Borrower Reputation Tiers.
               - Right column: Clean, green-highlighted summary cards displaying:
                 * "Net Expected Rewards": e.g., "1,245.50 XLM"
                 * "Dynamic Yield (APR)": e.g., "12.45%"
                 * "Reputation Points Gained": e.g., "+350 pts"
        */}

        {/* ── My positions summary ──────────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          <div
            style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            {[
              {
                label: "Your Total Deployed",
                value: `${totalDeployed.toFixed(2)} XLM`,
              },
              {
                label: "Total Interest Earned",
                value: `${totalEarned.toFixed(4)} XLM`,
                green: true,
              },
              {
                label: "Active Positions",
                value: String(
                  positions.filter((p) => p.status === "active").length,
                ),
              },
            ].map((stat) => (
              <article
                key={stat.label}
                className="workspace-card"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                }}
              >
                <p
                  style={{
                    fontSize: "0.78rem",
                    opacity: 0.55,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    marginBottom: "0.35rem",
                  }}
                >
                  {stat.label}
                </p>
                <p
                  style={{
                    fontSize: "1.6rem",
                    fontWeight: 700,
                    color: stat.green ? "#22cf9d" : "inherit",
                  }}
                >
                  {stat.value}
                </p>
              </article>
            ))}
          </div>

          <article
            className="workspace-card"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "2rem",
            }}
          >
            <h3
              style={{
                fontSize: "0.85rem",
                opacity: 0.6,
                marginBottom: "1rem",
                marginTop: 0,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Cumulative Pool Portfolio Growth
            </h3>
            <InteractiveLineChart points={chartData} color="#22cf9d" />
          </article>
        </section>

        {/* ── Available pools – rendered client-side with skeleton loading ── */}
        {/*
          AvailablePools is a Client Component that:
          1. Starts with isLoading = true and renders <PoolCardSkeleton />
          2. Fetches lending_pools from Supabase browser client
          3. Sets isLoading = false and renders animated pool cards
          This eliminates the blank-screen delay caused by the old
          server-side blocking table render.
        */}
        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title">Available Lending Pools</h2>
          {pools.length === 0 ? (
            <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
              No lending pools have been created yet. Check back soon.
            </p>
          ) : (
            <div className="workspace-table-wrap">
              <table className="workspace-table" aria-label="Lending pools">
                <thead>
                  <tr>
                    <th>Pool Name</th>
                    <th>Status</th>
                    <th>APR</th>
                    <th>Total Size</th>
                    <th>Available</th>
                    <th>My Stake</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((pool) => {
                    const myPos = positions.find(
                      (p) => String(p.pool_id) === String(pool.id),
                    );
                    return (
                      <tr key={String(pool.id)}>
                        <td>
                          <strong>{String(pool.name)}</strong>
                        </td>
                        <td>
                          <span
                            style={{
                              padding: "0.15rem 0.5rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              background:
                                pool.status === "active"
                                  ? "rgba(34,207,157,0.12)"
                                  : "rgba(255,107,107,0.12)",
                              color:
                                pool.status === "active"
                                  ? "#22cf9d"
                                  : "#ff6b6b",
                            }}
                          >
                            {String(pool.status).toUpperCase()}
                          </span>
                        </td>
                        <td>{(Number(pool.apr_bps ?? 0) / 100).toFixed(2)}%</td>
                        <td>
                          {formatTokenBalance(Number(pool.total_liquidity ?? 0))}
                        </td>
                        <td>
                          {formatTokenBalance(Number(pool.available_liquidity ?? 0))}
                        </td>
                        <td
                          style={{
                            color: myPos ? "#22cf9d" : "inherit",
                            fontWeight: myPos ? 600 : 400,
                          }}
                        >
                          {myPos
                            ? `${formatTokenBalance(Number(myPos.principal_amount ?? 0))} ✅`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

        {/* ── Deposit / Withdraw forms ──────────────────────────── */}
        <section className="workspace-grid workspace-grid--two">
          <LenderForms
            pools={pools}
            positions={positions}
            walletBalance={availableWalletBalance}
          />

          {/* My positions detail */}
          <article className="workspace-card">
            <h2 className="workspace-card-title">Your Positions</h2>
            {positions.length === 0 ? (
              <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
                No positions yet. Make your first deposit using the form.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.65rem",
                }}
              >
                {positions.map((pos) => {
                  const pool = pools.find(
                    (p) => String(p.id) === String(pos.pool_id),
                  );
                  return (
                    <li
                      key={String(pos.id)}
                      style={{
                        padding: "0.75rem",
                        borderRadius: "0.6rem",
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.07)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: "0.25rem",
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: "0.88rem" }}>
                          {pool
                            ? String(pool.name)
                            : `Pool ${String(pos.pool_id).slice(0, 6)}`}
                        </span>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            padding: "0.1rem 0.45rem",
                            borderRadius: "9999px",
                            background:
                              pos.status === "active"
                                ? "rgba(34,207,157,0.12)"
                                : "rgba(255,107,107,0.12)",
                            color:
                              pos.status === "active" ? "#22cf9d" : "#ff6b6b",
                          }}
                        >
                          {String(pos.status ?? "active").toUpperCase()}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "1.5rem",
                          fontSize: "0.83rem",
                          opacity: 0.75,
                        }}
                      >
                        <span>
                          Deployed:{" "}
                          <strong>
                            {Number(pos.principal_amount ?? 0).toFixed(2)} XLM
                          </strong>
                        </span>
                        <span>
                          Earned:{" "}
                          <strong style={{ color: "#22cf9d" }}>
                            {Number(pos.earned_interest ?? 0).toFixed(4)} XLM
                          </strong>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </section>

        {/* ── Transaction History ───────────────────────────────── */}
        {txHistory.length > 0 && (
          <section
            className="workspace-card workspace-card--full"
            style={{ marginTop: "1rem" }}
          >
            <h2 className="workspace-card-title">Recent Activity</h2>
            <div className="workspace-table-wrap">
              <table className="workspace-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {txHistory.map((tx) => {
                    let txHash = "";
                    try {
                      const meta = JSON.parse(String(tx.metadata || "{}"));
                      txHash = meta.txHash ?? "";
                    } catch {}

                    const isDeposit = tx.category === "deposit";

                    return (
                      <tr key={String(tx.id)}>
                        <td style={{ opacity: 0.8, fontSize: "0.85rem" }}>
                          {tx.created_at
                            ? new Date(
                                String(tx.created_at),
                              ).toLocaleDateString()
                            : "—"}
                        </td>
                        <td>
                          <span
                            style={{
                              padding: "0.15rem 0.5rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              background: isDeposit
                                ? "rgba(34,207,157,0.12)"
                                : "rgba(155,111,224,0.12)",
                              color: isDeposit ? "#22cf9d" : "#9b6fe0",
                            }}
                          >
                            {String(tx.category ?? "Unknown").toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>
                          {Number(tx.amount || 0).toFixed(2)} XLM
                        </td>
                        <td
                          style={{
                            opacity: 0.7,
                            fontSize: "0.85rem",
                            textTransform: "capitalize",
                          }}
                        >
                          {tx.status}
                        </td>
                        <td>
                          {isLikelyTxHash(txHash) ? (
                            <a
                              href={buildStellarTxVerificationUrl(txHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="workspace-nav-link"
                              style={{
                                display: "inline-block",
                                background: "rgba(34,207,157,0.1)",
                                color: "#22cf9d",
                                padding: "0.3rem 0.6rem",
                                borderRadius: "0.4rem",
                                fontSize: "0.75rem",
                              }}
                            >
                              ✅ Verify Tx ↗
                            </a>
                          ) : (
                            <span
                              style={{
                                opacity: 0.4,
                                fontSize: "0.8rem",
                                fontStyle: "italic",
                              }}
                            >
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </WorkspaceFrame>
  );
}
