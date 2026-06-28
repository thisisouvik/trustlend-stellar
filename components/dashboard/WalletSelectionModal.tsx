"use client";

import type { StellarWalletProvider } from "@/lib/stellar/wallet";
import { getWalletProviderLabel } from "@/lib/stellar/wallet";

interface WalletSelectionModalProps {
  open: boolean;
  busy?: boolean;
  selectedProvider: StellarWalletProvider;
  onSelect: (provider: StellarWalletProvider) => void;
  onClose: () => void;
}

const WALLET_OPTIONS: Array<{
  provider: StellarWalletProvider;
  title: string;
  description: string;
}> = [
  {
    provider: "freighter",
    title: "Freighter",
    description: "Use the browser extension wallet already supported by TrustLend.",
  },
  {
    provider: "albedo",
    title: "Albedo",
    description: "Connect and sign through Albedo as an alternative Stellar wallet flow.",
  },
];

export function WalletSelectionModal({
  open,
  busy = false,
  selectedProvider,
  onSelect,
  onClose,
}: WalletSelectionModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      onClick={busy ? undefined : onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a Stellar wallet"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "32rem",
          borderRadius: "1.25rem",
          background: "#ffffff",
          boxShadow: "0 30px 80px rgba(15, 23, 42, 0.22)",
          border: "1px solid rgba(126, 47, 208, 0.12)",
          padding: "1.5rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem" }}>
          <div>
            <p style={{ margin: 0, fontSize: "0.78rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7e2fd0" }}>
              Wallet connection
            </p>
            <h3 style={{ margin: "0.35rem 0 0", fontSize: "1.2rem", fontWeight: 800, color: "#111827" }}>
              Select a Stellar wallet
            </h3>
            <p style={{ margin: "0.45rem 0 0", fontSize: "0.9rem", lineHeight: 1.5, color: "#6b7280" }}>
              Choose how you want to connect and sign transactions on TrustLend.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close wallet selection"
            style={{
              border: "none",
              background: "transparent",
              color: "#6b7280",
              fontSize: "1.25rem",
              cursor: busy ? "not-allowed" : "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "grid", gap: "0.85rem" }}>
          {WALLET_OPTIONS.map((option) => {
            const active = option.provider === selectedProvider;
            return (
              <button
                key={option.provider}
                type="button"
                onClick={() => onSelect(option.provider)}
                disabled={busy}
                style={{
                  textAlign: "left",
                  width: "100%",
                  borderRadius: "1rem",
                  border: active ? "1px solid rgba(126, 47, 208, 0.5)" : "1px solid rgba(17, 24, 39, 0.08)",
                  background: active ? "rgba(126, 47, 208, 0.06)" : "#f9fafb",
                  padding: "1rem",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
                      <strong style={{ fontSize: "1rem", color: "#111827" }}>{option.title}</strong>
                      {active ? (
                        <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#7e2fd0", background: "rgba(126, 47, 208, 0.12)", padding: "0.2rem 0.5rem", borderRadius: "9999px" }}>
                          Selected
                        </span>
                      ) : null}
                    </div>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.87rem", color: "#6b7280", lineHeight: 1.45 }}>
                      {option.description}
                    </p>
                  </div>
                  <span style={{ color: "#9ca3af", fontSize: "1rem" }}>→</span>
                </div>
              </button>
            );
          })}
        </div>

        <p style={{ margin: "1rem 0 0", fontSize: "0.8rem", color: "#6b7280" }}>
          Current default: <strong style={{ color: "#111827" }}>{getWalletProviderLabel(selectedProvider)}</strong>
        </p>
      </div>
    </div>
  );
}
