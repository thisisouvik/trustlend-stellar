"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  getConnectedWallet,
  getWalletProviderLabel,
} from "@/lib/stellar/wallet";
import { getSep24Config } from "@/lib/stellar/sep24-config";
import {
  authenticate,
  discoverAnchor,
  pollTransaction,
  startInteractiveWithdraw,
  SEP24_STATUS_LABEL,
  type AnchorEndpoints,
  type Sep24Transaction,
} from "@/lib/stellar/sep24";

interface WithdrawToFiatButtonProps {
  /** Borrower wallet address (G...). If null the button prompts to connect. */
  walletAddress: string | null;
}

type Step =
  | "idle"
  | "connecting"
  | "discovering"
  | "authenticating"
  | "initiating"
  | "interactive"
  | "done"
  | "error";

const STEP_LABEL: Record<Step, string> = {
  idle: "",
  connecting: "Connecting wallet…",
  discovering: "Discovering anchor…",
  authenticating: "Authenticating (SEP-10)…",
  initiating: "Starting withdrawal…",
  interactive: "Complete the steps in the anchor window",
  done: "",
  error: "",
};

export function WithdrawToFiatButton({ walletAddress }: WithdrawToFiatButtonProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Sep24Transaction | null>(null);
  const [interactiveUrl, setInteractiveUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const config = getSep24Config();
  const busy = step !== "idle" && step !== "done" && step !== "error";

  // Clean up any in-flight polling when the modal closes / unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep("idle");
    setError(null);
    setTx(null);
    setInteractiveUrl(null);
    setAmount("");
  }, []);

  const startWithdraw = useCallback(async () => {
    setError(null);
    setTx(null);
    setInteractiveUrl(null);

    try {
      // 1. Resolve the connected wallet (provider + address).
      setStep("connecting");
      const wallet = await getConnectedWallet();
      const account = walletAddress ?? wallet.address;

      // 2. Discover anchor endpoints from stellar.toml.
      setStep("discovering");
      const endpoints: AnchorEndpoints = await discoverAnchor(config);

      // 3. SEP-10 auth → JWT (wallet signs the challenge).
      setStep("authenticating");
      const jwt = await authenticate(endpoints, account, {
        provider: wallet.provider,
        config,
      });

      // 4. Start the interactive withdraw → get the anchor's hosted URL.
      setStep("initiating");
      const session = await startInteractiveWithdraw(endpoints, jwt, {
        account,
        assetCode: config.assetCode,
        amount: amount.trim() || undefined,
      });

      // 5. Open the interactive URL in a popup for the user to enter bank /
      //    mobile-money details. Fall back to an inline link if it's blocked.
      setInteractiveUrl(session.url);
      const popup = window.open(
        session.url,
        "trustlend_sep24",
        "width=480,height=720,menubar=no,toolbar=no"
      );
      if (!popup) {
        setError(
          "Popup blocked — use the link below to open the secure anchor window."
        );
      }
      setStep("interactive");

      // 6. Poll the anchor for status until the transfer reaches a terminal state.
      const controller = new AbortController();
      abortRef.current = controller;
      const finalTx = await pollTransaction(
        endpoints,
        jwt,
        session.id,
        (update) => setTx(update),
        { signal: controller.signal }
      );
      setTx(finalTx);
      setStep("done");
      if (!popup?.closed) popup?.close();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Withdrawal failed.");
      setStep("error");
    }
  }, [amount, config, walletAddress]);

  if (!walletAddress) {
    return (
      <article
        className="workspace-card workspace-card--full"
        style={{ borderColor: "rgba(126,47,208,0.25)" }}
      >
        <h2 className="workspace-card-title">💸 Withdraw to Fiat</h2>
        <p className="workspace-card-copy" style={{ marginTop: "0.4rem" }}>
          Connect your Stellar wallet to cash out to a bank account or mobile-money
          wallet via a Stellar Anchor.
        </p>
      </article>
    );
  }

  return (
    <>
      <article className="workspace-card workspace-card--full">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 className="workspace-card-title" style={{ margin: 0 }}>
              💸 Withdraw to Fiat
            </h2>
            <p
              className="workspace-card-copy"
              style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", opacity: 0.8 }}
            >
              Cash out {config.assetCode} to your bank or mobile-money account via a
              Stellar Anchor ({config.homeDomain}).
            </p>
          </div>
          <button
            type="button"
            className="wallet-card-action"
            onClick={() => setOpen(true)}
          >
            Withdraw to Fiat →
          </button>
        </div>
      </article>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "1rem",
          }}
          onClick={() => {
            if (!busy) {
              setOpen(false);
              reset();
            }
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: "1rem",
              padding: "1.75rem",
              width: "100%",
              maxWidth: "440px",
              boxShadow: "0 24px 60px rgba(15,23,42,0.25)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.75rem",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 800 }}>
                Withdraw {config.assetCode} to Fiat
              </h3>
              <button
                type="button"
                aria-label="Close"
                onClick={() => {
                  if (!busy) {
                    setOpen(false);
                    reset();
                  }
                }}
                disabled={busy}
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: "1.25rem",
                  cursor: busy ? "not-allowed" : "pointer",
                  color: "#6b7280",
                }}
              >
                ×
              </button>
            </div>

            <p style={{ fontSize: "0.82rem", color: "#6b7280", marginTop: 0 }}>
              Powered by Stellar Anchor SEP-24. You&apos;ll sign a one-time login
              challenge in {getWalletProviderLabel(getConnectedWalletProviderSafe())},
              then enter your payout details in the anchor&apos;s secure window.
            </p>

            {step === "idle" && (
              <>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    color: "#374151",
                    margin: "1rem 0 0.35rem",
                  }}
                >
                  Amount ({config.assetCode}) — optional
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Leave blank to choose in the anchor window"
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.75rem",
                    borderRadius: "0.5rem",
                    border: "1px solid #e5e7eb",
                    fontSize: "0.9rem",
                  }}
                />
                <button
                  type="button"
                  onClick={() => void startWithdraw()}
                  style={primaryBtnStyle}
                >
                  Start Withdrawal
                </button>
              </>
            )}

            {busy && (
              <div style={{ marginTop: "1.25rem", textAlign: "center" }}>
                <div className="sep24-spinner" style={spinnerStyle} />
                <p style={{ fontSize: "0.9rem", fontWeight: 600, color: "#374151" }}>
                  {STEP_LABEL[step]}
                </p>
                {tx && (
                  <p style={{ fontSize: "0.82rem", color: "#6b7280" }}>
                    {SEP24_STATUS_LABEL[tx.status] ?? tx.status}
                  </p>
                )}
                {step === "interactive" && interactiveUrl && (
                  <a
                    href={interactiveUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-block",
                      marginTop: "0.6rem",
                      fontSize: "0.82rem",
                      color: "#7e2fd0",
                      fontWeight: 700,
                    }}
                  >
                    Reopen anchor window ↗
                  </a>
                )}
              </div>
            )}

            {step === "done" && tx && (
              <div style={{ marginTop: "1.25rem", textAlign: "center" }}>
                <div style={{ fontSize: "2.5rem" }}>
                  {tx.status === "completed" ? "🎉" : "ℹ️"}
                </div>
                <p style={{ fontWeight: 700, color: "#111827" }}>
                  {SEP24_STATUS_LABEL[tx.status] ?? tx.status}
                </p>
                {tx.amount_out && (
                  <p style={{ fontSize: "0.85rem", color: "#6b7280" }}>
                    You receive: <strong>{tx.amount_out}</strong>
                    {tx.amount_fee ? ` (fee ${tx.amount_fee})` : ""}
                  </p>
                )}
                {tx.more_info_url && (
                  <a
                    href={tx.more_info_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: "0.82rem", color: "#7e2fd0", fontWeight: 700 }}
                  >
                    View transaction details ↗
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    reset();
                  }}
                  style={primaryBtnStyle}
                >
                  Done
                </button>
              </div>
            )}

            {step === "error" && (
              <div style={{ marginTop: "1.25rem" }}>
                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "#b91c1c",
                    background: "rgba(185,28,28,0.08)",
                    padding: "0.6rem 0.75rem",
                    borderRadius: "0.5rem",
                  }}
                >
                  {error}
                </p>
                <button type="button" onClick={() => void startWithdraw()} style={primaryBtnStyle}>
                  Try Again
                </button>
              </div>
            )}

            {error && step === "interactive" && (
              <p style={{ fontSize: "0.8rem", color: "#b45309", marginTop: "0.75rem" }}>
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Wallet provider label is best-effort for the helper copy; default to Freighter.
function getConnectedWalletProviderSafe() {
  if (typeof window === "undefined") return "freighter" as const;
  const stored = window.localStorage.getItem("wallet_provider");
  return stored === "albedo" ? ("albedo" as const) : ("freighter" as const);
}

const primaryBtnStyle: CSSProperties = {
  width: "100%",
  marginTop: "1.1rem",
  padding: "0.7rem 1rem",
  background: "#7e2fd0",
  color: "#fff",
  border: "none",
  borderRadius: "0.6rem",
  fontSize: "0.9rem",
  fontWeight: 700,
  cursor: "pointer",
};

const spinnerStyle: CSSProperties = {
  width: "32px",
  height: "32px",
  margin: "0 auto 0.75rem",
  border: "3px solid #ede9fe",
  borderTopColor: "#7e2fd0",
  borderRadius: "50%",
  animation: "sep24-spin 0.8s linear infinite",
};
