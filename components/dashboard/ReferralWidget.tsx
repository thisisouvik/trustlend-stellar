"use client";

/**
 * ReferralWidget — the user's unique invite link and programme progress
 * (Issue #266).
 *
 * Fetches from /api/referrals on mount so the code is created on demand for
 * users who predate the referral migration.
 */

import { useCallback, useEffect, useState } from "react";

interface ReferralRow {
  id: string;
  status: string;
  bonusAmount: number;
  invitedAt: string | null;
  qualifiedAt: string | null;
  paidAt: string | null;
}

interface ReferralData {
  referralCode: string;
  referralLink: string;
  stats: {
    totalInvited: number;
    pending: number;
    qualified: number;
    paid: number;
    totalEarned: number;
  };
  referrals: ReferralRow[];
}

const STATUS_META: Record<string, { label: string; color: string; hint: string }> = {
  pending: {
    label: "Signed up",
    color: "var(--warning)",
    hint: "Waiting for their first loan to be funded.",
  },
  qualified: {
    label: "Bonus earned",
    color: "var(--primary)",
    hint: "Their loan is active — your bonus is being paid on-chain.",
  },
  paid: {
    label: "Paid",
    color: "var(--accent)",
    hint: "Bonus delivered to your wallet.",
  },
  rejected: {
    label: "Not eligible",
    color: "var(--danger)",
    hint: "This referral did not qualify for a bonus.",
  },
};

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? {
    label: status,
    color: "var(--fg-muted)",
    hint: "",
  };
  return (
    <span
      title={meta.hint}
      style={{
        display: "inline-block",
        padding: "0.15rem 0.55rem",
        borderRadius: "9999px",
        fontSize: "0.7rem",
        fontWeight: 700,
        background: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
        color: meta.color,
        border: `1px solid color-mix(in srgb, ${meta.color} 27%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

export function ReferralWidget() {
  const [data, setData] = useState<ReferralData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/referrals");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not load your referral link.");
      }
      setData((await res.json()) as ReferralData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copyLink = useCallback(async () => {
    if (!data?.referralLink) return;
    try {
      await navigator.clipboard.writeText(data.referralLink);
      setCopied(true);
      // Revert the button label so it can be used again.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy automatically — select the link and copy it.");
    }
  }, [data?.referralLink]);

  if (isLoading) {
    return (
      <section className="referral-widget" aria-busy="true">
        <h2 className="workspace-card-title">Invite friends</h2>
        <p className="referral-widget__muted">Loading your referral link…</p>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="referral-widget">
        <h2 className="workspace-card-title">Invite friends</h2>
        <p className="referral-widget__error">{error}</p>
        <button type="button" onClick={load} className="referral-widget__retry">
          Retry
        </button>
      </section>
    );
  }

  if (!data) return null;

  const { stats, referrals, referralLink, referralCode } = data;

  return (
    <section className="referral-widget" aria-labelledby="referral-heading">
      <div className="referral-widget__header">
        <h2 className="workspace-card-title" id="referral-heading">
          Invite friends, earn TLND
        </h2>
      </div>

      <p className="referral-widget__lede">
        Share your link. When someone you invite takes out their first loan, your
        bonus is paid automatically by the referral smart contract.
      </p>
      <p className="referral-widget__muted">
        A new member&apos;s first valid invite is locked in and cannot be changed later.
      </p>

      {/* ── The unique link ── */}
      <div className="referral-widget__link-row">
        <label htmlFor="referral-link-input" className="referral-widget__label">
          Your referral link
        </label>
        <div className="referral-widget__link-controls">
          <input
            id="referral-link-input"
            type="text"
            readOnly
            value={referralLink}
            className="referral-widget__input"
            // Selecting everything on focus makes manual copying easy when
            // the Clipboard API is unavailable.
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={copyLink}
            className="referral-widget__copy"
            aria-label={`Copy your referral link, ${referralLink}`}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="referral-widget__code">
          Referral code: <strong>{referralCode}</strong>
        </p>
        {/* Announce the copy result to screen readers, which cannot see the
            button label change. */}
        <span aria-live="polite" className="referral-widget__sr">
          {copied ? "Referral link copied to clipboard" : ""}
        </span>
      </div>

      {error && <p className="referral-widget__error">{error}</p>}

      {/* ── Stats ── */}
      <dl className="referral-widget__stats">
        <div>
          <dt>Invited</dt>
          <dd>{stats.totalInvited}</dd>
        </div>
        <div>
          <dt>Awaiting loan</dt>
          <dd>{stats.pending}</dd>
        </div>
        <div>
          <dt>Bonuses earned</dt>
          <dd>{stats.qualified + stats.paid}</dd>
        </div>
        <div>
          <dt>Total earned</dt>
          <dd className="referral-widget__earned">
            {stats.totalEarned.toFixed(2)}{" "}
            <span className="referral-widget__unit">TLND</span>
          </dd>
        </div>
      </dl>

      {/* ── Invited users ── */}
      {referrals.length > 0 ? (
        <div className="referral-widget__table-wrap">
          <table className="referral-widget__table">
            <caption className="referral-widget__caption">
              People you have invited
            </caption>
            <thead>
              <tr>
                <th scope="col">Invited</th>
                <th scope="col">Status</th>
                <th scope="col">Bonus</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.invitedAt
                      ? new Date(r.invitedAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>
                    {r.bonusAmount > 0 ? `${r.bonusAmount.toFixed(2)} TLND` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="referral-widget__empty">
          No invites yet. Share your link to get started.
        </p>
      )}
    </section>
  );
}
