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
  due_at: string | null;
  principal_amount: number;
  repaid_amount: number;
}

interface BorrowerFormsProps {
  canApplyLoan: boolean;
  maxLoanAmount: number;
  selectedRepaymentLoan: BorrowerLoan | null;
  dueAmount: number;
}

export function BorrowerForms({
  canApplyLoan,
  maxLoanAmount,
  selectedRepaymentLoan,
  dueAmount,
}: BorrowerFormsProps) {
  const router = useRouter();
  const [monitoringDays] = useState(0);
  const [_sorobanLoading, setSorobanLoading] = useState(false);

  const handleLoanApplication = async (amount: number, duration: number) => {
    setSorobanLoading(true);
    try {
      // 1. Supabase application (Database record)
      const response = await fetch("/api/loans/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, duration_days: duration, pool_id: "default" }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to apply for loan");
      }

      const _loan = await response.json();

      // 2. Soroban application (On-chain record)
      // Check if wallet is connected (this is a client component)
      const walletAddress = window.localStorage.getItem("wallet_address") || "";
      if (walletAddress) {
        try {
          console.log("[TrustLend] Initiating Soroban loan request...");
          
          // Fetch current reputation-based limits from contract
          const [onChainRate, onChainMax] = await Promise.all([
            ReputationContract.getInterestRate(walletAddress, walletAddress),
            ReputationContract.getMaxLoan(walletAddress, walletAddress)
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
          console.error("[TrustLend] Soroban sync failed:", sorobanErr);
          // We don't block the UI if Soroban fails, but we log it.
          // In a real app, we'd show a "Retry Sync" button.
        }
      }

      router.refresh();
      alert("Loan application submitted successfully!");
    } catch (error) {
      throw error;
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
        body: JSON.stringify({ loan_id: selectedRepaymentLoan.id, amount }),
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

      <article className="workspace-card">
        <h2 className="workspace-card-title">Make a Repayment</h2>
        {!selectedRepaymentLoan ? (
          <p className="workspace-card-copy">No active loan available for repayment.</p>
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
