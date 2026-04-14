/**
 * KYC (Know Your Customer) verification helpers
 * Manages identity verification status and document storage
 */

import { getServerSupabaseClient } from "@/lib/supabase/server";

export type KYCStatus = "pending" | "submitted" | "verified" | "rejected";

export interface KYCData {
  status: KYCStatus;
  government_id_ipfs_hash?: string;
  government_id_url?: string;
  submitted_at?: string;
  verified_at?: string;
  rejection_reason?: string;
}

/**
 * Store KYC document hash after IPFS upload
 */
export async function storeKYCDocument(
  userId: string,
  ipfsHash: string,
  ipfsUrl: string
): Promise<void> {
  const supabase = await getServerSupabaseClient();
  if (!supabase) throw new Error("Supabase not available");

  const { error } = await supabase
    .from("profiles")
    .update({
      government_id_ipfs_hash: ipfsHash,
      government_id_url: ipfsUrl,
      kyc_status: "submitted",
      kyc_submitted_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) throw error;
}

/**
 * Get KYC data for a user (admin only)
 */
export async function getKYCData(userId: string): Promise<KYCData | null> {
  const supabase = await getServerSupabaseClient();
  if (!supabase) throw new Error("Supabase not available");

  const { data, error } = await supabase
    .from("profiles")
    .select(
      "kyc_status, government_id_ipfs_hash, government_id_url, kyc_submitted_at, kyc_verified_at, kyc_rejection_reason"
    )
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;

  return data
    ? {
        status: data.kyc_status as KYCStatus,
        government_id_ipfs_hash: data.government_id_ipfs_hash,
        government_id_url: data.government_id_url,
        submitted_at: data.kyc_submitted_at,
        verified_at: data.kyc_verified_at,
        rejection_reason: data.kyc_rejection_reason,
      }
    : null;
}

/**
 * Check if user is verified (admin checker)
 */
export async function isUserVerified(userId: string): Promise<boolean> {
  const kycData = await getKYCData(userId);
  return kycData?.status === "verified";
}
