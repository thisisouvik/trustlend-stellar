"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PoolOption {
  id: string;
  name: string;
  apr_bps: number;
  available_liquidity: number;
}

interface DepositFormProps {
  pools: PoolOption[];
  onSubmit: (poolId: string, amount: number) => Promise<void>;
}

export function DepositForm({ pools, onSubmit }: DepositFormProps) {
  const [poolId, setPoolId] = useState(pools[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedPool = pools.find((p) => p.id === poolId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const amountNum = parseFloat(amount);
      if (!amountNum || amountNum <= 0) {
        setError("Amount must be greater than 0");
        return;
      }
      if (!poolId) {
        setError("Please select a pool");
        return;
      }
      await onSubmit(poolId, amountNum);
      setAmount("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="workspace-form">
      <div>
        <label className="workspace-label">Select Pool</label>
        <select
          value={poolId}
          onChange={(e) => setPoolId(e.target.value)}
          className="workspace-input"
          disabled={loading}
          suppressHydrationWarning
        >
          <option value="">Choose a pool...</option>
          {pools.map((pool) => (
            <option key={pool.id} value={pool.id}>
              {pool.name} ({(Number(pool.apr_bps ?? 0) / 100).toFixed(2)}% APR)
            </option>
          ))}
        </select>
        {selectedPool && (
          <p className="workspace-hint">Available: {(Number(selectedPool.available_liquidity ?? 0)).toFixed(2)} XLM</p>
        )}
      </div>

      <div>
        <label className="workspace-label">Deposit Amount (XLM)</label>
        <input
          type="number"
          step="0.01"
          min="1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Enter amount"
          className="workspace-input"
          disabled={loading}
          suppressHydrationWarning
        />
      </div>

      {error && <p className="workspace-error">{error}</p>}

      <button
        type="submit"
        disabled={loading || !amount || !poolId}
        className="workspace-button workspace-button--primary"
        style={{ width: "100%" }}
        suppressHydrationWarning
      >
        {loading ? "Processing..." : "Deposit Now"}
      </button>
    </form>
  );
}

interface WithdrawFormProps {
  positions: PositionOption[];
  onSubmit: (positionId: string, amount: number) => Promise<void>;
}

export function WithdrawForm({ positions, onSubmit }: WithdrawFormProps) {
  const [positionId, setPositionId] = useState(positions[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedPosition = positions.find((p) => p.id === positionId);
  const availableWithdraw = selectedPosition?.principal_amount ?? 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const amountNum = parseFloat(amount);
      if (!amountNum || amountNum <= 0 || amountNum > availableWithdraw) {
        setError(`Amount must be between 1 and ${availableWithdraw.toFixed(2)}`);
        return;
      }
      if (!positionId) {
        setError("Please select a position");
        return;
      }
      await onSubmit(positionId, amountNum);
      setAmount("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdrawal failed");
    } finally {
      setLoading(false);
    }
  };

  const handleMax = () => {
    if (availableWithdraw > 0) {
      setAmount(availableWithdraw.toFixed(2));
    }
  };

  return (
    <form onSubmit={handleSubmit} className="workspace-form">
      <div>
        <label className="workspace-label">Select Position</label>
        <select
          value={positionId}
          onChange={(e) => setPositionId(e.target.value)}
          className="workspace-input"
          disabled={loading || positions.length === 0}
          suppressHydrationWarning
        >
          <option value="">Choose position...</option>
          {positions.map((pos) => (
            <option key={pos.id} value={pos.id}>
              Position {String(pos.id).slice(0, 8)} - {Number(pos.principal_amount ?? 0).toFixed(2)} XLM
            </option>
          ))}
        </select>
        {selectedPosition && (
          <p className="workspace-hint">Available: {availableWithdraw.toFixed(2)} XLM</p>
        )}
      </div>

      <div>
        <label className="workspace-label">Withdrawal Amount (XLM)</label>
        <div style={{ display: "flex", gap: "0.7rem", alignItems: "center" }}>
          <input
            type="number"
            step="0.01"
            min="1"
            max={availableWithdraw}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter amount"
            className="workspace-input"
            disabled={loading}
            style={{ flex: 1 }}
            suppressHydrationWarning
          />
          <button
            type="button"
            onClick={handleMax}
            disabled={loading || availableWithdraw <= 0}
            className="workspace-button workspace-button--secondary"
            style={{ minWidth: "80px" }}
            suppressHydrationWarning
          >
            Max
          </button>
        </div>
      </div>

      {error && <p className="workspace-error">{error}</p>}

      <button
        type="submit"
        disabled={loading || !amount || !positionId}
        className="workspace-button workspace-button--primary"
        style={{ width: "100%" }}
        suppressHydrationWarning
      >
        {loading ? "Processing..." : "Withdraw"}
      </button>
    </form>
  );
}

interface PositionOption {
  id: string;
  principal_amount: number;
}

interface LenderFormsProps {
  pools: PoolOption[];
  positions: PositionOption[];
}

export function LenderForms({ pools, positions }: LenderFormsProps) {
  const router = useRouter();

  const handleDeposit = async (poolId: string, amount: number) => {
    try {
      const response = await fetch("/api/pools/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_id: poolId, amount }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to deposit");
      }

      router.refresh();
      alert("Deposit successful!");
    } catch (error) {
      throw error;
    }
  };

  const handleWithdraw = async (positionId: string, amount: number) => {
    try {
      const response = await fetch("/api/pools/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId, amount }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to withdraw");
      }

      router.refresh();
      alert("Withdrawal successful!");
    } catch (error) {
      throw error;
    }
  };

  return (
    <>
      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">Manage Your Deposits</h2>
        <div className="workspace-grid workspace-grid--two">
          <div>
            <h3 className="workspace-subheading">Deposit to Pool</h3>
            <DepositForm pools={pools} onSubmit={handleDeposit} />
          </div>
          <div>
            <h3 className="workspace-subheading">Withdraw from Position</h3>
            <WithdrawForm positions={positions} onSubmit={handleWithdraw} />
          </div>
        </div>
      </article>
    </>
  );
}
