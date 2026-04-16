"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface OpenLoan {
  id: string;
  principal_amount: number;
  apr_bps: number;
  duration_days: number;
  trust_score: number;
  borrower_wallet?: string | null;
}

interface DirectFundFormProps {
  loan: OpenLoan;
  onClose: () => void;
}

type Step =
  | "idle"
  | "connecting"
  | "building"
  | "signing"
  | "submitting"
  | "recording"
  | "done"
  | "error";

const STEP_LABELS: Record<Step, string> = {
  idle:       "Ready to fund",
  connecting: "1/5 -- Connecting to Freighter...",
  building:   "2/5 -- Building Stellar payment...",
  signing:    "3/5 -- Waiting for signature...",
  submitting: "4/5 -- Submitting to Stellar network...",
  recording:  "5/5 -- Recording on TrustLend...",
  done:       "Success!",
  error:      "Failed",
};

export function DirectFundForm({ loan, onClose }: DirectFundFormProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [explorerUrl, setExplorerUrl] = useState("");

  const interestXlm = (
    (loan.principal_amount * (loan.apr_bps / 10000) * loan.duration_days) / 365
  ).toFixed(4);

  const totalReturn = (loan.principal_amount + parseFloat(interestXlm)).toFixed(4);
  const borrowerWallet = loan.borrower_wallet ?? "";

  const handleFund = async () => {
    setErrorMsg("");
    setStep("connecting");

    try {
      if (!borrowerWallet) {
        throw new Error("Borrower has not connected a wallet yet. Cannot fund this loan.");
      }

      // Step 1 -- Freighter connection
      const { isConnected, getAddress, signTransaction } = await import(
        "@stellar/freighter-api"
      );
      const connResult = await isConnected();
      if (!connResult.isConnected) {
        throw new Error("Freighter is not connected. Open Freighter and try again.");
      }

      const addrResult = await getAddress();
      if (addrResult.error || !addrResult.address) {
        throw new Error("Could not get your wallet address from Freighter.");
      }
      const lenderAddress = addrResult.address;

      if (lenderAddress === borrowerWallet) {
        throw new Error("You cannot fund your own loan.");
      }

      // Step 2 -- Build transaction
      setStep("building");
      const {
        TransactionBuilder,
        Networks,
        Operation,
        Asset,
        Memo,
        Account,
      } = await import("@stellar/stellar-sdk");

      const horizonUrl =
        process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
        "https://horizon-testnet.stellar.org";

      const accountRes = await fetch(`${horizonUrl}/accounts/${lenderAddress}`);
      if (!accountRes.ok) {
        throw new Error(
          `Your account is not connected to the Stellar network. Fund it at: https://friendbot.stellar.org?addr=${lenderAddress}`
        );
      }
      const accountData = await accountRes.json();
      const account = new Account(lenderAddress, accountData.sequence);

      const tx = new TransactionBuilder(account, {
        fee: "10000", 
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: borrowerWallet,
            asset: Asset.native(),
            amount: loan.principal_amount.toFixed(7),
          })
        )
        .addMemo(Memo.text(`TL-FUND:${loan.id.slice(0, 12)}`))
        .setTimeout(180)
        .build();

      const txXdr = tx.toXDR();

      // Step 3 -- Sign with Freighter
      setStep("signing");
      const signResult = await signTransaction(txXdr, {
        networkPassphrase: Networks.TESTNET,
      });

      if (signResult.error || !signResult.signedTxXdr) {
        throw new Error(
          signResult.error?.message ?? "Transaction rejected in Freighter."
        );
      }

      // Step 4 -- Submit to Stellar
      setStep("submitting");
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
          "Unknown error";
        throw new Error(`Stellar submission failed: ${detail}`);
      }

      const txHash: string = submitData.hash;

      // Step 5 -- Record on TrustLend
      setStep("recording");
      const apiRes = await fetch("/api/loans/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: loan.id, txHash, lenderAddress }),
      });

      if (!apiRes.ok) {
        const apiErr = await apiRes.json();
        throw new Error(apiErr.error ?? "Backend recording failed");
      }

      const apiData = await apiRes.json();
      setExplorerUrl(apiData.explorerUrl ?? "");
      setStep("done");
      
      setTimeout(() => {
        router.refresh();
        onClose();
      }, 3000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
      setStep("error");
    }
  };

  return (
    <div
      style={{
        padding: "1.75rem",
        border: "1px solid rgba(126, 47, 208, 0.15)",
        borderRadius: "1rem",
        background: "#ffffff", // Clean white background for light theme
        boxShadow: "0 12px 40px rgba(126, 47, 208, 0.08)",
        maxWidth: "600px",
        margin: "0 auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h3 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700, color: "#111", display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "1.5rem" }}>🛡️</span> Direct P2P Funding
        </h3>
        <span style={{ fontSize: "0.75rem", color: "rgba(0,0,0,0.4)", letterSpacing: "0.05em", fontWeight: 600 }}>STELLAR NETWORK</span>
      </div>

      <div style={{ 
        background: "#fafafa", 
        border: "1px solid rgba(126,47,208,0.1)", 
        borderRadius: "0.75rem", 
        padding: "1.25rem",
        marginBottom: "1.5rem" 
      }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem 2rem" }}>
          <div>
            <p style={{ margin: "0 0 0.2rem 0", fontSize: "0.75rem", color: "rgba(0,0,0,0.5)", textTransform: "uppercase", fontWeight: 600 }}>Principal Amount</p>
            <p style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#111" }}>{loan.principal_amount} <span style={{ fontSize: "0.8rem", color: "rgba(0,0,0,0.4)" }}>XLM</span></p>
          </div>
          <div>
            <p style={{ margin: "0 0 0.2rem 0", fontSize: "0.75rem", color: "rgba(0,0,0,0.5)", textTransform: "uppercase", fontWeight: 600 }}>Annual Return (APR)</p>
            <p style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: "#22cf9d" }}>{(loan.apr_bps / 100).toFixed(2)}%</p>
          </div>
          <div>
            <p style={{ margin: "0 0 0.2rem 0", fontSize: "0.75rem", color: "rgba(0,0,0,0.5)", textTransform: "uppercase", fontWeight: 600 }}>Interest Earned</p>
            <p style={{ margin: 0, fontSize: "1rem", fontWeight: 600, color: "#444" }}>+{interestXlm} <span style={{ fontSize: "0.8rem", color: "rgba(0,0,0,0.4)" }}>XLM</span></p>
          </div>
          <div>
            <p style={{ margin: "0 0 0.2rem 0", fontSize: "0.75rem", color: "rgba(0,0,0,0.5)", textTransform: "uppercase", fontWeight: 600 }}>Total Expected</p>
            <p style={{ margin: 0, fontSize: "1rem", fontWeight: 600, color: "#111" }}>{totalReturn} XLM</p>
          </div>
        </div>

        <div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px dashed rgba(0,0,0,0.1)" }}>
          <p style={{ margin: "0 0 0.4rem 0", fontSize: "0.75rem", color: "rgba(0,0,0,0.5)", textTransform: "uppercase", fontWeight: 600 }}>Recipient Wallet Address</p>
          <p style={{ margin: 0, fontFamily: "monospace", fontSize: "0.85rem", color: "#7e2fd0", wordBreak: "break-all" }}>
            {borrowerWallet || "⚠ No wallet registered"}
          </p>
        </div>
      </div>

      <div style={{ 
        padding: "0.85rem", 
        background: "rgba(126, 47, 208, 0.05)", 
        borderRadius: "0.6rem", 
        border: "1px solid rgba(126, 47, 208, 0.15)",
        marginBottom: "1.5rem"
      }}>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "rgba(0,0,0,0.7)", lineHeight: 1.5 }}>
          ℹ️ Your XLM will be sent directly to the borrower. TrustLend records the transaction hash to verify your claim to the repayment.
        </p>
      </div>

      {step !== "idle" && step !== "error" && step !== "done" && (
        <div style={{ 
          padding: "1rem", 
          textAlign: "center", 
          borderRadius: "0.75rem", 
          background: "rgba(126,47,208,0.05)", 
          border: "1px solid rgba(126,47,208,0.2)", 
          marginBottom: "1.5rem",
          animation: "pulse 2s infinite"
        }}>
          <div style={{ fontSize: "1.25rem", marginBottom: "0.4rem" }}>⚡</div>
          <p style={{ margin: 0, color: "#7e2fd0", fontWeight: 600, fontSize: "0.9rem" }}>{STEP_LABELS[step]}</p>
          <p style={{ margin: "0.25rem 0 0 0", color: "rgba(0,0,0,0.4)", fontSize: "0.7rem" }}>Please do not close this window</p>
        </div>
      )}

      {step === "done" && (
        <div style={{ 
          padding: "1.25rem", 
          textAlign: "center", 
          borderRadius: "0.75rem", 
          background: "rgba(34,207,157,0.08)", 
          border: "1px solid rgba(34,207,157,0.3)", 
          marginBottom: "1.5rem"
        }}>
          <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>🎉</div>
          <p style={{ margin: 0, color: "#20bd8e", fontWeight: 700 }}>Transaction Confirmed!</p>
          <p style={{ margin: "0.25rem 0 0.75rem 0", color: "rgba(0,0,0,0.6)", fontSize: "0.8rem" }}>{loan.principal_amount} XLM has been sent on-chain.</p>
          {explorerUrl && (
            <a 
              href={explorerUrl} 
              target="_blank" 
              rel="noreferrer" 
              style={{ 
                display: "inline-block", 
                color: "#20bd8e", 
                fontSize: "0.8rem", 
                textDecoration: "underline",
                fontWeight: 600
              }}
            >
              Verify on Stellar Explorer ↗
            </a>
          )}
        </div>
      )}

      {step === "error" && (
        <div style={{ 
          padding: "1rem", 
          borderRadius: "0.75rem", 
          background: "rgba(255,107,107,0.08)", 
          border: "1px solid rgba(255,107,107,0.3)", 
          marginBottom: "1.5rem"
        }}>
          <p style={{ margin: "0 0 0.25rem 0", color: "#e03e3e", fontWeight: 700, fontSize: "0.9rem" }}>Interaction Failed</p>
          <p style={{ margin: 0, color: "rgba(0,0,0,0.7)", fontSize: "0.8rem", lineHeight: 1.4 }}>{errorMsg}</p>
        </div>
      )}

      <div style={{ display: "flex", gap: "1rem" }}>
        <button
          onClick={handleFund}
          disabled={step !== "idle" && step !== "error"}
          className="workspace-button workspace-button--primary"
          style={{ 
            flex: 2, 
            height: "3.25rem", 
            fontSize: "1rem", 
            fontWeight: 700,
            background: "linear-gradient(135deg, #7e2fd0 0%, #5a1fad 100%)",
            color: "#fff",
            boxShadow: "0 4px 15px rgba(126, 47, 208, 0.25)",
            border: "none",
            borderRadius: "0.5rem",
            cursor: step !== "idle" && step !== "error" ? "not-allowed" : "pointer"
          }}
        >
          {step === "signing" ? "Check Freighter..." :
           step === "done"    ? "Returning..." :
           step === "error"   ? "Try Again" :
           step !== "idle"    ? "Processing..." :
           `Confirm & Send ${loan.principal_amount} XLM`}
        </button>
        <button
          onClick={onClose}
          disabled={step !== "idle" && step !== "error" && step !== "done"}
          className="workspace-button workspace-button--secondary"
          style={{ flex: 1, border: "1px solid rgba(0,0,0,0.15)", background: "#fff", color: "#444", borderRadius: "0.5rem", fontWeight: 600 }}
        >
          Cancel
        </button>
      </div>

      <style jsx>{`
        @keyframes pulse {
          0% { opacity: 0.8; }
          50% { opacity: 1; }
          100% { opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
