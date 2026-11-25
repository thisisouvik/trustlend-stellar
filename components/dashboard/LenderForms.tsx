"use client";
import { PAYMENT_MEMO } from "@/lib/stellar/verify-payment";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getConnectedWallet,
  getStoredWalletProvider,
  signTransactionWithWallet,
} from "@/lib/stellar/wallet";
import {
  getNetworkPassphrase,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet-providers";
import { formatCurrency } from "@/lib/utils/formatting";
import {
  discoverSep31Anchor,
  authenticateSep31,
  registerSep12Customer,
  createSep31Transaction,
} from "@/lib/stellar/sep31";

interface PoolOption {
  id: string;
  name: string;
  apr_bps: number;
  available_liquidity: number;
}

interface DepositFormProps {
  pools: PoolOption[];
  walletBalance: number;
  onSubmit: (poolId: string, amount: number) => Promise<void>;
}

export function DepositForm({
  pools,
  walletBalance,
  onSubmit,
}: DepositFormProps) {
  const [poolId, setPoolId] = useState(pools[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedPool = pools.find((p) => p.id === poolId);
  const amountNum = parseFloat(amount) || 0;
  const balanceAfter = Math.max(0, walletBalance - amountNum);
  const showProjection = amountNum > 0 && walletBalance > 0;
  const exceedsBalance = amountNum > walletBalance && walletBalance > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const parsed = parseFloat(amount);
      if (!parsed || parsed <= 0) {
        setError("Amount must be greater than 0");
        return;
      }
      if (!poolId) {
        setError("Please select a pool");
        return;
      }
      await onSubmit(poolId, parsed);
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
          <p className="workspace-hint">
            Pool liquidity:{" "}
            {formatCurrency(Number(selectedPool.available_liquidity ?? 0))}
          </p>
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
          style={
            exceedsBalance
              ? { borderColor: "color-mix(in srgb, var(--danger) 60%, transparent)" }
              : undefined
          }
          suppressHydrationWarning
        />
        {exceedsBalance && (
          <p
            style={{
              fontSize: "0.78rem",
              color: "var(--danger)",
              marginTop: "0.3rem",
            }}
          >
            ⚠️ Amount exceeds your wallet balance of {formatCurrency(walletBalance)}
          </p>
        )}
      </div>

      {/* Before / After balance projection */}
      {showProjection && (
        <div
          style={{
            background: "color-mix(in srgb, var(--accent) 6%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
            borderRadius: "0.65rem",
            padding: "0.85rem 1rem",
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.82rem",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <p
              style={{
                opacity: 0.55,
                marginBottom: "0.2rem",
                fontSize: "0.73rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Wallet Balance Before
            </p>
            <p style={{ fontWeight: 700, fontSize: "1rem" }}>
              {formatCurrency(walletBalance)}
            </p>
          </div>
          <span
            style={{ color: "var(--accent)", fontWeight: 700, fontSize: "1.1rem" }}
          >
            →
          </span>
          <div style={{ textAlign: "center" }}>
            <p
              style={{
                opacity: 0.55,
                marginBottom: "0.2rem",
                fontSize: "0.73rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Wallet Balance After
            </p>
            <p
              style={{
                fontWeight: 700,
                fontSize: "1rem",
                color: exceedsBalance ? "var(--danger)" : "var(--accent)",
              }}
            >
              {formatCurrency(balanceAfter)}
            </p>
          </div>
        </div>
      )}

      {error && <p className="workspace-error">{error}</p>}

      <button
        type="submit"
        disabled={loading || !amount || !poolId || exceedsBalance}
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
        setError(
          `Amount must be between 1 and ${formatCurrency(availableWithdraw)}`,
        );
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
              Position {String(pos.id).slice(0, 8)} -{" "}
              {formatCurrency(Number(pos.principal_amount ?? 0))}
            </option>
          ))}
        </select>
        {selectedPosition && (
          <p className="workspace-hint">
            Available: {formatCurrency(availableWithdraw)}
          </p>
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
  walletBalance?: number;
  /** Platform Stellar wallet address that receives the lender's deposit */
  platformAddress?: string;
  isKycVerified?: boolean;
}

interface Sep31DepositFormProps {
  pools: PoolOption[];
  isKycVerified: boolean;
  onSubmit: (params: {
    poolId: string;
    amount: string;
    currency: string;
    firstName: string;
    lastName: string;
    email: string;
    bankName: string;
    bankAccount: string;
    routingNumber: string;
  }) => Promise<void>;
}

export function Sep31DepositForm({ pools, isKycVerified, onSubmit }: Sep31DepositFormProps) {
  const router = useRouter();
  const [poolId, setPoolId] = useState(pools[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  if (!isKycVerified) {
    return (
      <div
        style={{
          background: "color-mix(in srgb, var(--danger) 6%, transparent)",
          border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
          borderRadius: "0.8rem",
          padding: "1.25rem",
          marginTop: "0.5rem",
        }}
      >
        <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.9, lineHeight: 1.5 }}>
          ⚠️ <strong>Verification Required:</strong> Fiat-to-crypto deposits are only available to identity-verified institutional lenders.
        </p>
        <button
          type="button"
          onClick={() => router.push("/dashboard/lender/profile")}
          style={{ marginTop: "0.75rem" }}
          className="workspace-button workspace-button--secondary"
        >
          Go to Profile Settings
        </button>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (!poolId) throw new Error("Please select a pool");
      if (!amount || parseFloat(amount) <= 0) throw new Error("Please enter a valid amount");
      if (!firstName.trim() || !lastName.trim()) throw new Error("Please enter sender full name");
      if (!email.trim() || !email.includes("@")) throw new Error("Please enter a valid email address");
      if (!bankName.trim()) throw new Error("Please enter bank name");
      if (!bankAccount.trim()) throw new Error("Please enter bank account number");
      if (!routingNumber.trim()) throw new Error("Please enter routing number");

      await onSubmit({
        poolId,
        amount,
        currency: "USD",
        firstName,
        lastName,
        email,
        bankName,
        bankAccount,
        routingNumber,
      });

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fiat deposit initiation failed");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div
        style={{
          background: "color-mix(in srgb, var(--accent) 6%, transparent)",
          border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
          borderRadius: "0.8rem",
          padding: "1.25rem",
          marginTop: "0.5rem",
          textAlign: "center",
        }}
      >
        <span style={{ fontSize: "1.5rem" }}>💵</span>
        <h4 style={{ color: "var(--accent)", margin: "0.5rem 0 0.25rem 0", fontSize: "0.95rem" }}>Transaction Created</h4>
        <p style={{ margin: 0, fontSize: "0.82rem", opacity: 0.8 }}>
          Follow the popup or instruction card details to wire your funds.
        </p>
      </div>
    );
  }

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
      </div>

      <div>
        <label className="workspace-label">Deposit Amount (USD)</label>
        <input
          type="number"
          step="0.01"
          min="1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Enter amount in USD"
          className="workspace-input"
          disabled={loading}
          required
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <div>
          <label className="workspace-label">First Name</label>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="John"
            className="workspace-input"
            disabled={loading}
            required
          />
        </div>
        <div>
          <label className="workspace-label">Last Name</label>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Doe"
            className="workspace-input"
            disabled={loading}
            required
          />
        </div>
      </div>

      <div>
        <label className="workspace-label">Sender Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="john.doe@example.com"
          className="workspace-input"
          disabled={loading}
          required
        />
      </div>

      <div>
        <label className="workspace-label">Bank Name</label>
        <input
          type="text"
          value={bankName}
          onChange={(e) => setBankName(e.target.value)}
          placeholder="Stellar Reserve Bank"
          className="workspace-input"
          disabled={loading}
          required
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <div>
          <label className="workspace-label">Account Number</label>
          <input
            type="text"
            value={bankAccount}
            onChange={(e) => setBankAccount(e.target.value)}
            placeholder="123456789"
            className="workspace-input"
            disabled={loading}
            required
          />
        </div>
        <div>
          <label className="workspace-label">Routing Transit Number</label>
          <input
            type="text"
            value={routingNumber}
            onChange={(e) => setRoutingNumber(e.target.value)}
            placeholder="987654321"
            className="workspace-input"
            disabled={loading}
            required
          />
        </div>
      </div>

      {error && <p className="workspace-error">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="workspace-button workspace-button--primary"
        style={{ width: "100%" }}
      >
        {loading ? "Processing..." : "Initiate Fiat Deposit"}
      </button>
    </form>
  );
}

export function LenderForms({
  pools,
  positions,
  walletBalance = 0,
  platformAddress,
  isKycVerified = false,
}: LenderFormsProps) {
  const router = useRouter();
  const [successTx, setSuccessTx] = useState<{
    poolName: string;
    amount: number;
    hash: string;
    balanceBefore: number;
  } | null>(null);
  const [currentWalletBalance, setCurrentWalletBalance] =
    useState(walletBalance);

  const [depositTab, setDepositTab] = useState<"crypto" | "fiat">("crypto");
  const [fiatInstructions, setFiatInstructions] = useState<{
    poolName: string;
    amount: number;
    currency: string;
    instructions: Record<string, string>;
  } | null>(null);
  const [fiatLoadingStatus, setFiatLoadingStatus] = useState<string>("");

  const PLATFORM_WALLET =
    platformAddress ?? process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS ?? "";

  // "Add token to wallet" is a Varial-extension-only affordance — the kit
  // exposes no equivalent for WalletConnect/xBull/Albedo, so a mobile wallet
  // user would only ever see it fail. Read the provider after mount: reading
  // localStorage during render would not match the server-rendered HTML.
  const [walletProvider, setWalletProvider] =
    useState<StellarWalletProvider | null>(null);
  useEffect(() => {
    setWalletProvider(getStoredWalletProvider());
  }, [successTx]);

  const lpTokenContractId =
    process.env.NEXT_PUBLIC_TLEND_TOKEN_CONTRACT_ID?.trim() ?? "";
  const canAddLpToken = walletProvider === "freighter" && Boolean(lpTokenContractId);
  const [addTokenStatus, setAddTokenStatus] = useState<string>("");

  const handleDeposit = async (poolId: string, amount: number) => {
    setSuccessTx(null);
    if (!PLATFORM_WALLET) {
      throw new Error(
        "Platform wallet not configured. Set NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS.",
      );
    }

    const wallet = await getConnectedWallet();
    const lenderAddress = wallet.address;

    const { TransactionBuilder, Networks, Operation, Asset, Memo } =
      await import("@stellar/stellar-sdk");

    const horizonUrl =
      process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
      "https://horizon-testnet.stellar.org";

    const accountRes = await fetch(`${horizonUrl}/accounts/${lenderAddress}`);
    if (!accountRes.ok) {
      throw new Error(
        `Lender account not found on Stellar. Fund it at https://friendbot.stellar.org?addr=${lenderAddress}`,
      );
    }
    const accountData = await accountRes.json();

    const { Account } = await import("@stellar/stellar-sdk");
    const account = new Account(lenderAddress, accountData.sequence);

    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: PLATFORM_WALLET,
          asset: Asset.native(),
          amount: amount.toFixed(7),
        }),
      )
      .addMemo(Memo.text(PAYMENT_MEMO.deposit(poolId)))
      .setTimeout(120)
      .build();

    const txXdr = tx.toXDR();

    const signResult = await signTransactionWithWallet({
      xdr: txXdr,
      networkPassphrase: Networks.TESTNET,
      address: lenderAddress,
      provider: wallet.provider,
    });

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

    const apiRes = await fetch("/api/pools/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolId, amount, txHash, lenderAddress }),
    });

    if (!apiRes.ok) {
      const apiErr = await apiRes.json();
      throw new Error(apiErr.error ?? "Backend recording failed");
    }

    const depositedPool = pools.find((p) => p.id === poolId);
    const balanceBefore = currentWalletBalance;
    setSuccessTx({
      poolName: depositedPool?.name ?? "Pool",
      amount,
      hash: txHash,
      balanceBefore,
    });
    setCurrentWalletBalance((prev) => Math.max(0, prev - amount));

    router.refresh();
  };

  const handleSep31Deposit = async (params: {
    poolId: string;
    amount: string;
    currency: string;
    firstName: string;
    lastName: string;
    email: string;
    bankName: string;
    bankAccount: string;
    routingNumber: string;
  }) => {
    setFiatLoadingStatus("Connecting to Stellar wallet...");
    try {
      const wallet = await getConnectedWallet();
      
      setFiatLoadingStatus("Discovering anchor endpoints...");
      const homeDomain = process.env.NEXT_PUBLIC_SEP24_ANCHOR_HOME_DOMAIN ?? "testanchor.stellar.org";
      const endpoints = await discoverSep31Anchor(homeDomain);

      setFiatLoadingStatus("Authenticating with anchor (SEP-10)...");
      const networkPassphrase = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
      const jwt = await authenticateSep31(endpoints, wallet.address, {
        provider: wallet.provider,
        homeDomain,
        networkPassphrase,
      });

      setFiatLoadingStatus("Registering customer profile (SEP-12)...");
      const senderId = await registerSep12Customer(endpoints.kycServer, jwt, {
        first_name: params.firstName,
        last_name: params.lastName,
        email: params.email,
        type: "sep31-sender",
      });

      const selectedPool = pools.find((p) => p.id === params.poolId);
      const poolName = selectedPool ? selectedPool.name : "TrustLend Pool";

      const receiverId = await registerSep12Customer(endpoints.kycServer, jwt, {
        first_name: "TrustLend",
        last_name: poolName,
        email: "escrow@trustlend.io",
        type: "sep31-receiver",
      });

      setFiatLoadingStatus("Initiating transaction (SEP-31)...");
      const callbackUrl = typeof window !== "undefined"
        ? `${window.location.origin}/api/webhooks/sep31`
        : "";

      const txRes = await createSep31Transaction(endpoints.directPaymentServer, jwt, {
        amount: params.amount,
        asset_code: "USD",
        sender_id: senderId,
        receiver_id: receiverId,
        fields: {
          transaction: {
            routing_number: params.routingNumber,
            bank_account_number: params.bankAccount,
          },
        },
        callback: callbackUrl || undefined,
      });

      setFiatLoadingStatus("Saving transaction details...");
      const rawInstructions = txRes.fields?.info || {
        how_to_pay: txRes.how_to_register || "Please wire the funds to the anchor's bank account.",
      };

      const apiRes = await fetch("/api/pools/sep31-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolId: params.poolId,
          amount: parseFloat(params.amount),
          currency: params.currency,
          anchorTxId: txRes.id,
          anchorJwt: jwt,
          instructions: rawInstructions,
          lenderAddress: wallet.address,
        }),
      });

      if (!apiRes.ok) {
        const errJson = await apiRes.json();
        throw new Error(errJson.error ?? "Failed to register transaction on TrustLend.");
      }

      setFiatInstructions({
        poolName,
        amount: parseFloat(params.amount),
        currency: params.currency,
        instructions: rawInstructions as Record<string, string>,
      });

      router.refresh();
    } catch (err) {
      console.error(err);
      throw err;
    } finally {
      setFiatLoadingStatus("");
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
      alert("Withdrawal request submitted!");
    } catch (error) {
      throw error;
    }
  };

  return (
    <>
      {/* ── Success Toast ─────────────────────────────────────── */}
      {successTx && (
        <div
          role="alert"
          aria-live="polite"
          style={{
            position: "fixed",
            bottom: "2rem",
            right: "2rem",
            zIndex: 9999,
            background: "linear-gradient(135deg, color-mix(in srgb, var(--surface-2) 97%, transparent), rgba(24,24,38,0.97))",
            border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
            borderRadius: "1rem",
            padding: "1.25rem 1.5rem",
            boxShadow:
              "0 8px 40px color-mix(in srgb, var(--fg) 50%, transparent), 0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent)",
            backdropFilter: "blur(16px)",
            minWidth: "320px",
            maxWidth: "400px",
            animation:
              "toastSlideIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: "0.75rem",
            }}
          >
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <span style={{ fontSize: "1.3rem" }}>✅</span>
              <h4
                style={{
                  color: "var(--accent)",
                  margin: 0,
                  fontSize: "0.95rem",
                  fontWeight: 700,
                }}
              >
                Deposit Successful!
              </h4>
            </div>
            <button
              onClick={() => setSuccessTx(null)}
              style={{
                background: "transparent",
                border: "none",
                color: "color-mix(in srgb, var(--fg) 40%, transparent)",
                cursor: "pointer",
                fontSize: "1rem",
                lineHeight: 1,
                padding: "0.1rem 0.3rem",
              }}
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>

          <p
            style={{
              margin: "0 0 0.85rem 0",
              fontSize: "0.85rem",
              opacity: 0.85,
            }}
          >
            You deployed{" "}
            <strong style={{ color: "var(--fg)" }}>{formatCurrency(successTx.amount)}</strong>{" "}
            into{" "}
            <strong style={{ color: "var(--fg)" }}>{successTx.poolName}</strong>.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto 1fr",
              alignItems: "center",
              gap: "0.4rem",
              background: "color-mix(in srgb, var(--fg) 4%, transparent)",
              borderRadius: "0.5rem",
              padding: "0.6rem 0.75rem",
              marginBottom: "0.85rem",
              fontSize: "0.78rem",
            }}
          >
            <div style={{ textAlign: "center" }}>
              <p
                style={{
                  opacity: 0.5,
                  marginBottom: "0.15rem",
                  fontSize: "0.7rem",
                }}
              >
                Before
              </p>
              <p style={{ fontWeight: 600, margin: 0 }}>
                {formatCurrency(successTx.balanceBefore)}
              </p>
            </div>
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>→</span>
            <div style={{ textAlign: "center" }}>
              <p
                style={{
                  opacity: 0.5,
                  marginBottom: "0.15rem",
                  fontSize: "0.7rem",
                }}
              >
                After
              </p>
              <p style={{ fontWeight: 600, margin: 0, color: "var(--accent)" }}>
                {formatCurrency(Math.max(0, successTx.balanceBefore - successTx.amount))}
              </p>
            </div>
          </div>

          <a
            href={`https://stellar.expert/explorer/testnet/tx/${successTx.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "block",
              textAlign: "center",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
              color: "var(--accent)",
              padding: "0.45rem",
              borderRadius: "0.5rem",
              fontSize: "0.78rem",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Verify on Stellar Explorer ↗
          </a>
          {canAddLpToken && (
          <button
            type="button"
            onClick={async () => {
              try {
                let isConnectedFn: () => Promise<{ isConnected?: boolean; error?: unknown }>;
                let addTokenFn: (params: { contractId: string; networkPassphrase?: string }) => Promise<{ result?: unknown; error?: unknown }>;
                try {
                  const varial = await import('@stellar/varial-sdk');
                  isConnectedFn = varial.isConnected;
                  addTokenFn = varial.addToken;
                } catch {
                  const freighter = await import('@stellar/freighter-api');
                  isConnectedFn = freighter.isConnected;
                  addTokenFn = freighter.addToken;
                }
                // isConnected() resolves to an object, so it is always truthy —
                // the boolean has to be read off the `isConnected` field.
                const connection = await isConnectedFn();
                if (connection.error || !connection.isConnected) {
                  setAddTokenStatus("Varial is not available. Unlock the extension and try again.");
                  return;
                }
                // Varial (formerly Freighter) replaced watchAsset(code/issuer) with
                // addToken(contractId) for Soroban tokens.
                const result = await addTokenFn({
                  contractId: lpTokenContractId,
                  networkPassphrase: getNetworkPassphrase(),
                });
                setAddTokenStatus(
                  result.error
                    ? `Could not add the LP token: ${String(result.error)}`
                    : "LP token added to Varial.",
                );
              } catch (e) {
                console.error(e);
                setAddTokenStatus(
                  `Failed to add token: ${e instanceof Error ? e.message : "Unknown error"}`,
                );
              }
            }}
            style={{
              display: "block",
              width: "100%",
              marginTop: "0.5rem",
              background: "transparent",
              border: "1px solid var(--primary)",
              color: "#c29df6",
              padding: "0.45rem",
              borderRadius: "0.5rem",
              fontSize: "0.78rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + Add LP Token to Wallet
          </button>
          )}

          {addTokenStatus ? (
            <p
              role="status"
              style={{
                marginTop: "0.4rem",
                fontSize: "0.72rem",
                textAlign: "center",
                opacity: 0.8,
              }}
            >
              {addTokenStatus}
            </p>
          ) : null}
        </div>
      )}

      {/* ── Fiat Instructions Overlay ──────────────────────────────── */}
      {fiatInstructions && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "color-mix(in srgb, var(--fg) 75%, transparent)",
            backdropFilter: "blur(8px)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 10000,
            padding: "1rem",
          }}
        >
          <div
            className="workspace-card"
            style={{
              maxWidth: "500px",
              width: "100%",
              border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)",
              boxShadow: "0 20px 50px rgba(0,0,0,0.6)",
              padding: "2rem",
              background: "linear-gradient(135deg, #12121c 0%, #171726 100%)",
            }}
          >
            <h3 style={{ margin: "0 0 1rem 0", color: "var(--primary)", fontSize: "1.25rem", fontWeight: 700 }}>
              🏦 Bank Payout Instructions
            </h3>
            <p style={{ fontSize: "0.88rem", opacity: 0.8, lineHeight: 1.5, marginBottom: "1.25rem" }}>
              To fund your position of <strong style={{ color: "var(--fg)" }}>${fiatInstructions.amount.toFixed(2)} {fiatInstructions.currency}</strong> in <strong style={{ color: "var(--fg)" }}>{fiatInstructions.poolName}</strong>, please submit a transfer using the bank details below:
            </p>

            <div
              style={{
                background: "color-mix(in srgb, var(--fg) 3%, transparent)",
                border: "1px solid color-mix(in srgb, var(--fg) 8%, transparent)",
                borderRadius: "0.6rem",
                padding: "1rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
                fontSize: "0.85rem",
                fontFamily: "monospace",
                marginBottom: "1.5rem",
              }}
            >
              {Object.entries(fiatInstructions.instructions).map(([key, val]) => (
                <div key={key} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.5 }}>{key.replace(/_/g, " ").toUpperCase()}:</span>
                  <span style={{ fontWeight: 600, color: "var(--accent)" }}>{String(val)}</span>
                </div>
              ))}
            </div>

            <div
              style={{
                background: "color-mix(in srgb, var(--accent) 6%, transparent)",
                border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                borderRadius: "0.5rem",
                padding: "0.75rem",
                fontSize: "0.78rem",
                color: "var(--accent)",
                lineHeight: 1.4,
                marginBottom: "1.5rem",
              }}
            >
              ℹ️ After you complete the wire transfer, the anchor will process the payment. Once approved, the funds will be credited directly to the pool automatically.
            </div>

            <button
              onClick={() => setFiatInstructions(null)}
              className="workspace-button workspace-button--primary"
              style={{ width: "100%" }}
            >
              Got it, Close
            </button>
          </div>
        </div>
      )}

      {/* ── Spinner overlay ─────────────────────────────────────────── */}
      {fiatLoadingStatus && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "color-mix(in srgb, var(--fg) 80%, transparent)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 10001,
            gap: "1rem",
          }}
        >
          <div
            style={{
              border: "4px solid color-mix(in srgb, var(--primary) 10%, transparent)",
              borderTop: "4px solid var(--primary)",
              borderRadius: "50%",
              width: "40px",
              height: "40px",
              animation: "spin 1s linear infinite",
            }}
          />
          <p style={{ color: "var(--fg)", fontSize: "0.95rem", fontWeight: 600 }}>{fiatLoadingStatus}</p>
          <style dangerouslySetInnerHTML={{ __html: `
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          ` }} />
        </div>
      )}

      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">Manage Your Deposits</h2>
        <div className="workspace-grid workspace-grid--two">
          <div>
            <h3 className="workspace-subheading" style={{ marginBottom: "1rem" }}>Deposit to Pool</h3>

            {/* Sub-tabs */}
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
              <button
                type="button"
                onClick={() => setDepositTab("crypto")}
                style={{
                  background: depositTab === "crypto" ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent",
                  color: depositTab === "crypto" ? "var(--accent)" : "color-mix(in srgb, var(--fg) 60%, transparent)",
                  border: depositTab === "crypto" ? "1px solid var(--accent)" : "1px solid color-mix(in srgb, var(--fg) 15%, transparent)",
                  padding: "0.4rem 0.8rem",
                  borderRadius: "0.5rem",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                🪙 Deposit Crypto (XLM)
              </button>
              <button
                type="button"
                onClick={() => setDepositTab("fiat")}
                style={{
                  background: depositTab === "fiat" ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent",
                  color: depositTab === "fiat" ? "var(--primary)" : "color-mix(in srgb, var(--fg) 60%, transparent)",
                  border: depositTab === "fiat" ? "1px solid var(--primary)" : "1px solid color-mix(in srgb, var(--fg) 15%, transparent)",
                  padding: "0.4rem 0.8rem",
                  borderRadius: "0.5rem",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                💵 Deposit Fiat (SEP-31)
              </button>
            </div>

            {depositTab === "crypto" ? (
              <>
                <p
                  className="workspace-card-copy"
                  style={{
                    fontSize: "0.82rem",
                    opacity: 0.7,
                    marginBottom: "0.75rem",
                  }}
                >
                  Your XLM will be sent directly to TrustLend&apos;s Stellar escrow
                  using your selected wallet connector. A real on-chain transaction
                  is required — no mock deposits.
                </p>
                <DepositForm
                  pools={pools}
                  walletBalance={currentWalletBalance}
                  onSubmit={handleDeposit}
                />
              </>
            ) : (
              <Sep31DepositForm
                pools={pools}
                isKycVerified={isKycVerified}
                onSubmit={handleSep31Deposit}
              />
            )}
          </div>
          <div>
            <h3 className="workspace-subheading">Withdraw from Position</h3>
            <WithdrawForm positions={positions} onSubmit={handleWithdraw} />
          </div>
        </div>
      </article>

      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes toastSlideIn {
              from { opacity: 0; transform: translateY(20px) scale(0.95); }
              to   { opacity: 1; transform: translateY(0)    scale(1);    }
            }
          `,
        }}
      />
    </>
  );
}
