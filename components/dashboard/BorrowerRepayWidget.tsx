"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface RepayLoan {
  id: string;
  principal_amount: number;
  repaid_amount: number;
  due_at: string | null;
}

export function BorrowerRepayWidget({ loan, dueAmount }: { loan: RepayLoan; dueAmount: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [customAmount, setCustomAmount] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleRepay = async (amount: number) => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await fetch("/api/loans/repay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: loan.id, amount }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Payment failed");
      setSuccess(`✅ Payment of ${amount.toFixed(2)} XLM recorded!`);
      setCustomAmount("");
      setTimeout(() => {
        router.refresh();
        setSuccess("");
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setLoading(false);
    }
  };

  const pct = Math.min(100, Math.round(((loan.principal_amount - dueAmount) / loan.principal_amount) * 100));

  return (
    <article className="workspace-card workspace-card--full">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.25rem" }}>
        <div>
          <h2 className="workspace-card-title" style={{ margin: 0 }}>Quick Repayment</h2>
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "#6b7280" }}>
            Loan #{loan.id.slice(0, 8)} &bull; Due {loan.due_at ? new Date(loan.due_at).toLocaleDateString() : "N/A"}
          </p>
        </div>
        <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#f5a623" }}>
          {dueAmount.toFixed(2)} XLM remaining
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.35rem" }}>
          <span>Repaid: {(loan.principal_amount - dueAmount).toFixed(2)} XLM</span>
          <span>{pct}%</span>
        </div>
        <div style={{ height: "8px", borderRadius: "9999px", background: "#eef0f8", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#7e2fd0,#22cf9d)", borderRadius: "9999px", transition: "width 0.4s ease" }} />
        </div>
      </div>

      {/* Quick buttons */}
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <button
          onClick={() => handleRepay(dueAmount)}
          disabled={loading}
          style={{ flex: 1, minWidth: "140px", padding: "0.65rem 1rem", background: "linear-gradient(135deg,#7e2fd0,#5a1fad)", color: "#fff", border: "none", borderRadius: "0.5rem", fontSize: "0.875rem", fontWeight: 700, cursor: loading ? "not-allowed" : "pointer" }}
        >
          {loading ? "Processing…" : `Pay Full (${dueAmount.toFixed(2)} XLM)`}
        </button>
        <button
          onClick={() => handleRepay(Math.max(1, dueAmount * 0.25))}
          disabled={loading}
          style={{ flex: 1, minWidth: "120px", padding: "0.65rem 1rem", background: "#fff", color: "#7e2fd0", border: "1px solid rgba(126,47,208,0.3)", borderRadius: "0.5rem", fontSize: "0.875rem", fontWeight: 700, cursor: loading ? "not-allowed" : "pointer" }}
        >
          Pay 25%
        </button>
      </div>

      {/* Custom amount */}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="number"
          step="0.01"
          min="0.01"
          max={dueAmount}
          value={customAmount}
          onChange={(e) => setCustomAmount(e.target.value)}
          placeholder="Custom amount (XLM)"
          disabled={loading}
          style={{ flex: 1, padding: "0.6rem 0.75rem", border: "1px solid #e5e7eb", borderRadius: "0.5rem", fontSize: "0.875rem", outline: "none" }}
        />
        <button
          onClick={() => {
            const n = parseFloat(customAmount);
            if (!n || n <= 0 || n > dueAmount) { setError(`Enter a value between 0.01 and ${dueAmount.toFixed(2)}`); return; }
            handleRepay(n);
          }}
          disabled={loading || !customAmount}
          style={{ padding: "0.6rem 1.25rem", background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", borderRadius: "0.5rem", fontSize: "0.875rem", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer" }}
        >
          Pay
        </button>
      </div>

      {error   && <p style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "#ef4444", fontWeight: 600 }}>{error}</p>}
      {success && <p style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "#22cf9d", fontWeight: 700 }}>{success}</p>}
    </article>
  );
}
