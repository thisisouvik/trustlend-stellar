"use client";

import { useEffect, useRef } from "react";
import { FocusTrap } from "@/components/ui/FocusTrap";
import {
  getWalletProviderLabel,
  isWalletConnectConfigured,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet-providers";

interface WalletSelectionModalProps {
  open: boolean;
  /** A connection is in flight — options are locked and the modal cannot be dismissed. */
  busy?: boolean;
  selectedProvider: StellarWalletProvider;
  /**
   * Called with the chosen wallet. Callers are expected to close the modal
   * before starting the connection: WalletConnect renders its QR code in its own
   * overlay, which would otherwise stack underneath this one.
   */
  onSelect: (provider: StellarWalletProvider) => void;
  onClose: () => void;
  title?: string;
  description?: string;
}

interface WalletOption {
  provider: StellarWalletProvider;
  title: string;
  description: string;
  /** Shown as a pill next to the name, e.g. to flag the mobile QR flow. */
  badge?: string;
}

const WALLET_OPTIONS: WalletOption[] = [
  {
    provider: "freighter",
    title: "Varial",
    description: "Use the Varial browser extension wallet (formerly Freighter) already supported by TrustLend.",
  },
  {
    provider: "walletconnect",
    title: "WalletConnect",
    description:
      "Scan a QR code with LOBSTR, Varial Mobile, or any other WalletConnect v2 Stellar wallet.",
    badge: "Mobile",
  },
  {
    provider: "xbull",
    title: "xBull",
    description: "Connect through the xBull extension or its web wallet.",
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
  title = "Select a Stellar wallet",
  description = "Choose how you want to connect and sign transactions on TrustLend.",
}: WalletSelectionModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  // WalletConnect needs a project id at build time; without one, surface why the
  // option cannot be used instead of failing after the user clicks it.
  const walletConnectReady = isWalletConnectConfigured();

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !busy) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, busy, onClose]);

  // Return focus to trigger when modal closes
  useEffect(() => {
    if (!open) {
      const trigger = document.querySelector("[data-wallet-select-trigger]") as HTMLElement;
      trigger?.focus();
    } else {
      // Focus first option when modal opens
      setTimeout(() => firstOptionRef.current?.focus(), 0);
    }
  }, [open]);

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
        background: "color-mix(in srgb, var(--fg) 45%, transparent)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <FocusTrap active={true} initialFocusRef={firstOptionRef}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-modal-title"
          aria-describedby="wallet-modal-description"
          onClick={(event) => event.stopPropagation()}
          style={{
            width: "100%",
            maxWidth: "32rem",
            maxHeight: "90vh",
            overflowY: "auto",
            borderRadius: "1.25rem",
            background: "var(--surface)",
            boxShadow: "0 30px 80px color-mix(in srgb, var(--fg) 22%, transparent)",
            border: "1px solid color-mix(in srgb, var(--primary) 12%, transparent)",
            padding: "1.5rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem" }}>
            <div>
              <p style={{ margin: 0, fontSize: "0.78rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--primary)" }}>
                Wallet connection
              </p>
              <h3 id="wallet-modal-title" style={{ margin: "0.35rem 0 0", fontSize: "1.2rem", fontWeight: 800, color: "var(--fg)" }}>
                {title}
              </h3>
              <p id="wallet-modal-description" style={{ margin: "0.45rem 0 0", fontSize: "0.9rem", lineHeight: 1.5, color: "var(--fg-muted)" }}>
                {description}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close wallet selection dialog"
              ref={closeButtonRef}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--fg-muted)",
                fontSize: "1.25rem",
                cursor: busy ? "not-allowed" : "pointer",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>

          <div style={{ display: "grid", gap: "0.85rem" }} role="listbox" aria-label="Available Stellar wallets">
            {WALLET_OPTIONS.map((option, index) => {
              const active = option.provider === selectedProvider;
              const unavailable = option.provider === "walletconnect" && !walletConnectReady;
              const disabled = busy || unavailable;
              return (
                <button
                  key={option.provider}
                  type="button"
                  onClick={() => onSelect(option.provider)}
                  disabled={disabled}
                  role="option"
                  aria-selected={active}
                  ref={index === 0 ? firstOptionRef : undefined}
                  style={{
                    textAlign: "left",
                    width: "100%",
                    borderRadius: "1rem",
                    border: active ? "1px solid color-mix(in srgb, var(--primary) 50%, transparent)" : "1px solid color-mix(in srgb, var(--fg) 8%, transparent)",
                    background: active ? "color-mix(in srgb, var(--primary) 6%, transparent)" : "var(--surface-2)",
                    padding: "1rem",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: unavailable ? 0.55 : 1,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: "1rem", color: "var(--fg)" }}>{option.title}</strong>
                        {option.badge ? (
                          <span style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--accent-hover)", background: "color-mix(in srgb, var(--accent) 14%, transparent)", padding: "0.2rem 0.5rem", borderRadius: "9999px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            {option.badge}
                          </span>
                        ) : null}
                        {active ? (
                          <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)", padding: "0.2rem 0.5rem", borderRadius: "9999px" }}>
                            Selected
                          </span>
                        ) : null}
                      </div>
                      <p style={{ margin: "0.35rem 0 0", fontSize: "0.87rem", color: "var(--fg-muted)", lineHeight: 1.45 }}>
                        {unavailable
                          ? "Unavailable — this deployment has no WalletConnect project id configured."
                          : option.description}
                      </p>
                    </div>
                    <span style={{ color: "var(--fg-subtle)", fontSize: "1rem", whiteSpace: "nowrap" }}>→</span>
                  </div>
                </button>
              );
            })}
          </div>

          <p style={{ margin: "1rem 0 0", fontSize: "0.8rem", color: "var(--fg-muted)" }}>
            Current default: <strong style={{ color: "var(--fg)" }}>{getWalletProviderLabel(selectedProvider)}</strong>
          </p>
        </div>
      </FocusTrap>
    </div>
  );
}
