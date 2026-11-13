"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatTokenBalance } from "@/lib/utils/formatting";
import { Tooltip } from "@/components/ui/Tooltip";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { FundingProgressBar } from "@/components/ui/FundingProgressBar";
import { WalletSelectionModal } from "@/components/ui/WalletSelectionModal";
import {
  getConnectedWallet,
  connectWallet,
  getStoredWalletProvider,
  getWalletProviderLabel,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet";
import {
  LendingContract,
  ReputationContract,
  xlmToStroops,
} from "@/lib/contracts";
import { isOnchainLifecycleRequired } from "@/lib/stellar/lifecycle-mode";
import { nativeAssetContractId } from "@/lib/stellar/native-asset";
import type { ReputationTier } from "@/types/contracts";

/** Collateral factor the LendingContract applies when no asset config is set (75%). */
const DEFAULT_COLLATERAL_FACTOR = 0.75;

interface LoanApplicationFormProps {
  maxAmount: number;
  walletAddress: string | null;
  walletProvider: StellarWalletProvider;
  onOpenWalletModal: () => void;
  onSubmit: (
    amount: number,
    duration: number,
    collateralAsset: string,
    collateralAmount: number,
    rateModel: "fixed" | "floating"
  ) => Promise<void>;
  statusMessage?: string;
}

export function LoanApplicationForm({
  maxAmount,
  walletAddress,
  walletProvider,
  onOpenWalletModal,
  onSubmit,
  statusMessage,
}: LoanApplicationFormProps) {
  const [amount, setAmount] = useState("");
  const [duration, setDuration] = useState("60");
  const [collateralAsset, setCollateralAsset] = useState(() => nativeAssetContractId());
  const [collateralAmount, setCollateralAmount] = useState("");
  const onchainRequired = isOnchainLifecycleRequired();
  const [rateModel, setRateModel] = useState<"fixed" | "floating">("fixed");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const amountNum = parseFloat(amount);
      const collateralAmountNum = parseFloat(collateralAmount);
      if (!amountNum || amountNum <= 0 || amountNum > maxAmount) {
        setError(`Amount must be between 1 and ${maxAmount}`);
        return;
      }
      if (!collateralAsset) {
        setError("Please select a collateral asset");
        return;
      }
      if (!collateralAmountNum || collateralAmountNum <= 0) {
        setError("Collateral amount must be positive");
        return;
      }
      if (onchainRequired && collateralAmountNum * DEFAULT_COLLATERAL_FACTOR < amountNum) {
        setError(
          `The LendingContract needs at least ${(amountNum / DEFAULT_COLLATERAL_FACTOR).toFixed(2)} XLM of collateral for a ${amountNum} XLM loan (75% LTV)`
        );
        return;
      }
      await onSubmit(
        amountNum,
        parseInt(duration),
        collateralAsset,
        collateralAmountNum,
        rateModel
      );
      setAmount("");
      setDuration("60");
      setCollateralAsset(nativeAssetContractId());
      setCollateralAmount("");
      setRateModel("fixed");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to submit application"
      );
    } finally {
      setLoading(false);
    }
  };

  const shortAddress = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;

  return (
    <form onSubmit={handleSubmit} className="workspace-form">
      {/* ── Connected Wallet Bar ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.75rem 1rem",
          borderRadius: "0.6rem",
          background: "color-mix(in srgb, var(--primary) 6%, transparent)",
          border: "1px solid color-mix(in srgb, var(--primary) 20%, transparent)",
          marginBottom: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "1.1rem" }}>🦊</span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <strong style={{ fontSize: "0.88rem", color: "var(--fg)" }}>
                {getWalletProviderLabel(walletProvider)}
              </strong>
              <span
                style={{
                  fontSize: "0.68rem",
                  fontWeight: 700,
                  color: "var(--accent-hover)",
                  background: "color-mix(in srgb, var(--accent) 14%, transparent)",
                  padding: "0.15rem 0.45rem",
                  borderRadius: "9999px",
                  textTransform: "uppercase",
                }}
              >
                {walletAddress ? "Connected" : "Default Signer"}
              </span>
            </div>
            <p
              style={{
                margin: "0.15rem 0 0",
                fontSize: "0.78rem",
                color: "var(--fg-muted)",
                fontFamily: "monospace",
              }}
            >
              {shortAddress ?? "Ready to authorize with Varial extension"}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenWalletModal}
          style={{
            background: "transparent",
            border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)",
            color: "var(--primary)",
            padding: "0.35rem 0.65rem",
            borderRadius: "0.45rem",
            fontSize: "0.78rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {walletAddress ? "Switch Wallet" : "Select Wallet"}
        </button>
      </div>

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

      <div>
        <label className="workspace-label">Collateral Asset Address</label>
        <input
          type="text"
          value={collateralAsset}
          onChange={(e) => setCollateralAsset(e.target.value)}
          placeholder="Enter collateral asset address"
          className="workspace-input"
          disabled={loading}
        />
        <p className="workspace-hint" style={{ marginTop: "0.35rem", fontSize: "0.75rem", color: "var(--fg-muted)" }}>
          Defaults to native XLM. The asset must be whitelisted on the LendingContract.
        </p>
      </div>

      <div>
        {/* The tooltip button sits beside the label, not inside it — a <label>
            must not contain another interactive control. */}
        <span className="term-tooltip">
          <label className="workspace-label">Collateral Amount</label>
          <TermTooltip term="LTV" side="top" />
        </span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={collateralAmount}
          onChange={(e) => setCollateralAmount(e.target.value)}
          placeholder="Enter collateral amount"
          className="workspace-input"
          disabled={loading}
        />
      </div>

      <div>
        <label className="workspace-label">Interest Rate Model</label>
        <div
          className="rate-model-selector"
          style={{ display: "flex", gap: "1rem", marginTop: "0.5rem" }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="rateModel"
              value="fixed"
              checked={rateModel === "fixed"}
              onChange={() => setRateModel("fixed")}
              disabled={loading}
              style={{ marginTop: "0.25rem" }}
            />
            <div>
              <strong>Fixed Rate</strong>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--fg-muted)" }}>
                Lock in your rate. Predictable payments.
              </p>
            </div>
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="rateModel"
              value="floating"
              checked={rateModel === "floating"}
              onChange={() => setRateModel("floating")}
              disabled={loading}
              style={{ marginTop: "0.25rem" }}
            />
            <div>
              <strong>Floating Rate</strong>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--fg-muted)" }}>
                Starts lower, adjusts with market.
              </p>

              {rateModel === "floating" && (
                <div
                  style={{
                    marginTop: "0.75rem",
                    display: "flex",
                    gap: "1rem",
                    flexWrap: "wrap",
                    background: "color-mix(in srgb, var(--fg) 3%, transparent)",
                    padding: "0.75rem",
                    borderRadius: "0.5rem",
                    border: "1px solid color-mix(in srgb, var(--fg) 10%, transparent)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.2rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.35rem",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          color: "color-mix(in srgb, var(--fg) 70%, transparent)",
                        }}
                      >
                        Base Rate
                      </span>
                      <Tooltip content="The minimum interest rate charged when pool utilization is 0%.">
                        <span
                          style={{
                            cursor: "help",
                            fontSize: "0.75rem",
                            opacity: 0.7,
                          }}
                        >
                          ⓘ
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.2rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.35rem",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          color: "color-mix(in srgb, var(--fg) 70%, transparent)",
                        }}
                      >
                        Utilization Rate
                      </span>
                      <Tooltip content="The percentage of the pool's total liquidity that is currently borrowed.">
                        <span
                          style={{
                            cursor: "help",
                            fontSize: "0.75rem",
                            opacity: 0.7,
                          }}
                        >
                          ⓘ
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.2rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.35rem",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          color: "color-mix(in srgb, var(--fg) 70%, transparent)",
                        }}
                      >
                        Multiplier
                      </span>
                      <Tooltip content="The rate at which interest increases as utilization increases.">
                        <span
                          style={{
                            cursor: "help",
                            fontSize: "0.75rem",
                            opacity: 0.7,
                          }}
                        >
                          ⓘ
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </label>
        </div>
      </div>

      {statusMessage && (
        <div
          style={{
            padding: "0.6rem 0.85rem",
            background: "color-mix(in srgb, var(--primary) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--primary) 25%, transparent)",
            borderRadius: "0.5rem",
            fontSize: "0.82rem",
            color: "var(--primary)",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span className="animate-spin">⏳</span>
          <span>{statusMessage}</span>
        </div>
      )}

      {error && <p className="workspace-error">{error}</p>}

      <button
        type="submit"
        disabled={loading || !amount}
        className="workspace-button workspace-button--primary"
        style={{ width: "100%", marginTop: "0.5rem" }}
      >
        {loading
          ? statusMessage || "Authorizing with Varial..."
          : "Sign & Submit Loan with Varial"}
      </button>
    </form>
  );
}

