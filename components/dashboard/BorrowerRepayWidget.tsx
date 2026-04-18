"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface RepayLoan {
  id: string;
  principal_amount: number;
  repaid_amount: number;
  due_at: string | null;
}

interface RepaymentRecord {
  id: string;
  amount: number;
  created_at: string;
  repayment_id: string;
}

interface SuccessData {
  amount: number;
  repaymentId: string;
  txHash: string;
}

type Step = "idle" | "preflight" | "connecting" | "building" | "signing" | "submitting" | "recording";

interface RepaymentBreakdown {
  principal: number;
  interest: number;
  platformFee: number;
  platformWallet: string | null;
  totalDue: number;
  alreadyPaid: number;
  remainingDue: number;
  aprBps: number;
  durationDays: number;
  aprPct: number;
}

function SuccessOverlay({ data, onClose }: { data: SuccessData; onClose: () => void }) {
  return (
    <div className="borrower-success-overlay" style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "1rem",
      animation: "fadeIn 0.2s ease",
    }}>
      <div className="borrower-success-card" style={{
        background: "#fff", borderRadius: "1.25rem",
        padding: "2.5rem 2rem", maxWidth: "420px", width: "100%",
        boxShadow: "0 25px 60px rgba(0,0,0,0.2)",
        textAlign: "center",
        animation: "slideUp 0.25s ease",
      }}>
        <div style={{ fontSize: "3.5rem", marginBottom: "0.75rem", lineHeight: 1 }}>✅</div>
        <h2 style={{ fontSize: "1.3rem", fontWeight: 800, color: "#111827", margin: "0 0 0.5rem" }}>
          On-chain Payment Successful!
        </h2>
        <p style={{ color: "#6b7280", fontSize: "0.9rem", margin: "0 0 0.25rem" }}>
          <strong style={{ color: "#22cf9d" }}>{data.amount.toFixed(2)} XLM</strong> has been sent and recorded.
        </p>
        
        {data.txHash && (
           <a
             href={`https://stellar.expert/explorer/testnet/tx/${data.txHash}`}
             target="_blank"
             rel="noreferrer"
             style={{ display: "inline-block", margin: "0.5rem 0 1.5rem", color: "#7e2fd0", fontSize: "0.85rem", fontWeight: 700 }}
           >
             View on Stellar ↗
           </a>
        )}

        <div className="borrower-success-actions" style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: "0.7rem 1.25rem",
              background: "linear-gradient(135deg,#7e2fd0,#5a1fad)",
              color: "#fff", border: "none", borderRadius: "0.6rem",
              fontSize: "0.9rem", fontWeight: 700, cursor: "pointer",
            }}
          >
            Done
          </button>
        </div>

        <p style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#9ca3af" }}>
          📋 Repayment recorded in TrustLend ledger. Your trust score has been updated.
        </p>
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes slideUp { from { transform:translateY(24px); opacity:0 } to { transform:translateY(0); opacity:1 } }
      `}</style>
    </div>
  );
}

const STEP_LABELS: Record<Step, string> = {
  idle:       "",
  preflight:  "Fetching details...",
  connecting: "Connecting Freighter...",
  building:   "Building TX...",
  signing:    "Waiting for signature...",
  submitting: "Submitting to network...",
  recording:  "Recording repayment...",
};

export function BorrowerRepayWidget({ loan, dueAmount: initialDue }: { loan: RepayLoan; dueAmount: number }) {
  const router = useRouter();
  const [step, setStep]               = useState<Step>("idle");
  const [customAmount, setCustomAmount] = useState("");
  const [error, setError]             = useState("");
  const [successData, setSuccessData] = useState<SuccessData | null>(null);
  const [repayments, setRepayments]   = useState<RepaymentRecord[]>([]);
  const [dueAmount, setDueAmount]     = useState(initialDue);
  const [showFeeBreakdown, setShowFeeBreakdown] = useState(false);
  const [breakdownData, setBreakdownData] = useState<RepaymentBreakdown | null>(null);

  const fetchRepayments = useCallback(async () => {
    try {
      const res = await fetch(`/api/loans/repayments?loanId=${loan.id}`);
      if (res.ok) {
        const json = await res.json();
        setRepayments(json.repayments ?? []);
      }
    } catch { /* non-fatal */ }
  }, [loan.id]);

  const fetchPreflight = useCallback(async () => {
    try {
      const res = await fetch(`/api/loans/repay/preflight?loanId=${loan.id}`);
      if (res.ok) {
        const json = await res.json();
        setBreakdownData(json.breakdown);
        setDueAmount(json.breakdown.remainingDue);
      }
    } catch { /* non-fatal */ }
  }, [loan.id]);

  useEffect(() => { 
    fetchRepayments(); 
    fetchPreflight();
  }, [fetchRepayments, fetchPreflight]);

  const handleRepayOnChain = async (amount: number) => {
    setError("");
    setStep("preflight");

    try {
      // 1. Fetch preflight to get lender address
      const prefRes = await fetch(`/api/loans/repay/preflight?loanId=${loan.id}`);
      const prefData = await prefRes.json();
      if (!prefRes.ok) throw new Error(prefData.error ?? "Failed to fetch repayment details");

      const lenderAddress = prefData.lenderAddress;
      const platformWallet = prefData.breakdown.platformWallet;
      
      if (!lenderAddress) throw new Error("Could not find lender wallet structure!");

      // 2. Freighter Connection
      setStep("connecting");
      const { isConnected, getAddress, signTransaction } = await import("@stellar/freighter-api");
      const connResult = await isConnected();
      if (!connResult.isConnected) throw new Error("Freighter not connected.");

      const addrResult = await getAddress();
      if (addrResult.error || !addrResult.address) throw new Error("Could not get your wallet from Freighter.");
      const borrowerAddress = addrResult.address;

      // 3. Build the Transaction
      setStep("building");
      const { TransactionBuilder, Networks, Operation, Asset, Memo, Account } = await import("@stellar/stellar-sdk");
      const horizonUrl = process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

      const accountRes = await fetch(`${horizonUrl}/accounts/${borrowerAddress}`);
      if (!accountRes.ok) throw new Error("Your account needs to be funded on Stellar testnet.");
      const accountData = await accountRes.json();
      const account = new Account(borrowerAddress, accountData.sequence);

      const builder = new TransactionBuilder(account, { fee: "10000", networkPassphrase: Networks.TESTNET });
      
      const totalDueGross = prefData.breakdown.totalDue;
      const platformFee = prefData.breakdown.platformFee;
      
      if (platformWallet && platformFee > 0 && totalDueGross > 0) {
        // Splitting the payment proportionally based on what they are paying right now
        const ratio = amount / totalDueGross;
        const platformCut = +(platformFee * ratio).toFixed(7);
        const lenderCut = +(amount - platformCut).toFixed(7);
        
        if (lenderCut > 0) {
          builder.addOperation(
            Operation.payment({
              destination: lenderAddress,
              asset: Asset.native(),
              amount: lenderCut.toFixed(7),
            })
          );
        }
        if (platformCut > 0) {
           builder.addOperation(
             Operation.payment({
               destination: platformWallet,
               asset: Asset.native(),
               amount: platformCut.toFixed(7),
             })
           );
        }
      } else {
        // Fallback: send directly to lender if no platform wallet configured
        builder.addOperation(
          Operation.payment({
            destination: lenderAddress,
            asset: Asset.native(),
            amount: amount.toFixed(7),
          })
        );
      }
      
      builder.addMemo(Memo.text(`TL-RPY:${loan.id.slice(0, 12)}`));
      builder.setTimeout(180);
      
      const tx = builder.build();
      const txXdr = tx.toXDR();

      // 4. Sign
      setStep("signing");
      const signResult = await signTransaction(txXdr, { networkPassphrase: Networks.TESTNET });
      if (signResult.error || !signResult.signedTxXdr) throw new Error(signResult.error?.message ?? "Transaction rejected");

      // 5. Submit
      setStep("submitting");
      const submitRes = await fetch(`${horizonUrl}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `tx=${encodeURIComponent(signResult.signedTxXdr)}`,
      });

      const submitData = await submitRes.json();
      if (!submitRes.ok || !submitData.hash) {
        throw new Error(`Stellar submission failed: ${submitData?.detail ?? "Unknown error"}`);
      }
      const txHash: string = submitData.hash;

      // 6. Record on TrustLend
      setStep("recording");
      const apiRes = await fetch("/api/loans/repay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: loan.id, amount, txHash, borrowerAddress }),
      });
      const apiJson = await apiRes.json();
      if (!apiRes.ok) throw new Error(apiJson.error ?? "Failed to record payment");

      setSuccessData({ amount, repaymentId: apiJson.repayment?.id ?? loan.id, txHash });
      setCustomAmount("");
      fetchRepayments();
      fetchPreflight();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setStep("idle");
    }
  };

  const handleClose = () => {
    setSuccessData(null);
    router.refresh();
  };

  const isBusy = step !== "idle";
  const total = breakdownData?.totalDue ?? loan.principal_amount; 
  const pct  = total > 0 ? Math.min(100, Math.round((loan.repaid_amount / total) * 100)) : 0;

  return (
    <>
      {successData && <SuccessOverlay data={successData} onClose={handleClose} />}

      <article className="workspace-card workspace-card--full">
        {/* Header */}
        <div className="borrower-repay-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.25rem" }}>
          <div>
            <h2 className="workspace-card-title" style={{ margin: 0 }}>On-Chain Repayment</h2>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "#6b7280" }}>
              Loan #{loan.id.slice(0, 8)} &bull; Due {loan.due_at ? new Date(loan.due_at).toLocaleDateString() : "N/A"}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <span style={{
              fontSize: "0.82rem", fontWeight: 700, display: "inline-block",
              color: dueAmount > 0 ? "#f5a623" : "#22cf9d",
              background: dueAmount > 0 ? "rgba(245,166,35,0.08)" : "rgba(34,207,157,0.08)",
              padding: "0.3rem 0.75rem", borderRadius: "9999px",
              border: `1px solid ${dueAmount > 0 ? "rgba(245,166,35,0.25)" : "rgba(34,207,157,0.25)"}`,
            }}>
              {dueAmount > 0 ? `${dueAmount.toFixed(2)} XLM remaining` : "Fully Paid ✅"}
            </span>
            {breakdownData && dueAmount > 0 && (
               <button 
                 onClick={() => setShowFeeBreakdown(!showFeeBreakdown)}
                 style={{ display: "block", background: "transparent", border: "none", color: "#7e2fd0", fontSize: "0.75rem", fontWeight: 600, marginTop: "0.4rem", marginLeft: "auto", cursor: "pointer", textDecoration: "underline" }}
               >
                 View Breakdown
               </button>
            )}
          </div>
        </div>
        
        {/* Fee Breakdown Panel */}
        {showFeeBreakdown && breakdownData && (
           <div style={{ background: "#f9fafb", borderRadius: "0.5rem", padding: "1rem", marginBottom: "1.5rem", border: "1px solid #e5e7eb", fontSize: "0.8rem", color: "#4b5563" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                 <span>Principal ({breakdownData.durationDays} days):</span>
                 <span style={{ fontWeight: 600 }}>{breakdownData.principal.toFixed(2)} XLM</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                 <span>Interest ({breakdownData.aprPct}% APR):</span>
                 <span style={{ fontWeight: 600, color: "#f5a623" }}>+{breakdownData.interest.toFixed(2)} XLM</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                 <span>Platform Fee (1%):</span>
                 <span style={{ fontWeight: 600, color: "#ef4444" }}>+{breakdownData.platformFee.toFixed(2)} XLM</span>
              </div>
              <div style={{ borderTop: "1px solid #e5e7eb", margin: "0.5rem 0", paddingTop: "0.5rem", display: "flex", justifyContent: "space-between", fontWeight: 700, color: "#111" }}>
                 <span>Total Required:</span>
                 <span>{breakdownData.totalDue.toFixed(2)} XLM</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", color: "#22cf9d" }}>
                 <span>Already Paid:</span>
                 <span>-{breakdownData.alreadyPaid.toFixed(2)} XLM</span>
              </div>
           </div>
        )}

        {/* Progress bar */}
        <div style={{ marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.4rem" }}>
            <span>Repaid: <strong style={{ color: "#22cf9d" }}>{loan.repaid_amount.toFixed(2)} XLM</strong></span>
            <span style={{ fontWeight: 700 }}>{pct}%</span>
          </div>
          <div style={{ height: "10px", borderRadius: "9999px", background: "#eef0f8", overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${pct}%`,
              background: "linear-gradient(90deg,#7e2fd0,#22cf9d)",
              borderRadius: "9999px", transition: "width 0.5s ease",
            }} />
          </div>
        </div>

        {dueAmount > 0 ? (
          <>
            {/* Quick pay buttons */}
            <div className="borrower-repay-actions" style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
              <button
                onClick={() => handleRepayOnChain(dueAmount)}
                disabled={isBusy}
                style={{
                  flex: 2, minWidth: "160px", padding: "0.75rem 1.25rem",
                  background: isBusy ? "#a78bfa" : "linear-gradient(135deg,#7e2fd0,#5a1fad)",
                  color: "#fff", border: "none", borderRadius: "0.6rem",
                  fontSize: "0.9rem", fontWeight: 800,
                  cursor: isBusy ? "not-allowed" : "pointer",
                  boxShadow: isBusy ? "none" : "0 4px 14px rgba(126,47,208,0.4)",
                  transition: "all 0.2s ease",
                  letterSpacing: "0.01em",
                }}
              >
                {isBusy ? STEP_LABELS[step] : `💳 Pay Full — ${dueAmount.toFixed(2)} XLM`}
              </button>
              <button
                onClick={() => handleRepayOnChain(Math.max(0.01, +(dueAmount * 0.25).toFixed(2)))}
                disabled={isBusy}
                style={{
                  flex: 1, minWidth: "110px", padding: "0.75rem 1rem",
                  background: "#fff", color: "#7e2fd0",
                  border: "2px solid rgba(126,47,208,0.35)",
                  borderRadius: "0.6rem", fontSize: "0.875rem", fontWeight: 700,
                  cursor: isBusy ? "not-allowed" : "pointer",
                  transition: "border-color 0.2s",
                }}
              >
                Pay 25%
              </button>
            </div>

            {/* Custom amount */}
            <div className="borrower-repay-custom-row" style={{ display: "flex", gap: "0.5rem", alignItems: "stretch" }}>
              <input
                type="number" step="0.01" min="0.01" max={dueAmount}
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                placeholder="Custom amount (XLM)"
                disabled={isBusy}
                style={{
                  flex: 1, padding: "0.7rem 0.9rem",
                  border: "2px solid #e5e7eb", borderRadius: "0.6rem",
                  fontSize: "0.875rem", outline: "none",
                  transition: "border-color 0.2s",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#7e2fd0")}
                onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
              />
              <button
                onClick={() => {
                  const n = parseFloat(customAmount);
                  if (!n || n <= 0 || n > dueAmount) {
                    setError(`Enter a value between 0.01 and ${dueAmount.toFixed(2)}`);
                    return;
                  }
                  setError("");
                  handleRepayOnChain(n);
                }}
                disabled={isBusy || !customAmount}
                style={{
                  padding: "0.7rem 1.5rem",
                  background: customAmount && !isBusy
                    ? "linear-gradient(135deg,#7e2fd0,#5a1fad)"
                    : "#e5e7eb",
                  color: customAmount && !isBusy ? "#fff" : "#9ca3af",
                  border: "none", borderRadius: "0.6rem",
                  fontSize: "0.875rem", fontWeight: 700,
                  cursor: isBusy || !customAmount ? "not-allowed" : "pointer",
                  transition: "all 0.2s ease",
                  whiteSpace: "nowrap",
                }}
              >
                Pay Custom
              </button>
            </div>

            {error && (
              <p style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "#ef4444", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.35rem" }}>
                ⚠️ {error}
              </p>
            )}
          </>
        ) : (
          <div style={{ textAlign: "center", padding: "1rem 0", color: "#22cf9d", fontWeight: 700, fontSize: "1rem" }}>
            🎉 Loan fully repaid! Your trust score has been updated.
          </div>
        )}

        {/* Repayment History */}
        {repayments.length > 0 && (
          <div style={{ marginTop: "1.5rem", paddingTop: "1.25rem", borderTop: "1px solid #f3f4f6" }}>
            <h3 style={{ fontSize: "0.82rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" }}>
              Payment History
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {repayments.map((r) => (
                <div key={r.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "0.6rem 0.85rem", borderRadius: "0.5rem",
                  background: "rgba(34,207,157,0.05)", border: "1px solid rgba(34,207,157,0.15)",
                }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                    <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#22cf9d" }}>
                      +{Number(r.amount).toFixed(2)} XLM repaid
                    </span>
                    <span style={{ fontSize: "0.72rem", color: "#9ca3af", fontFamily: "monospace" }}>
                      ID: {r.repayment_id.slice(0, 16)}…
                    </span>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "#9ca3af", whiteSpace: "nowrap" }}>
                    {new Date(r.created_at).toLocaleDateString()} {new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <style jsx>{`
          @media (max-width: 560px) {
            .borrower-success-overlay {
              align-items: flex-end;
              padding: 0.75rem;
            }

            .borrower-success-card {
              width: 100% !important;
              max-width: none !important;
              max-height: calc(100dvh - 1.5rem);
              overflow-y: auto;
              padding: 1.3rem 1rem !important;
              border-radius: 1rem !important;
            }

            .borrower-success-actions {
              flex-direction: column;
            }

            .borrower-success-actions > button {
              width: 100%;
            }

            .borrower-repay-header {
              flex-direction: column;
              gap: 0.75rem;
            }

            .borrower-repay-actions {
              flex-direction: column;
            }

            .borrower-repay-actions > button {
              width: 100%;
              min-width: 0 !important;
            }

            .borrower-repay-custom-row {
              flex-direction: column;
            }

            .borrower-repay-custom-row > input,
            .borrower-repay-custom-row > button {
              width: 100%;
            }
          }
        `}</style>
      </article>
    </>
  );
}
