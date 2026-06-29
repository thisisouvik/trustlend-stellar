import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getBorrowerDashboardMetrics,
  presentBorrowerMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { buildStellarTxVerificationUrl, extractPossibleTxHash, isLikelyTxHash } from "@/lib/stellar/explorer";
import { BorrowerRepayWidget } from "@/components/dashboard/BorrowerRepayWidget";
import { WithdrawToFiatButton } from "@/components/dashboard/WithdrawToFiatButton";
import { borrowerNavLinks } from "@/lib/dashboard/borrower-links";

// ── Inline SVG illustrations ───────────────────────────────────────────────
function EmptyLoansIllustration() {
  return (
    <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="8" y="20" width="64" height="44" rx="8" fill="url(#emptyGrad)" opacity="0.9" />
      <rect x="16" y="32" width="24" height="4" rx="2" fill="white" opacity="0.6" />
      <rect x="16" y="42" width="16" height="4" rx="2" fill="white" opacity="0.4" />
      <circle cx="58" cy="38" r="10" fill="white" opacity="0.15" />
      <path d="M40 8 L44 16 L52 16 L46 21 L48 29 L40 24 L32 29 L34 21 L28 16 L36 16 Z"
            fill="url(#starGrad)" opacity="0.8" />
      <defs>
        <linearGradient id="emptyGrad" x1="8" y1="20" x2="72" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7e2fd0" />
          <stop offset="1" stopColor="#22cf9d" />
        </linearGradient>
        <linearGradient id="starGrad" x1="28" y1="8" x2="52" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f5a623" />
          <stop offset="1" stopColor="#f7c948" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default async function BorrowerDashboardPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const metrics = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  const [profileRes, loansRes] = supabase
    ? await Promise.all([
        supabase
          .from("profiles")
          .select("full_name, phone, date_of_birth, country_code, kyc_status, risk_status, government_id_url, kyc_submitted_at")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("loans")
          .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, due_at, created_at")
          .eq("borrower_id", user.id)
          .order("created_at", { ascending: false })
          .limit(20),
      ])
    : [{ data: null }, { data: [] }];

  const profile = profileRes.data;
  const loans = loansRes.data ?? [];

  // Stellar TX lookups
  const loanIds = loans.map((l) => String(l.id));
  const ledgerRes = srClient && loanIds.length > 0
    ? await srClient
        .from("ledger_transactions")
        .select("ref_id, metadata")
        .eq("ref_type", "loan_fund")
        .in("ref_id", loanIds)
    : { data: [] };
  const loanTxMap: Record<string, string> = {};
  const fundedLoanIds = new Set<string>();
  for (const entry of ledgerRes.data ?? []) {
    if (String(entry.ref_id)) {
      fundedLoanIds.add(String(entry.ref_id));
      const extracted = extractPossibleTxHash(entry.metadata);
      if (extracted) {
        loanTxMap[String(entry.ref_id)] = extracted;
      }
    }
  }

  const normalizedLoans = loans.map((loan) => {
    const status = String(loan.status ?? "requested");
    const hasFundingLedger = fundedLoanIds.has(String(loan.id));
    const effectiveStatus = status === "requested" && hasFundingLedger ? "funded" : status;
    return { ...loan, effectiveStatus };
  });

  const kycStatus = String(profile?.kyc_status ?? "pending");
  const isKycVerified = kycStatus === "verified";
  const hasGovIdSubmission = Boolean(profile?.government_id_url || profile?.kyc_submitted_at || kycStatus === "submitted" || isKycVerified);

  const verificationItems = [
    { label: "Email Verified",      done: Boolean(user.email_confirmed_at) },
    { label: "Legal Name Set",      done: Boolean(profile?.full_name) },
    { label: "Phone Number",        done: Boolean(profile?.phone) },
    { label: "Date of Birth",       done: Boolean(profile?.date_of_birth) },
    { label: "Government ID (KYC)", done: hasGovIdSubmission },
  ];
  const verificationProgress = Math.round((verificationItems.filter((i) => i.done).length / verificationItems.length) * 100);
  const profileComplete = verificationProgress === 100;
  const canApplyLoan = profileComplete && isKycVerified;
  const profileNeedsAttention = !canApplyLoan;

  const REPAYABLE_STATUSES = ["active", "funded", "approved"];
  const activeLoans  = normalizedLoans.filter((l) => REPAYABLE_STATUSES.includes(String(l.effectiveStatus)));
  const pendingLoans = normalizedLoans.filter((l) => String(l.effectiveStatus) === "requested");
  const inLoansXlm   = activeLoans.reduce((sum, l) => sum + Math.max(0, Number(l.principal_amount ?? 0) - Number(l.repaid_amount ?? 0)), 0);
  const pendingXlm   = pendingLoans.reduce((sum, l) => sum + Number(l.principal_amount ?? 0), 0);

  const repayableLoan = activeLoans[0] ?? null;
  const dueAmount = repayableLoan
    ? Math.max(0, Number(repayableLoan.principal_amount ?? 0) - Number(repayableLoan.repaid_amount ?? 0))
    : 0;

  // Header gradient class by status
  const cardHeaderClass = (s: string) => {
    if (s === "requested") return "borrower-loan-card__header--requested";
    if (s === "approved")  return "borrower-loan-card__header--approved";
    if (s === "repaid")    return "borrower-loan-card__header--repaid";
    return "borrower-loan-card__header--active"; // active / funded
  };

  // Human-readable status label
  const statusLabel = (s: string) => {
    const map: Record<string, string> = {
      requested: "Pending Review",
      approved:  "Approved",
      funded:    "Funded",
      active:    "Active",
      repaid:    "Fully Repaid",
    };
    return map[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
  };

  const isLive = (s: string) => s === "active" || s === "funded";

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="My Dashboard"
      description="Your active loans, verification status, and quick actions — all in one place."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      headerWidget={
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={inLoansXlm}
          pending={pendingXlm}
          inLoansLabel="In Loans"
          compact
        />
      }
      currentPath="/dashboard/borrower"
      profilePath="/dashboard/borrower/profile"
      profileSummary={profileNeedsAttention ? {
        completion: verificationProgress,
        kycStatus,
        warningText: kycStatus === "submitted" && !isKycVerified
          ? "Your documents are under admin review."
          : profileComplete
            ? "Your profile is ready, but KYC approval is still required to unlock borrowing."
            : "Complete your profile to unlock borrowing.",
        requiredItems: profileComplete && !isKycVerified
          ? ["KYC approval"]
          : verificationItems.filter((i) => !i.done).map((i) => i.label),
      } : undefined}
      showProfileAlert={profileNeedsAttention}
      links={borrowerNavLinks}
    >
      <div className="workspace-stack">

        {/* ── Wallet Alert Banner ── */}
        {!walletAddress && (
          <div className="borrower-wallet-alert">
            <span className="borrower-wallet-alert__icon">⚠️</span>
            <div className="borrower-wallet-alert__body">
              <p className="borrower-wallet-alert__title">Connect Your Stellar Wallet</p>
              <p className="borrower-wallet-alert__copy">
                A wallet is required to receive or repay loans on-chain. Visit{" "}
                <a href="/dashboard/borrower/profile" style={{ fontWeight: 800, textDecoration: "underline" }}>
                  Profile &amp; Settings
                </a>{" "}
                to set it up.
              </p>
            </div>
          </div>
        )}

        {/* ── Verification Status Strip ── */}
        <div className="borrower-verify-card">
          <div className="borrower-verify-header">
            <h2 className="borrower-verify-title">Verification Status</h2>
            <span
              className={`borrower-verify-pct ${
                verificationProgress === 100
                  ? "borrower-verify-pct--done"
                  : "borrower-verify-pct--pending"
              }`}
            >
              {verificationProgress}% Complete
            </span>
          </div>

          <div className="borrower-verify-track" role="progressbar"
               aria-valuenow={verificationProgress} aria-valuemin={0} aria-valuemax={100}
               aria-label={`Profile ${verificationProgress}% complete`}>
            <div
              className="borrower-verify-fill"
              style={{ width: `${verificationProgress}%` }}
            />
          </div>

          <div className="borrower-verify-chips">
            {verificationItems.map((item) => (
              <span
                key={item.label}
                className={`borrower-verify-chip ${
                  item.done ? "borrower-verify-chip--done" : "borrower-verify-chip--pending"
                }`}
              >
                {item.done ? "✓" : "○"} {item.label}
              </span>
            ))}
          </div>

          {!profileComplete && (
            <a href="/dashboard/borrower/profile" className="borrower-verify-cta">
              Complete Profile →
            </a>
          )}
        </div>

        {/* ── Loan Cards ── */}
        {normalizedLoans.length > 0 && (
          <div className="borrower-loan-section">
            <div className="borrower-loan-section__header">
              <h2 className="borrower-loan-section__title">Your Loans</h2>
              <a href="/dashboard/borrower/history" className="borrower-loan-section__link">
                View full history →
              </a>
            </div>

            <div className="borrower-loan-cards">
              {normalizedLoans.slice(0, 6).map((loan) => {
                const status   = String(loan.effectiveStatus);
                const loanId   = String(loan.id);
                const txHash   = loanTxMap[loanId] ?? "";
                const hasTx    = isLikelyTxHash(txHash);
                const principal = Number(loan.principal_amount ?? 0);
                const repaid    = Number(loan.repaid_amount ?? 0);
                const repayPct  = principal > 0 ? Math.min(100, Math.round((repaid / principal) * 100)) : 0;
                const apr       = (Number(loan.apr_bps ?? 0) / 100).toFixed(2);
                const due       = loan.due_at ? new Date(String(loan.due_at)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

                return (
                  <article key={loanId} className="borrower-loan-card">
                    {/* ── Card Header ── */}
                    <div className={`borrower-loan-card__header ${cardHeaderClass(status)}`}>
                      <div className="borrower-loan-card__chip">
                        {isLive(status) && <span className="borrower-live-dot" />}
                        {statusLabel(status)}
                      </div>
                      <p className="borrower-loan-card__amount">
                        {principal.toFixed(2)}
                        <span style={{ fontSize: "1rem", fontWeight: 600, marginLeft: "0.35rem", opacity: 0.8 }}>XLM</span>
                      </p>
                      <span className="borrower-loan-card__amount-label">Principal</span>
                      <span className="borrower-loan-card__id">#{loanId.slice(0, 8)}</span>
                    </div>

                    {/* ── Card Body ── */}
                    <div className="borrower-loan-card__body">
                      {/* Repayment progress */}
                      <div>
                        <div className="borrower-loan-card__progress-row">
                          <span>Repaid: <strong>{repaid.toFixed(2)} XLM</strong></span>
                          <span>{repayPct}%</span>
                        </div>
                        <div className="borrower-loan-card__progress-track">
                          <div
                            className="borrower-loan-card__progress-fill"
                            style={{ width: `${repayPct}%` }}
                          />
                        </div>
                      </div>

                      {/* Key metadata */}
                      <div className="borrower-loan-card__meta">
                        <div className="borrower-loan-card__meta-item">
                          <span className="borrower-loan-card__meta-label">APR</span>
                          <span className="borrower-loan-card__meta-value">{apr}%</span>
                        </div>
                        <div className="borrower-loan-card__meta-item">
                          <span className="borrower-loan-card__meta-label">Due Date</span>
                          <span className="borrower-loan-card__meta-value">{due}</span>
                        </div>
                        {Number(loan.duration_days) > 0 && (
                          <div className="borrower-loan-card__meta-item">
                            <span className="borrower-loan-card__meta-label">Duration</span>
                            <span className="borrower-loan-card__meta-value">{loan.duration_days}d</span>
                          </div>
                        )}
                        <div className="borrower-loan-card__meta-item">
                          <span className="borrower-loan-card__meta-label">Remaining</span>
                          <span className="borrower-loan-card__meta-value">
                            {Math.max(0, principal - repaid).toFixed(2)} XLM
                          </span>
                        </div>
                      </div>

                      {/* Footer: TX badge + receipt */}
                      <div className="borrower-loan-card__footer">
                        {hasTx ? (
                          <a
                            href={buildStellarTxVerificationUrl(txHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="borrower-loan-card__tx-badge borrower-loan-card__tx-badge--live"
                          >
                            ✦ Verify on Stellar ↗
                          </a>
                        ) : (
                          <span className="borrower-loan-card__tx-badge borrower-loan-card__tx-badge--pending">
                            {status === "requested" || status === "approved"
                              ? "⏳ Pending Approval"
                              : status === "funded"
                              ? "⌛ Processing"
                              : "— No TX"}
                          </span>
                        )}

                        {status === "repaid" && (
                          <a
                            href={`/api/loans/${loanId}/receipt`}
                            target="_blank"
                            rel="noreferrer"
                            className="borrower-loan-card__receipt-btn"
                          >
                            ↓ Receipt
                          </a>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Quick Repayment Widget (if active loan) ── */}
        {repayableLoan && (
          <BorrowerRepayWidget
            loan={{
              id: String(repayableLoan.id),
              principal_amount: Number(repayableLoan.principal_amount),
              repaid_amount: Number(repayableLoan.repaid_amount ?? 0),
              due_at: repayableLoan.due_at ? String(repayableLoan.due_at) : null,
            }}
            dueAmount={dueAmount}
          />
        )}

        {/* ── Cash out to fiat via Stellar Anchor (SEP-24) ── */}
        <WithdrawToFiatButton walletAddress={walletAddress} />

        {/* ── Polished Empty State (no loans) ── */}
        {normalizedLoans.length === 0 && (
          <div className="borrower-empty-state">
            <div className="borrower-empty-state__glow" aria-hidden="true" />
            <div className="borrower-empty-state__icon">
              <EmptyLoansIllustration />
            </div>
            <h2 className="borrower-empty-state__title">
              {canApplyLoan
                ? "Ready to Borrow?"
                : profileComplete
                ? "KYC Under Review"
                : "Complete Your Profile"}
            </h2>
            <p className="borrower-empty-state__copy">
              {canApplyLoan
                ? "You're fully verified and ready to go. Submit your first loan request and get funded on Stellar."
                : profileComplete
                ? "Your profile is complete and your KYC documents are being reviewed by our team. You'll be notified once approved."
                : "Finish setting up your profile and complete KYC verification to unlock borrowing on TrustLend."}
            </p>
            <a
              href={canApplyLoan ? "/dashboard/borrower/loans" : "/dashboard/borrower/profile"}
              className={`borrower-empty-state__cta${profileComplete && !canApplyLoan ? " borrower-empty-state__cta--kyc" : ""}`}
            >
              {canApplyLoan
                ? "Apply for a Loan →"
                : profileComplete
                ? "Check KYC Status"
                : "Complete Profile →"}
            </a>
          </div>
        )}

      </div>
    </WorkspaceFrame>
  );
}
