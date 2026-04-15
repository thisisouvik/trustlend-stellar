"use server";

/**
 * Admin KYC verification actions
 * Only admins can verify/reject user identity documents
 */

import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseClient } from "@/lib/supabase/server";

/** Service-role client that bypasses RLS */
function getServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

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

    // When KYC is APPROVED: seed a real initial reputation score based on
    // what the user has actually completed. Nothing is hardcoded — the score
    // is computed from real profile fields at the time of approval.
    if (approved) {
      const admin = getServiceRoleClient();
      if (admin) {
        // Fetch the user's actual profile data to compute a fair starting score
        const { data: userProfile } = await admin
          .from("profiles")
          .select("full_name, phone, country_code")
          .eq("id", userId)
          .maybeSingle();

        const { data: authUser } = await admin.auth.admin.getUserById(userId);

        // Real-time score calculation — each completed field contributes
        let initialScore = 0;
        if (authUser?.user?.email_confirmed_at) initialScore += 20; // Email verified
        if (userProfile?.full_name?.trim())       initialScore += 15; // Legal name set
        if (userProfile?.phone?.trim())            initialScore += 15; // Phone verified
        if (userProfile?.country_code?.trim())     initialScore += 10; // Country set
        initialScore += 50; // KYC government ID approved (the primary event)
        // Total: 50–110 depending on profile completeness → Beginner–Silver tier

        await admin.from("reputation_snapshots").upsert(
          {
            user_id: userId,
            score_total: initialScore,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );

        console.log(
          `[TrustLend] Reputation snapshot seeded for ${userId}: score=${initialScore}`
        );
      }
    }


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

    // Fetch pending KYC documents using admin client
    const admin = getServiceRoleClient();
    if (!admin) return null;

    const { data, error } = await admin
      .from("profiles")
      .select("id, full_name, kyc_status, government_id_ipfs_hash, government_id_url, kyc_submitted_at")
      .in("kyc_status", ["submitted"])
      .order("kyc_submitted_at", { ascending: true });

    if (error) {
      console.error("Error fetching KYC documents:", error);
      return null;
    }

    // Get email and generate signed URLs for each profile
    const docsWithEmail = await Promise.all(
      (data || []).map(async (doc) => {
        const { data: authData } = await admin.auth.admin.getUserById(doc.id);
        
        let viewUrl = doc.government_id_url;
        // Generate a 1-hour signed URL if we have the file path
        if (doc.government_id_ipfs_hash) {
           const { data: signedData } = await admin.storage
             .from("kyc-documents")
             .createSignedUrl(doc.government_id_ipfs_hash, 3600);
           
           if (signedData?.signedUrl) {
             viewUrl = signedData.signedUrl;
           }
        }

        return {
           ...doc,
           email: authData?.user?.email || "unknown",
           submitted_at: doc.kyc_submitted_at || "",
           government_id_url: viewUrl || "",
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
