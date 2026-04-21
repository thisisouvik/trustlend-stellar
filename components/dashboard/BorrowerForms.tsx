"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/utils/formatting";
import {
  LendingContract,
  ReputationContract,
  xlmToStroops,
} from "@/lib/contracts";

interface LoanApplicationFormProps {
  maxAmount: number;
  onSubmit: (amount: number, duration: number) => Promise<void>;
}
export function LoanApplicationForm({ maxAmount, onSubmit }: LoanApplicationFormProps) {
  const [amount, setAmount] = useState("");
  const [duration, setDuration] = useState("60");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const amountNum = parseFloat(amount);
      if (!amountNum || amountNum <= 0 || amountNum > maxAmount) {
        setError(`Amount must be between 1 and ${maxAmount}`);
        return;
      }
      await onSubmit(amountNum, parseInt(duration));
      setAmount("");
      setDuration("60");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit application");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="workspace-form">
      <div>
        <label className="workspace-label">Loan Amount (XLM)</label>
        <input
          type="number"
          step="0.01"
          min="1"
          max={maxAmount}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onWheel={(e) => (e.target as HTMLInputElement).blur()}
          placeholder="Enter amount"
          className="workspace-input"
          disabled={loading}
        />
        <p className="workspace-hint">Max: {maxAmount.toFixed(2)} XLM</p>
      </div>

      <div>
        <label className="workspace-label">Duration</label>
        <select
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="workspace-input"
          disabled={loading}
        >
          <option value="30">30 days (15% interest)</option>
          <option value="60">60 days (12% interest)</option>
          <option value="90">90 days (10% interest)</option>
        </select>
      </div>

      {error && <p className="workspace-error">{error}</p>}

      <button
        type="submit"
        disabled={loading || !amount}
        className="workspace-button workspace-button--primary"
        style={{ width: "100%", marginTop: "0.5rem" }}
      >
        {loading ? "Submitting..." : "Submit Application"}
      </button>
    </form>
  );
}

interface RepaymentFormProps {
  loanAmount: number;
  repaidAmount: number;
  onSubmit: (amount: number) => Promise<void>;
}

export function RepaymentForm({ loanAmount, repaidAmount, onSubmit }: RepaymentFormProps) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const dueAmount = loanAmount - repaidAmount;
  const maxRepayment = dueAmount;

  const handlePayMinimum = async () => {
    const minPayment = Math.max(100, dueAmount * 0.1);
    await submitPayment(Math.min(minPayment, dueAmount));
  };

  const handlePayFull = async () => {
    await submitPayment(dueAmount);
  };

  const submitPayment = async (payAmount: number) => {
    setError("");
    setLoading(true);

    try {
      await onSubmit(payAmount);
      setAmount("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum <= 0 || amountNum > maxRepayment) {
      setError(`Payment must be between 1 and ${maxRepayment.toFixed(2)}`);
      return;
    }
    await submitPayment(amountNum);
  };

  return (
    <form onSubmit={handleSubmit} className="workspace-form">
      <div className="workspace-form-group">
        <p className="workspace-form-stat">
          <span>Amount Owed:</span>
          <strong>{dueAmount.toFixed(2)} XLM</strong>
        </p>
      </div>

      <div>
        <label className="workspace-label">Custom Payment Amount</label>
        <input
          type="number"
          step="0.01"
          min="1"
          max={maxRepayment}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onWheel={(e) => (e.target as HTMLInputElement).blur()}
          placeholder="Enter payment amount"
          className="workspace-input"
          disabled={loading}
        />
      </div>

      {error && <p className="workspace-error">{error}</p>}

      <div className="workspace-form-actions" style={{ flexDirection: "column", gap: "0.6rem", marginTop: "0.6rem" }}>
        <button
          type="button"
          onClick={handlePayFull}
          disabled={loading}
          className="workspace-button workspace-button--primary"
          style={{ width: "100%" }}
        >
          {loading ? "Processing..." : "Pay Full Amount"}
        </button>
        <div style={{ display: "flex", gap: "0.6rem" }}>
          <button
            type="button"
            onClick={handlePayMinimum}
            disabled={loading}
            className="workspace-button workspace-button--secondary"
            style={{ flex: 1 }}
          >
            {loading ? "Processing..." : "Pay Minimum"}
          </button>
          <button
            type="submit"
            disabled={loading || !amount}
            className="workspace-button workspace-button--primary"
            style={{ flex: 1 }}
          >
            {loading ? "Processing..." : "Pay Custom"}
          </button>
        </div>
      </div>
    </form>
  );
}

interface BorrowerLoan {
  id: string;
  status: string;
  due_at: string | null;
  principal_amount: number;
  repaid_amount: number;
  apr_bps?: number;
  duration_days?: number;
  created_at?: string | null;
}

interface BorrowerFormsProps {
  canApplyLoan: boolean;
  maxLoanAmount: number;
  loans: BorrowerLoan[];
  selectedRepaymentLoan: BorrowerLoan | null;
  dueAmount: number;
}