interface RepaymentFormProps {
  loanAmount: number;
  repaidAmount: number;
  loan?: BorrowerLoan | null;
  onSubmit: (amount: number) => Promise<void>;
}

export function RepaymentForm({
  loanAmount,
  repaidAmount,
  loan,
  onSubmit,
}: RepaymentFormProps) {
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

      {loan?.id && (
        <div
          style={{
            background: "color-mix(in srgb, var(--primary) 6%, transparent)",
            border: "1px solid color-mix(in srgb, var(--primary) 20%, transparent)",
            borderRadius: "0.5rem",
            padding: "0.75rem 0.9rem",
            marginBottom: "0.75rem",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: "0.8rem", color: "var(--fg)" }}>
              ⚡ <strong>Varial On-Chain Repayment:</strong> Sign settlement transaction with adjusted interest.
            </span>
            <a
              href={`/dashboard/borrower/repay?loanId=${loan.id}`}
              style={{
                fontSize: "0.78rem",
                fontWeight: 700,
                color: "var(--primary)",
                textDecoration: "underline",
                whiteSpace: "nowrap",
              }}
            >
              Open Varial Payoff Interface →
            </a>
          </div>
        </div>
      )}

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

      <div
        className="workspace-form-actions"
        style={{
          flexDirection: "column",
          gap: "0.6rem",
          marginTop: "0.6rem",
        }}
      >
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
  /** Total lenders have contributed so far (Issue #269). */
  funded_amount?: number;
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
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletProvider, setWalletProvider] =
    useState<StellarWalletProvider>("freighter");
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const pendingLoans = loans.filter(
    (loan) => String(loan.status) === "requested"
  );

  // Sync connected wallet on mount
  useEffect(() => {
    const storedProvider = getStoredWalletProvider() ?? "freighter";
    setWalletProvider(storedProvider);

    if (typeof window !== "undefined") {
      const storedAddr = window.localStorage.getItem("wallet_address");
      if (storedAddr) {
        setWalletAddress(storedAddr);
      }
    }

    // Best effort background check for live wallet
    getConnectedWallet(storedProvider)
      .then((w) => {
        if (w?.address) {
          setWalletAddress(w.address);
          setWalletProvider(w.provider);
        }
      })
      .catch(() => {
        /* wallet not unlocked yet, user will connect on action */
      });
  }, []);

  const handleSelectWallet = useCallback(
    async (selected: StellarWalletProvider) => {
      setShowWalletModal(false);
      setWalletProvider(selected);
      try {
        const wallet = await connectWallet(selected);
        setWalletAddress(wallet.address);
        setWalletProvider(wallet.provider);
      } catch (err) {
        console.warn("[TrustLend] Wallet connection skipped or cancelled:", err);
      }
    },
    []
  );

  const handleLoanApplication = async (
    amount: number,
    duration: number,
    collateralAsset: string,
    collateralAmount: number,
    rateModel: "fixed" | "floating"
  ) => {
    setSorobanLoading(true);
    const onchainRequired = isOnchainLifecycleRequired();
    setStatusMessage(onchainRequired ? "1/3 Checking eligibility..." : "1/3 Submitting loan request...");
    try {
      // 1. Ensure borrower wallet is connected (defaults to Varial)
      let activeWallet = walletAddress;
      try {
        const wallet = await getConnectedWallet(walletProvider);
        activeWallet = wallet.address;
        setWalletAddress(wallet.address);
        setWalletProvider(wallet.provider);
      } catch (walletErr) {
        console.warn(
          "[TrustLend] Falling back to stored address or prompt:",
          walletErr
        );
      }

      const submitApplication = async (extra: Record<string, unknown>) => {
        const response = await fetch("/api/loans/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount,
            duration_days: duration,
            pool_id: "default",
            collateral_asset: collateralAsset,
            collateral_amount: collateralAmount,
            rateModel,
            ...extra,
          }),
        });
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json.error || "Failed to apply for loan");
        }
        return json;
      };

      if (onchainRequired) {
        // ── On-chain lifecycle: the request must exist on the LendingContract ──
        if (!activeWallet) {
          throw new Error("Connect your Stellar wallet to sign the on-chain loan request.");
        }

        // Validate eligibility server-side first so the wallet is never asked
        // to sign a request the API would reject afterwards.
        await submitApplication({ preflight: true, walletAddress: activeWallet });

        setStatusMessage(
          `2/3 Reading your on-chain reputation terms...`
        );
        const [onChainRate, onChainMax, profile] = await Promise.all([
          ReputationContract.getInterestRate(activeWallet, activeWallet),
          ReputationContract.getMaxLoan(activeWallet, activeWallet),
          ReputationContract.getBorrowerProfile(activeWallet, activeWallet).catch(() => null),
        ]);
        const reputationTier: ReputationTier = profile?.reputationTier ?? "None";

        setStatusMessage(
          `3/3 Sign the loan request in ${getWalletProviderLabel(walletProvider)}...`
        );
        const { loanId: onchainLoanId, txHash: onchainTxHash } =
          await LendingContract.createLoanRequest({
            borrowerAddress: activeWallet,
            amountStroops: xlmToStroops(amount),
            durationDays: duration,
            interestRateBps: onChainRate,
            maxLoanAmountStroops: onChainMax,
            collateralEntries: [{ asset: collateralAsset, amount: xlmToStroops(collateralAmount) }],
            rateModel: rateModel === "fixed" ? "Fixed" : "Floating",
            reputationTier,
          });

        setStatusMessage("Recording your request...");
        await submitApplication({ onchainLoanId, onchainTxHash, walletAddress: activeWallet });
      } else {
        // ── Database-only mode: record first, mirror on-chain best-effort ──
        await submitApplication({});

        if (activeWallet) {
          setStatusMessage(
            `2/3 Please approve the transaction in ${getWalletProviderLabel(walletProvider)}...`
          );
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Soroban RPC timeout")), 15000)
          );
          try {
            const [onChainRate, onChainMax] = await Promise.race([
              Promise.all([
                ReputationContract.getInterestRate(activeWallet, activeWallet),
                ReputationContract.getMaxLoan(activeWallet, activeWallet),
              ]),
              timeout,
            ]);

            setStatusMessage(
              `3/3 Signing & confirming on-chain with ${getWalletProviderLabel(walletProvider)}...`
            );
            await LendingContract.createLoanRequest({
              borrowerAddress: activeWallet,
              amountStroops: xlmToStroops(amount),
              durationDays: duration,
              interestRateBps: onChainRate,
              maxLoanAmountStroops: onChainMax,
              collateralEntries: [{ asset: collateralAsset, amount: xlmToStroops(collateralAmount) }],
              rateModel: rateModel === "fixed" ? "Fixed" : "Floating",
            });
          } catch (sorobanErr) {
            console.warn(
              "[TrustLend] Soroban sync warning:",
              (sorobanErr as Error).message
            );
          }
        }
      }

      setStatusMessage("");
      router.refresh();
      alert("Loan application submitted and authorized successfully!");
    } finally {
      setStatusMessage("");
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
      alert("Payment recorded successfully!");
    } catch (error) {
      throw error;
    }
  };

  return (
    <>
      <WalletSelectionModal
        open={showWalletModal}
        selectedProvider={walletProvider}
        title="Connect Borrower Wallet"
        description="Choose Varial or another Stellar wallet to authorize and sign borrowing transactions."
        onSelect={handleSelectWallet}
        onClose={() => setShowWalletModal(false)}
      />

      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">Apply for a New Loan</h2>
        {!canApplyLoan ? (
          <p className="workspace-card-copy">
            Verification is still in progress. Days remaining:{" "}
            {Math.max(0, 30 - monitoringDays)}.
          </p>
        ) : (
          <LoanApplicationForm
            maxAmount={maxLoanAmount}
            walletAddress={walletAddress}
            walletProvider={walletProvider}
            onOpenWalletModal={() => setShowWalletModal(true)}
            onSubmit={handleLoanApplication}
            statusMessage={statusMessage}
          />
        )}
      </article>

      {pendingLoans.length > 0 && (
        <article
          className="workspace-card workspace-card--full"
          style={{
            borderColor: "color-mix(in srgb, var(--warning) 25%, transparent)",
            background: "color-mix(in srgb, var(--warning) 4%, transparent)",
          }}
        >
          <h2 className="workspace-card-title">
            Pending Loan Request{pendingLoans.length > 1 ? "s" : ""}
          </h2>
          <p className="workspace-card-copy" style={{ marginTop: "0.35rem" }}>
            Your submitted request{pendingLoans.length > 1 ? "s are" : " is"}{" "}
            waiting for lender funding. Several lenders can each fund a slice —
            the loan activates once it reaches 100%.
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
                  background: "color-mix(in srgb, var(--fg) 75%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--warning) 18%, transparent)",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <p style={{ fontWeight: 700, margin: 0 }}>
                    Loan #{String(loan.id).slice(0, 8)}
                  </p>
                  <p
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--fg-muted)",
                      margin: "0.15rem 0 0",
                    }}
                  >
                    Requested{" "}
                    {loan.created_at
                      ? new Date(String(loan.created_at)).toLocaleDateString()
                      : "recently"}
                  </p>
                </div>
                <div style={{ flex: "1 1 12rem", minWidth: "10rem" }}>
                  <FundingProgressBar
                    principalAmount={loan.principal_amount}
                    fundedAmount={loan.funded_amount ?? 0}
                  />
                </div>

                <div style={{ textAlign: "right" }}>
                  <p
                    style={{
                      margin: 0,
                      fontWeight: 800,
                      color: "var(--primary)",
                    }}
                  >
                    {formatTokenBalance(Number(loan.principal_amount ?? 0))}
                  </p>
                  <p
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--warning)",
                      fontWeight: 700,
                      margin: "0.15rem 0 0",
                    }}
                  >
                    {Number(loan.funded_amount ?? 0) > 0
                      ? "PARTIALLY FUNDED"
                      : "REQUESTED"}
                  </p>
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
            <p className="workspace-card-copy">
              No active loan available for repayment.
            </p>
            {pendingLoans.length > 0 && (
              <p
                className="workspace-card-copy"
                style={{ marginTop: "0.5rem", color: "var(--warning)" }}
              >
                You still have a pending loan request. Repayment will appear
                after a lender funds it.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="workspace-card-copy">
              Loan #{String(selectedRepaymentLoan.id).slice(0, 8)}
            </p>
            <p className="workspace-card-copy">
              Still owe: {formatTokenBalance(dueAmount)}
            </p>
            <p className="workspace-card-copy">
              Next due:{" "}
              {selectedRepaymentLoan.due_at
                ? new Date(
                    String(selectedRepaymentLoan.due_at)
                  ).toLocaleDateString()
                : "-"}
            </p>
            <RepaymentForm
              loanAmount={Number(selectedRepaymentLoan.principal_amount ?? 0)}
              repaidAmount={Number(selectedRepaymentLoan.repaid_amount ?? 0)}
              loan={selectedRepaymentLoan}
              onSubmit={handleRepayment}
            />
          </>
        )}
      </article>
    </>
  );
}
