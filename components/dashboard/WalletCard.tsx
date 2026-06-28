"use client";

import { useEffect, useMemo, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/formatting";
import { STELLAR_TESTNET } from "@/lib/stellar/testnet";
import {
  connectWallet,
  getStoredWalletProvider,
  getWalletProviderLabel,
  setStoredWalletProvider,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet";
import { WalletSelectionModal } from "@/components/dashboard/WalletSelectionModal";

interface WalletCardProps {
  address: string | null;
  available: number;
  inLoansOrPools: number;
  pending: number;
  inLoansLabel?: string;
  pendingLabel?: string;
  compact?: boolean;
  inLoansIsCurrency?: boolean;
  pendingIsCurrency?: boolean;
}

export function WalletCard({
  address,
  available,
  inLoansOrPools,
  pending,
  inLoansLabel = "In Loans",
  pendingLabel = "Pending",
  compact = false,
  inLoansIsCurrency = true,
  pendingIsCurrency = true,
}: WalletCardProps) {
  const [walletAddress, setWalletAddress] = useState<string | null>(address);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] =
    useState<StellarWalletProvider>("freighter");
  const [showWalletSelection, setShowWalletSelection] = useState(false);

  useEffect(() => {
    setWalletAddress(address);
  }, [address]);

  useEffect(() => {
    setSelectedProvider(getStoredWalletProvider());
  }, []);

  const isWalletConnected = Boolean(walletAddress);
  const isConnectedState = isWalletConnected || isBusy;

  const loadWalletBalance = async (targetAddress: string) => {
    const horizonUrl =
      process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? STELLAR_TESTNET.horizonUrl;
    const response = await fetch(`${horizonUrl}/accounts/${targetAddress}`);

    if (!response.ok) {
      throw new Error("Unable to fetch wallet balance from Horizon.");
    }

    const payload = (await response.json()) as {
      balances?: Array<{ asset_type?: string; balance?: string }>;
    };

    const nativeAsset = payload.balances?.find(
      (item) => item.asset_type === "native",
    );
    const nativeBalance = Number(nativeAsset?.balance ?? 0);
    setWalletBalance(Number.isFinite(nativeBalance) ? nativeBalance : 0);
  };

  const persistWalletAddress = async (
    nextAddress: string | null,
    provider: StellarWalletProvider | null,
  ) => {
    const supabase = getBrowserSupabaseClient();
    if (!supabase) return;

    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return;

    const nextMetadata = {
      ...session.user.user_metadata,
      wallet_address: nextAddress,
      wallet_network: nextAddress ? "stellar-testnet" : null,
      wallet_provider: provider,
    };
    const { error: authErr } = await supabase.auth.updateUser({
      data: nextMetadata,
    });
    if (authErr) throw new Error(authErr.message);

    const { error: profileErr } = await supabase
      .from("profiles")
      .update({ wallet_address: nextAddress })
      .eq("id", session.user.id);

    if (profileErr) {
      console.warn("profiles wallet_address sync failed:", profileErr.message);
    }

    if (nextAddress) {
      window.localStorage.setItem("wallet_address", nextAddress);
    } else {
      window.localStorage.removeItem("wallet_address");
    }

    setStoredWalletProvider(provider);
  };

  const connectSelectedWallet = async (provider: StellarWalletProvider) => {
    setIsBusy(true);
    setWalletError(null);

    try {
      const connectedWallet = await connectWallet(provider);
      setSelectedProvider(connectedWallet.provider);
      setWalletAddress(connectedWallet.address);
      await loadWalletBalance(connectedWallet.address);
      await persistWalletAddress(
        connectedWallet.address,
        connectedWallet.provider,
      );
      setShowWalletSelection(false);
    } catch (error) {
      setWalletError(
        error instanceof Error ? error.message : "Failed to connect wallet.",
      );
    } finally {
      setIsBusy(false);
    }
  };

  const disconnectWallet = async () => {
    setIsBusy(true);
    setWalletError(null);

    try {
      setWalletAddress(null);
      setWalletBalance(null);
      await persistWalletAddress(null, null);
    } catch (error) {
      setWalletError(
        error instanceof Error ? error.message : "Failed to disconnect wallet.",
      );
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (!walletAddress) {
      setWalletBalance(null);
      return;
    }

    void loadWalletBalance(walletAddress).catch((error) => {
      setWalletError(
        error instanceof Error
          ? error.message
          : "Failed to load wallet balance.",
      );
    });
  }, [walletAddress]);

  const handleWalletAction = () => {
    if (isWalletConnected) {
      void disconnectWallet();
      return;
    }

    setShowWalletSelection(true);
  };

  const walletConnected = isWalletConnected;
  const displayedAvailable = walletBalance ?? available;
  const shortAddress = useMemo(() => {
    if (!walletAddress) return "No wallet connected";
    return `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
  }, [walletAddress]);
  const walletProviderLabel = getWalletProviderLabel(selectedProvider);

  if (compact) {
    return (
      <>
        <WalletSelectionModal
          open={showWalletSelection}
          busy={isBusy}
          selectedProvider={selectedProvider}
          onSelect={(provider) => void connectSelectedWallet(provider)}
          onClose={() => setShowWalletSelection(false)}
        />
        <article className="wallet-card-shell wallet-card-shell--compact">
          <div className="wallet-card-compact-head">
            <div className="wallet-card-topcopy">
              <span
                className={`wallet-status-indicator ${isConnectedState ? "wallet-status-active" : "wallet-status-inactive"}`}
                aria-hidden="true"
              />
              <div>
                <p className="wallet-card-title">
                  Wallet {walletConnected ? "Connected" : "Not Connected"}
                </p>
                <p className="wallet-card-subtitle">
                  {walletConnected
                    ? `${walletProviderLabel} · ${shortAddress}`
                    : shortAddress}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="wallet-card-action"
              onClick={handleWalletAction}
              disabled={isBusy}
              suppressHydrationWarning
            >
              {isBusy
                ? "Please wait..."
                : walletConnected
                  ? "Disconnect"
                  : "Connect Wallet"}
            </button>
          </div>

          <div className="wallet-card-compact-metrics">
            <div className="wallet-card-compact-metric">
              <span>Available</span>
              <strong>{formatCurrency(displayedAvailable)}</strong>
            </div>
            <div className="wallet-card-compact-metric">
              <span>{inLoansLabel}</span>
              <strong>
                {inLoansIsCurrency
                  ? formatCurrency(inLoansOrPools)
                  : inLoansOrPools}
              </strong>
            </div>
            <div className="wallet-card-compact-metric">
              <span>{pendingLabel}</span>
              <strong>
                {pendingIsCurrency ? formatCurrency(pending) : pending}
              </strong>
            </div>
          </div>

          {walletError ? (
            <p className="wallet-card-subtitle">{walletError}</p>
          ) : null}
        </article>
      </>
    );
  }

  return (
    <>
      <WalletSelectionModal
        open={showWalletSelection}
        busy={isBusy}
        selectedProvider={selectedProvider}
        onSelect={(provider) => void connectSelectedWallet(provider)}
        onClose={() => setShowWalletSelection(false)}
      />
      <article className="wallet-card-shell">
        <div className="wallet-card-top">
          <div className="wallet-card-topcopy">
            <span
              className={`wallet-status-indicator ${isConnectedState ? "wallet-status-active" : "wallet-status-inactive"}`}
              aria-hidden="true"
            />
            <div>
              <p className="wallet-card-title">
                Wallet {walletConnected ? "Connected" : "Not Connected"}
              </p>
              <p className="wallet-card-subtitle">
                {walletConnected
                  ? `${walletProviderLabel} · ${shortAddress}`
                  : shortAddress}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="wallet-card-action"
            onClick={handleWalletAction}
            disabled={isBusy}
            suppressHydrationWarning
          >
            {isBusy
              ? "Please wait..."
              : walletConnected
                ? "Disconnect"
                : "Connect Wallet"}
          </button>
        </div>

        <div className="wallet-card-addressline">
          <span className="wallet-card-addresslabel">Wallet address</span>
          <span className="wallet-card-addressvalue">{shortAddress}</span>
        </div>

        <div
          style={{
            marginBottom: "0.9rem",
            fontSize: "0.82rem",
            color: "#6b7280",
          }}
        >
          Selected wallet provider:{" "}
          <strong style={{ color: "#111827" }}>{walletProviderLabel}</strong>
        </div>

        <div className="wallet-card-grid">
          <div className="wallet-card-metric">
            <span>Available Balance</span>
            <strong>{formatCurrency(displayedAvailable)}</strong>
          </div>
          <div className="wallet-card-metric">
            <span>{inLoansLabel}</span>
            <strong>
              {inLoansIsCurrency
                ? formatCurrency(inLoansOrPools)
                : inLoansOrPools}
            </strong>
          </div>
          <div className="wallet-card-metric">
            <span>{pendingLabel}</span>
            <strong>
              {pendingIsCurrency ? formatCurrency(pending) : pending}
            </strong>
          </div>
        </div>

        {walletError ? (
          <p className="wallet-card-subtitle" style={{ marginTop: "0.65rem" }}>
            {walletError}
          </p>
        ) : null}
      </article>
    </>
  );
}