export function BorrowerForms({
  canApplyLoan,
  maxLoanAmount,
  loans,
  selectedRepaymentLoan,
  dueAmount,
}: BorrowerFormsProps) {
  const router = useRouter();
  const [monitoringDays] = useState(0);
  const [, setSorobanLoading] = useState(false);
  const pendingLoans = loans.filter((loan) => String(loan.status) === "requested");

  const handleLoanApplication = async (amount: number, duration: number) => {
    setSorobanLoading(true);
    try {
      const response = await fetch("/api/loans/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, duration_days: duration, pool_id: "default" }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to apply for loan");
      }

      await response.json();

      const walletAddress = window.localStorage.getItem("wallet_address") || "";
      if (walletAddress) {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Soroban RPC timeout")), 5000)
        );
        try {
          console.log("[TrustLend] Initiating Soroban loan request...");

          const [onChainRate, onChainMax] = await Promise.race([
            Promise.all([
              ReputationContract.getInterestRate(walletAddress, walletAddress),
              ReputationContract.getMaxLoan(walletAddress, walletAddress),
            ]),
            timeout,
          ]);

          const amountStroops = xlmToStroops(amount);

          await LendingContract.createLoanRequest(
            walletAddress,
            amountStroops,
            duration,
            onChainRate,
            onChainMax
          );

          console.log("[TrustLend] Soroban loan request recorded.");
        } catch (sorobanErr) {
          console.warn("[TrustLend] Soroban sync skipped:", (sorobanErr as Error).message);
        }
      }

      router.refresh();
      alert("Loan application submitted successfully!");
    } finally {
      setSorobanLoading(false);
    }
  };

  const handleRepayment = async (amount: number) => {
    if (!selectedRepaymentLoan?.id) {
      throw new Error("No loan selected for repayment");
    }

    try {
      const response = await fetch("/api/loans/repay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: selectedRepaymentLoan.id, amount }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Payment failed");
      }

      router.refresh();
      alert("Payment successful!");
    } catch (error) {
      throw error;
    }
  };

  return (
    <>
      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">Apply for a New Loan</h2>
        {!canApplyLoan ? (
          <p className="workspace-card-copy">
            Verification is still in progress. Days remaining: {Math.max(0, 30 - monitoringDays)}.
          </p>
        ) : (
          <LoanApplicationForm maxAmount={maxLoanAmount} onSubmit={handleLoanApplication} />
        )}
      </article>

      {pendingLoans.length > 0 && (
        <article className="workspace-card workspace-card--full" style={{ borderColor: "rgba(245,166,35,0.25)", background: "rgba(245,166,35,0.04)" }}>
          <h2 className="workspace-card-title">Pending Loan Request{pendingLoans.length > 1 ? "s" : ""}</h2>
          <p className="workspace-card-copy" style={{ marginTop: "0.35rem" }}>
            Your submitted request{pendingLoans.length > 1 ? "s are" : " is"} waiting for lender funding.
          </p>
          <div style={{ display: "grid", gap: "0.75rem", marginTop: "1rem" }}>
            {pendingLoans.slice(0, 3).map((loan) => (
              <div
                key={String(loan.id)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  alignItems: "center",
                  padding: "0.85rem 1rem",
                  borderRadius: "0.7rem",
                  background: "rgba(255,255,255,0.75)",
                  border: "1px solid rgba(245,166,35,0.18)",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <p style={{ fontWeight: 700, margin: 0 }}>Loan #{String(loan.id).slice(0, 8)}</p>
                  <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0.15rem 0 0" }}>
                    Requested {loan.created_at ? new Date(String(loan.created_at)).toLocaleDateString() : "recently"}
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ margin: 0, fontWeight: 800, color: "#7e2fd0" }}>{formatCurrency(Number(loan.principal_amount ?? 0))}</p>
                  <p style={{ fontSize: "0.75rem", color: "#f59e0b", fontWeight: 700, margin: "0.15rem 0 0" }}>REQUESTED</p>
                </div>
              </div>
            ))}
          </div>
        </article>
      )}

      <article className="workspace-card">
        <h2 className="workspace-card-title">Make a Repayment</h2>
        {!selectedRepaymentLoan ? (
          <>
            <p className="workspace-card-copy">No active loan available for repayment.</p>
            {pendingLoans.length > 0 && (
              <p className="workspace-card-copy" style={{ marginTop: "0.5rem", color: "#f59e0b" }}>
                You still have a pending loan request. Repayment will appear after a lender funds it.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="workspace-card-copy">Loan #{String(selectedRepaymentLoan.id).slice(0, 8)}</p>
            <p className="workspace-card-copy">Still owe: {formatCurrency(dueAmount)}</p>
            <p className="workspace-card-copy">
              Next due: {selectedRepaymentLoan.due_at ? new Date(String(selectedRepaymentLoan.due_at)).toLocaleDateString() : "-"}
            </p>
            <RepaymentForm
              loanAmount={Number(selectedRepaymentLoan.principal_amount ?? 0)}
              repaidAmount={Number(selectedRepaymentLoan.repaid_amount ?? 0)}
              onSubmit={handleRepayment}
            />
          </>
        )}
      </article>
    </>
  );
}
