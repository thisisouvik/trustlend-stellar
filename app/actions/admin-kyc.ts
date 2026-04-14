"use server";

/**
 * Admin KYC verification actions
 * Only admins can verify/reject user identity documents
 */

import { getServerSupabaseClient } from "@/lib/supabase/server";

export async function verifyKYCDocument(
  userId: string,
  approved: boolean,
  rejectionReason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return { success: false, error: "Supabase not available" };
    }

    // Verify admin status
    const { data: adminUser, error: authError } = await supabase.auth.getUser();
    if (authError || !adminUser?.user) {
      return { success: false, error: "Not authenticated" };
    }

    // Check if requester is admin
    const { data: adminProfile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", adminUser.user.id)
      .maybeSingle();

    if (adminProfile?.role !== "admin") {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    // Update KYC status
    const updateData = approved
      ? {
          kyc_status: "verified",
          kyc_verified_at: new Date().toISOString(),
          kyc_rejection_reason: null,
        }
      : {
          kyc_status: "rejected",
          kyc_rejection_reason: rejectionReason || "Document does not meet requirements",
        };

    const { error: updateError } = await supabase
      .from("profiles")
      .update(updateData)
      .eq("id", userId);

    if (updateError) throw updateError;

    console.log(
      `✅ KYC ${approved ? "approved" : "rejected"} for user ${userId}`
    );
    return { success: true };
  } catch (error) {
    console.error("❌ KYC verification failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Verification failed",
    };
  }
}

export async function getPendingKYCDocuments(): Promise<
  Array<{
    id: string;
    email: string;
    full_name: string;
    kyc_status: string;
    government_id_url: string;
    submitted_at: string;
  }> | null
> {
  try {
    const supabase = await getServerSupabaseClient();
    if (!supabase) return null;

    // Verify admin
    const { data: adminUser } = await supabase.auth.getUser();
    if (!adminUser?.user) return null;

    const { data: adminProfile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", adminUser.user.id)
      .maybeSingle();

    if (adminProfile?.role !== "admin") return null;

    // Fetch pending KYC documents
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, kyc_status, government_id_url, kyc_submitted_at")
      .in("kyc_status", ["submitted"])
      .order("kyc_submitted_at", { ascending: true });

    if (error) {
      console.error("Error fetching KYC documents:", error);
      return null;
    }

    // Get email for each profile
    const docsWithEmail = await Promise.all(
      (data || []).map(async (doc) => {
        const { data: authData } = await supabase.auth.admin.getUserById(doc.id);
        return {
          ...doc,
          email: authData?.user?.email || "unknown",
          submitted_at: doc.kyc_submitted_at || "",
        };
      })
    );

    return docsWithEmail as Array<{
      id: string;
      email: string;
      full_name: string;
      kyc_status: string;
      government_id_url: string;
      submitted_at: string;
    }>;
  } catch (error) {
    console.error("❌ Failed to fetch KYC documents:", error);
    return null;
  }
}
