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
          onWheel={(e) => (e.target as HTMLInputElement).blur()}
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
            onWheel={(e) => (e.target as HTMLInputElement).blur()}
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
  /** Platform Stellar wallet address that receives the lender's deposit */
  platformAddress?: string;
}

export function LenderForms({ pools, positions, platformAddress }: LenderFormsProps) {
  const router = useRouter();
  const [successTx, setSuccessTx] = useState<{poolName: string; amount: number; hash: string} | null>(null);

  const PLATFORM_WALLET =
    platformAddress ??
    process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS ??
    "";

  // ── Real Stellar deposit via Freighter ──────────────────────────────────────
  const handleDeposit = async (poolId: string, amount: number) => {
    setSuccessTx(null);
    if (!PLATFORM_WALLET) {
      throw new Error(
        "Platform wallet not configured. Set NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS."
      );
    }

    // Step 1: Get lender wallet address from Freighter
    const { isConnected, getAddress, signTransaction } = await import(
      "@stellar/freighter-api"
    );
    const connected = await isConnected();
    if (!connected.isConnected) {
      throw new Error("Freighter is not connected. Open Freighter and try again.");
    }

    const addressResult = await getAddress();
    if (addressResult.error || !addressResult.address) {
      throw new Error("Could not get wallet address from Freighter.");
    }
    const lenderAddress = addressResult.address;

    // Step 2: Build the Stellar payment transaction
    const {
      TransactionBuilder,
      Networks,
      Operation,
      Asset,
      Memo,
    } = await import("@stellar/stellar-sdk");

    const horizonUrl =
      process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
      "https://horizon-testnet.stellar.org";

    // Fetch lender account sequence number from Horizon
    const accountRes = await fetch(`${horizonUrl}/accounts/${lenderAddress}`);
    if (!accountRes.ok) {
      throw new Error(
        `Lender account not found on Stellar. Fund it at https://friendbot.stellar.org?addr=${lenderAddress}`
      );
    }
    const accountData = await accountRes.json();

    const { Account } = await import("@stellar/stellar-sdk");
    const account = new Account(lenderAddress, accountData.sequence);

    const tx = new TransactionBuilder(account, {
      fee: "1000000", // 0.1 XLM max fee
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: PLATFORM_WALLET,
          asset: Asset.native(),
          amount: amount.toFixed(7),
        })
      )
      .addMemo(Memo.text(`TL-DEPOSIT:${poolId.slice(0, 12)}`))
      .setTimeout(120)
      .build();

    const txXdr = tx.toXDR();

    // Step 3: Sign with Freighter
    const signResult = await signTransaction(txXdr, {
      networkPassphrase: Networks.TESTNET,
    });

    if (signResult.error || !signResult.signedTxXdr) {
      throw new Error(signResult.error?.message ?? "User rejected the transaction in Freighter.");
    }

    // Step 4: Submit to Stellar network
    const submitRes = await fetch(`${horizonUrl}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `tx=${encodeURIComponent(signResult.signedTxXdr)}`,
    });

    const submitData = await submitRes.json();
    if (!submitRes.ok || !submitData.hash) {
      const detail =
        submitData?.extras?.result_codes?.transaction ??
        submitData?.detail ??
        JSON.stringify(submitData);
      throw new Error(`Stellar submission failed: ${detail}`);
    }

    const txHash: string = submitData.hash;

    // Step 5: Record confirmed deposit on TrustLend backend
    const apiRes = await fetch("/api/pools/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolId, amount, txHash, lenderAddress }),
    });

    if (!apiRes.ok) {
      const apiErr = await apiRes.json();
      throw new Error(apiErr.error ?? "Backend recording failed");
    }

    const depositedPool = pools.find(p => p.id === poolId);
    setSuccessTx({ poolName: depositedPool?.name ?? "Pool", amount, hash: txHash });

    router.refresh();
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
      alert("Withdrawal request submitted!");
    } catch (error) {
      throw error;
    }
  };

  return (
    <>
      <article className="workspace-card workspace-card--full" style={{ position: "relative" }}>
        
        {successTx && (
          <div style={{
            position: "absolute", top: "-1.5rem", left: "50%", transform: "translateX(-50%)", zIndex: 10,
            background: "linear-gradient(135deg, rgba(34,207,157,0.1), rgba(34,207,157,0.2))",
            border: "1px solid rgba(34,207,157,0.4)",
            borderRadius: "0.8rem", padding: "1rem 1.5rem",
            boxShadow: "0 8px 32px rgba(34,207,157,0.15)",
            backdropFilter: "blur(12px)", minWidth: "300px", textAlign: "center",
            animation: "slideDown 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)"
          }}>
             <h4 style={{ color: "#22cf9d", margin: "0 0 0.5rem 0", fontSize: "1rem" }}>✅ Deposit Successful!</h4>
             <p style={{ margin: "0 0 0.75rem 0", fontSize: "0.85rem", opacity: 0.9 }}>
                You successfully deployed <strong>{successTx.amount} XLM</strong> into the <strong>{successTx.poolName}</strong>.
             </p>
             <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
               <a 
                 href={`https://stellar.expert/explorer/testnet/tx/${successTx.hash}`} 
                 target="_blank" rel="noopener noreferrer"
                 className="workspace-nav-link"
                 style={{ background: "rgba(34,207,157,0.15)", padding: "0.4rem 0.8rem", borderRadius: "9999px", fontSize: "0.8rem", fontWeight: 600, color: "#22cf9d" }}
               >
                 Verify on Stellar ↗
               </a>
               <button 
                 onClick={() => setSuccessTx(null)}
                 style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "white", padding: "0.4rem 0.8rem", borderRadius: "9999px", fontSize: "0.8rem", cursor: "pointer" }}
               >
                 Dismiss
               </button>
             </div>
          </div>
        )}

        <h2 className="workspace-card-title">Manage Your Deposits</h2>
        <div className="workspace-grid workspace-grid--two">
          <div>
            <h3 className="workspace-subheading">Deposit to Pool</h3>
            <p className="workspace-card-copy" style={{ fontSize: "0.82rem", opacity: 0.7, marginBottom: "0.75rem" }}>
              Your XLM will be sent directly to TrustLend&apos;s Stellar escrow via Freighter.
              A real on-chain transaction is required — no mock deposits.
            </p>
            <DepositForm pools={pools} onSubmit={handleDeposit} />
          </div>
          <div>
            <h3 className="workspace-subheading">Withdraw from Position</h3>
            <WithdrawForm positions={positions} onSubmit={handleWithdraw} />
          </div>
        </div>
      </article>
      <style dangerouslySetInnerHTML={{__html:`
        @keyframes slideDown {
          from { opacity: 0; transform: translate(-50%, -20px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
      `}}/>
    </>
  );
}
