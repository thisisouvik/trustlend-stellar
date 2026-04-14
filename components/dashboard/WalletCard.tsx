"use client";

import { getAddress, getNetworkDetails, isConnected, requestAccess } from "@stellar/freighter-api";
import { useEffect, useMemo, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/formatting";
import { STELLAR_TESTNET } from "@/lib/stellar/testnet";

interface WalletCardProps {
  address: string | null;
  available: number;
  inLoansOrPools: number;
  pending: number;
  inLoansLabel?: string;
  compact?: boolean;
}

export function WalletCard({
  address,
  available,
  inLoansOrPools,
  pending,
  inLoansLabel = "In Loans",
  compact = false,
}: WalletCardProps) {
  const [walletAddress, setWalletAddress] = useState<string | null>(address);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    setWalletAddress(address);
  }, [address]);

  const isWalletConnected = Boolean(walletAddress);
  const isConnectedState = isWalletConnected || isBusy;

  const loadWalletBalance = async (targetAddress: string) => {
    const horizonUrl = process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? STELLAR_TESTNET.horizonUrl;
    const response = await fetch(`${horizonUrl}/accounts/${targetAddress}`);

    if (!response.ok) {
      throw new Error("Unable to fetch wallet balance from Horizon.");
    }

    const payload = await response.json() as {
      balances?: Array<{ asset_type?: string; balance?: string }>;
    };

    const nativeAsset = payload.balances?.find((item) => item.asset_type === "native");
    const nativeBalance = Number(nativeAsset?.balance ?? 0);
    setWalletBalance(Number.isFinite(nativeBalance) ? nativeBalance : 0);
  };

  const persistWalletAddress = async (nextAddress: string | null) => {
    const supabase = getBrowserSupabaseClient();
    if (!supabase) {
      return;
    }

    const { data } = await supabase.auth.getSession();
    const session = data.session;

    if (!session) {
      return;
    }

    const nextMetadata = {
      ...session.user.user_metadata,
      wallet_address: nextAddress,
      wallet_network: "stellar-testnet",
    };

    const { error } = await supabase.auth.updateUser({ data: nextMetadata });

    if (error) {
      throw new Error(error.message);
    }
  };

  const connectWallet = async () => {
    setIsBusy(true);
    setWalletError(null);

    try {
      const connectionStatus = await isConnected();
      if (connectionStatus.error) {
        throw new Error("Freighter wallet was not detected in this browser.");
      }

      const networkDetails = await getNetworkDetails();
      if (networkDetails.error) {
        throw new Error(networkDetails.error.message ?? "Unable to read wallet network details.");
      }

      if (networkDetails.networkPassphrase !== STELLAR_TESTNET.networkPassphrase) {
        throw new Error("Switch Freighter to Stellar Testnet and try again.");
      }

      const access = await requestAccess();
      if (access.error) {
        throw new Error(access.error.message ?? "Wallet access request was declined.");
      }

      const connectedAddress = access.address || (await getAddress()).address;

      if (!connectedAddress) {
        throw new Error("Freighter did not return a public address.");
      }

      setWalletAddress(connectedAddress);
      await loadWalletBalance(connectedAddress);
      await persistWalletAddress(connectedAddress);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Failed to connect wallet.");
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
      await persistWalletAddress(null);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Failed to disconnect wallet.");
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
      setWalletError(error instanceof Error ? error.message : "Failed to load wallet balance.");
    });
  }, [walletAddress]);

  const handleWalletAction = () => {
    if (isWalletConnected) {
      void disconnectWallet();
      return;
    }

    void connectWallet();
  };

  const walletConnected = isWalletConnected;
  const displayedAvailable = walletBalance ?? available;
  const shortAddress = useMemo(() => {
    if (!walletAddress) return "No wallet connected";
    return `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
  }, [walletAddress]);

  if (compact) {
    return (
      <article className="wallet-card-shell wallet-card-shell--compact">
        <div className="wallet-card-compact-head">
          <div className="wallet-card-topcopy">
            <span className={`wallet-status-indicator ${isConnectedState ? "wallet-status-active" : "wallet-status-inactive"}`} aria-hidden="true" />
            <div>
              <p className="wallet-card-title">Wallet {walletConnected ? "Connected" : "Not Connected"}</p>
              <p className="wallet-card-subtitle">Address {shortAddress}</p>
            </div>
          </div>
          <button type="button" className="wallet-card-action" onClick={handleWalletAction} disabled={isBusy} suppressHydrationWarning>
            {isBusy ? "Please wait..." : walletConnected ? "Disconnect" : "Connect Wallet"}
          </button>
        </div>

        <div className="wallet-card-compact-metrics">
          <div className="wallet-card-compact-metric">
            <span>Available</span>
            <strong>{formatCurrency(displayedAvailable)}</strong>
          </div>
          <div className="wallet-card-compact-metric">
            <span>{inLoansLabel}</span>
            <strong>{formatCurrency(inLoansOrPools)}</strong>
          </div>
          <div className="wallet-card-compact-metric">
            <span>Pending</span>
            <strong>{formatCurrency(pending)}</strong>
          </div>
        </div>

        {walletError ? <p className="wallet-card-subtitle">{walletError}</p> : null}
      </article>
    );
  }

  return (
    <article className="wallet-card-shell">
      <div className="wallet-card-top">
        <div className="wallet-card-topcopy">
          <span className={`wallet-status-indicator ${isConnectedState ? "wallet-status-active" : "wallet-status-inactive"}`} aria-hidden="true" />
          <div>
            <p className="wallet-card-title">Wallet {walletConnected ? "Connected" : "Not Connected"}</p>
            <p className="wallet-card-subtitle">{shortAddress}</p>
          </div>
        </div>
        <button type="button" className="wallet-card-action" onClick={handleWalletAction} disabled={isBusy} suppressHydrationWarning>
          {isBusy ? "Please wait..." : walletConnected ? "Disconnect" : "Connect Wallet"}
        </button>
      </div>

      <div className="wallet-card-addressline">
        <span className="wallet-card-addresslabel">Wallet address</span>
        <span className="wallet-card-addressvalue">{shortAddress}</span>
      </div>

      <div className="wallet-card-grid">
        <div className="wallet-card-metric">
          <span>Available Balance</span>
          <strong>{formatCurrency(displayedAvailable)}</strong>
        </div>
        <div className="wallet-card-metric">
          <span>{inLoansLabel}</span>
          <strong>{formatCurrency(inLoansOrPools)}</strong>
        </div>
        <div className="wallet-card-metric">
          <span>Pending</span>
          <strong>{formatCurrency(pending)}</strong>
        </div>
      </div>

      {walletError ? <p className="wallet-card-subtitle" style={{ marginTop: "0.65rem" }}>{walletError}</p> : null}
    </article>
  );
}
