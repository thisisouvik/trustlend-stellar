"use client";

import { Fragment, useState } from "react";
import { DirectFundForm } from "./DirectFundForm";

interface MarketplaceLoan {
  id: string;
  principal_amount: number;
  apr_bps: number;
  duration_days: number;
  trust_score: number;
  borrower_name: string;
  borrower_wallet: string;
}

interface LoanMarketplaceProps {
  loans: MarketplaceLoan[];
  lenderWallet: string | null;
}

function TrustBadge({ score }: { score: number }) {
  // TrustLend score range: 0-750
  // Green  >= 200 : Good standing (default new users start at 250)
  // Yellow >= 100 : Fair / limited history
  // Red    < 100  : High risk / new with no history
  const color =
    score >= 200 ? "#22cf9d" :
    score >= 100 ? "#f5a623" :
    "#ff6b6b";
  const label =
    score >= 200 ? "🟢" :
    score >= 100 ? "🟡" :
    "🔴";
  return (
    <span
      title={`Trust score: ${score}/750`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.2rem 0.6rem",
        borderRadius: "9999px",
        fontSize: "0.75rem",
        fontWeight: 700,
        background: `${color}1a`,
        color,
        border: `1px solid ${color}44`,
        whiteSpace: "nowrap",
      }}
    >
      {label} {score}
    </span>
  );
}

export function LoanMarketplace({ loans, lenderWallet: _lenderWallet }: LoanMarketplaceProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loans.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "2rem",
          opacity: 0.55,
          border: "1px dashed rgba(255,255,255,0.1)",
          borderRadius: "0.75rem",
        }}
      >
        <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>🎉 All loans are funded!</p>
        <p style={{ fontSize: "0.85rem" }}>No open loan requests right now. Check back soon.</p>
      </div>
    );
  }

  return (
    <div className="workspace-table-wrap">
      <table className="workspace-table" aria-label="Open loan requests marketplace">
        <thead>
          <tr>
            <th>Loan ID</th>
            <th>Borrower</th>
            <th>Trust Score</th>
            <th>Amount</th>
            <th>APR</th>
            <th>Duration</th>
            <th>Est. Return</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {loans.map((loan) => {
            const interestXlm = (
              (loan.principal_amount * (loan.apr_bps / 10000) * loan.duration_days) / 365
            ).toFixed(2);
            const isExpanded = expandedId === loan.id;
            const hasWallet  = Boolean(loan.borrower_wallet);

            // Fragment with key fixes the "Each child in a list" React warning.
            // <> shorthand cannot accept a key prop.
            return (
              <Fragment key={loan.id}>
                <tr
                  style={{
                    background: isExpanded ? "rgba(126,47,208,0.06)" : undefined,
                    transition: "all 0.25s ease",
                    cursor: hasWallet ? "pointer" : "default",
                  }}
                  onClick={() => hasWallet && setExpandedId(isExpanded ? null : loan.id)}
                >
                  <td style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "#666" }}>
                    {loan.id.slice(0, 8)}
                  </td>
                  <td style={{ fontWeight: 600, color: "#111" }}>{loan.borrower_name}</td>
                  <td><TrustBadge score={loan.trust_score} /></td>
                  <td><strong style={{ fontSize: "1rem", color: "#111" }}>{loan.principal_amount.toFixed(2)}</strong> <span style={{ fontSize: "0.75rem", opacity: 0.6, color: "#444" }}>XLM</span></td>
                  <td style={{ fontWeight: 600, color: "#111" }}>{(loan.apr_bps / 100).toFixed(2)}%</td>
                  <td style={{ color: "#444" }}>{loan.duration_days} days</td>
                  <td style={{ color: "#22cf9d", fontWeight: 700 }}>
                    +{interestXlm} <span style={{ fontSize: "0.7rem", opacity: 0.8 }}>XLM</span>
                  </td>
                  <td>
                    {!hasWallet ? (
                      <span
                        style={{ fontSize: "0.75rem", color: "#ff9966", opacity: 0.9, fontWeight: 600 }}
                        title="Borrower has not connected a Stellar wallet yet"
                      >
                        ⚠ No wallet
                      </span>
                    ) : (
                      <button
                        className="workspace-button workspace-button--primary"
                        style={{
                          fontSize: "0.75rem",
                          padding: "0.4rem 1rem",
                          height: "auto",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {isExpanded ? "Close" : "Fund →"}
                      </button>
                    )}
                  </td>
                </tr>

                {/* Inline funding form row */}
                {isExpanded && (
                  <tr>
                    <td 
                      colSpan={8} 
                      style={{ 
                        padding: "1.5rem 1rem", 
                        background: "#fafafa",
                        borderBottom: "1px solid rgba(126, 47, 208, 0.15)",
                        borderTop: "1px solid rgba(126, 47, 208, 0.1)",
                      }}
                    >
                      <div style={{ animation: "fadeInUp 0.3s ease-out" }}>
                        <DirectFundForm
                          loan={{
                            id:               loan.id,
                            principal_amount: loan.principal_amount,
                            apr_bps:          loan.apr_bps,
                            duration_days:    loan.duration_days,
                            trust_score:      loan.trust_score,
                            borrower_wallet:  loan.borrower_wallet,
                          }}
                          onClose={() => setExpandedId(null)}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
