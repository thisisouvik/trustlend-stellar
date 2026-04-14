"use client";

import { useEffect, useCallback, useState } from "react";
import { Loader2, ShieldCheck, AlertCircle, Rocket } from "lucide-react";
import { ReputationContract } from "@/lib/contracts";

interface SorobanProfileCardProps {
  walletAddress: string | null;
}

export function SorobanProfileCard({ walletAddress }: SorobanProfileCardProps) {
  const [profileExists, setProfileExists] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState(false);

  const checkProfile = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const exists = await ReputationContract.hasProfile(walletAddress, walletAddress);
      setProfileExists(exists);
    } catch (err) {
      console.error("[TrustLend] Failed to check on-chain profile:", err);
      // We don't set error here to avoid blocking UI with noise
    }
  }, [walletAddress]);

  useEffect(() => {
    if (walletAddress) {
      checkProfile();
    }
  }, [walletAddress, checkProfile]);

  const handleInitialize = async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      await ReputationContract.initBorrowerProfile(walletAddress);
      setTxSuccess(true);
      setProfileExists(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize profile");
    } finally {
      setLoading(false);
    }
  };

  if (!walletAddress) return null;

  if (profileExists === true) {
    return (
      <article className="workspace-card" style={{ border: "1px solid rgba(34, 207, 157, 0.2)", background: "rgba(34, 207, 157, 0.02)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem" }}>
          <div style={{ background: "rgba(34, 207, 157, 0.1)", padding: "0.6rem", borderRadius: "0.5rem", color: "#22cf9d" }}>
            <ShieldCheck size={20} />
          </div>
          <div>
            <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.25rem" }}>Stellar Profile Active</h3>
            <p style={{ fontSize: "0.85rem", opacity: 0.7, lineHeight: 1.5 }}>
              Your borrower reputation is now being tracked on the Stellar network. Repay loans on time to build your score.
            </p>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="workspace-card" style={{ border: "1px solid rgba(126, 47, 208, 0.2)", background: "rgba(126, 47, 208, 0.02)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem" }}>
        <div style={{ background: "rgba(126, 47, 208, 0.1)", padding: "0.6rem", borderRadius: "0.5rem", color: "#7e2fd0" }}>
          <Rocket size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.25rem" }}>Initialize On-Chain Profile</h3>
          <p style={{ fontSize: "0.85rem", opacity: 0.7, lineHeight: 1.5, marginBottom: "1rem" }}>
            Your wallet is connected, but your reputation profile hasn&apos;t been created on Stellar yet. 
            This is required to apply for micro-loans.
          </p>

          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#ff6b6b", fontSize: "0.75rem", marginBottom: "0.75rem" }}>
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          <button 
            onClick={handleInitialize}
            disabled={loading}
            className="workspace-button workspace-button--primary"
            style={{ height: "auto", padding: "0.6rem 1rem", fontSize: "0.85rem" }}
          >
            {loading ? (
              <>
                <Loader2 size={14} className="animate-spin" style={{ marginRight: "0.5rem" }} />
                Initializing...
              </>
            ) : "Create On-Chain Profile"}
          </button>
        </div>
      </div>
    </article>
  );
}
