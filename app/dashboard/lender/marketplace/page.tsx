import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { LoanMarketplace } from "@/components/dashboard/LoanMarketplace";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";

export default async function LenderMarketplacePage() {
  const { user } = await requireAuthenticatedUser("lender");
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getLenderDashboardMetrics(user.id);

  const supabase  = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  // ── Own funded loan records (ledger) ─────────────────────────────────────
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

  let openLoans: MarketplaceLoanRow[] = [];

  if (!openLoansRes.error) {
    openLoans = (openLoansRes.data ?? []) as MarketplaceLoanRow[];
  } else if (srClient) {
    // Fallback path for environments where the RPC migration is not applied yet.
    const fallbackLoansRes = await srClient
      .from("loans")
      .select("id, principal_amount, apr_bps, duration_days, borrower_id")
      .in("status", ["requested", "approved"])
      .order("created_at", { ascending: true });

    const fallbackLoans = fallbackLoansRes.data ?? [];
    const borrowerIds = Array.from(new Set(fallbackLoans.map((l) => String(l.borrower_id))));

    const [profilesRes, snapshotsRes] = borrowerIds.length > 0
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
      (profilesRes.data ?? []).map((p) => [String(p.id), p])
    );
    const scoreMap = new Map(
      (snapshotsRes.data ?? []).map((s) => [String(s.user_id), Number(s.score_total ?? 250)])
    );

    openLoans = fallbackLoans.map((l) => {
      const borrowerId = String(l.borrower_id);
      const profile = profileMap.get(borrowerId);
      return {
        id: String(l.id),
        principal_amount: Number(l.principal_amount ?? 0),
        apr_bps: Number(l.apr_bps ?? 0),
        duration_days: Number(l.duration_days ?? 30),
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

  const fundedTxs        = fundedTxsRes.data        ?? [];
  const marketplaceLoans = openLoans.map((l) => ({
    id: String(l.id),
    principal_amount: Number(l.principal_amount ?? 0),
    apr_bps: Number(l.apr_bps ?? 0),
    duration_days: Number(l.duration_days ?? 30),
    trust_score: Number(l.trust_score ?? 250),
    borrower_name: String(l.borrower_name ?? `Borrower ${String(l.borrower_id).slice(0, 6)}`),
    borrower_wallet: String(l.borrower_wallet ?? ""),
  }));

  const profileRes = supabase
    ? await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle()
    : { data: null };
  const profile = profileRes.data;


  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Loan Marketplace"
      description="Browse open borrower requests. Fund directly via Freighter — XLM goes straight to the borrower's Stellar wallet. Full on-chain transparency."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/marketplace"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">
        {!walletAddress ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">⚠️ Wallet Required</h2>
            <p className="workspace-card-copy">
              Connect your Stellar wallet in Profile & Settings before funding loans.
            </p>
          </article>
        ) : (
          <>
            {/* ── How it works ───────────────────────────────────────── */}
            <article className="workspace-card workspace-card--full" style={{ background: "rgba(126,47,208,0.06)", border: "1px solid rgba(126,47,208,0.2)" }}>
              <h2 className="workspace-card-title">How Direct Lending Works</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginTop: "0.75rem" }}>
                {[
                  { step: "1", label: "Browse", desc: "Review open borrower requests — their trust score, amount, APR, and duration." },
                  { step: "2", label: "Fund",   desc: "Click Fund. Freighter opens and asks you to sign the Stellar payment." },
                  { step: "3", label: "On-chain", desc: "XLM goes directly to the borrower's wallet with a TL-FUND memo on Stellar." },
                  { step: "4", label: "Earn",   desc: "When the borrower repays, you receive principal + interest back to your wallet." },
                ].map((s) => (
                  <div key={s.step} style={{ display: "flex", gap: "0.75rem" }}>
                    <span style={{ width: "1.75rem", height: "1.75rem", borderRadius: "50%", background: "rgba(126,47,208,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "0.85rem", flexShrink: 0 }}>
                      {s.step}
                    </span>
                    <div>
                      <p style={{ fontWeight: 600, fontSize: "0.88rem", marginBottom: "0.25rem" }}>{s.label}</p>
                      <p style={{ fontSize: "0.8rem", opacity: 0.6, lineHeight: 1.4 }}>{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </article>

            {/* ── Open loan requests ─────────────────────────────────── */}
            <article className="workspace-card workspace-card--full">
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
                <h2 className="workspace-card-title" style={{ margin: 0 }}>Open Requests</h2>
                {marketplaceLoans.length > 0 ? (
                  <span style={{ background: "rgba(255,107,107,0.15)", color: "#ff9966", borderRadius: "9999px", padding: "0.2rem 0.7rem", fontSize: "0.75rem", fontWeight: 700 }}>
                    {marketplaceLoans.length} open
                  </span>
                ) : (
                  <span style={{ background: "rgba(34,207,157,0.12)", color: "#22cf9d", borderRadius: "9999px", padding: "0.2rem 0.7rem", fontSize: "0.75rem", fontWeight: 700 }}>
                    All funded ✅
                  </span>
                )}
              </div>
              <LoanMarketplace loans={marketplaceLoans} lenderWallet={walletAddress} />
            </article>

            {/* ── Loans you've funded ────────────────────────────────── */}
            <article className="workspace-card workspace-card--full">
              <h2 className="workspace-card-title">Loans You Funded</h2>
              {fundedTxs.length === 0 ? (
                <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
                  You haven&apos;t directly funded any loans yet. Pick a request above to get started.
                </p>
              ) : (
                <div className="workspace-table-wrap">
                  <table className="workspace-table" aria-label="Loans you funded">
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
                        try { meta = JSON.parse(String(tx.metadata ?? "{}")); } catch { /* ignore */ }
                        const txHash = meta.txHash ?? "";
                        return (
                          <tr key={String(tx.id)}>
                            <td style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>
                              {String(tx.ref_id ?? "").slice(0, 8)}
                            </td>
                            <td><strong>{Number(tx.amount ?? 0).toFixed(2)} XLM</strong></td>
                            <td style={{ fontSize: "0.82rem", opacity: 0.7 }}>
                              {tx.created_at ? new Date(String(tx.created_at)).toLocaleDateString() : "—"}
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
                                  Verify on Stellar ↗
                                </a>
                              ) : (
                                <span style={{ opacity: 0.4, fontSize: "0.8rem" }}>—</span>
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
