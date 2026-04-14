"use server";

/**
 * Server Action: Handle KYC document upload
 * Validates user, uploads to Supabase Storage, stores reference in database
 */

import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseClient } from "@/lib/supabase/server";

/** Service-role client that bypasses RLS — only used server-side after identity check */
function getServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function uploadKYCDocument(formData: FormData): Promise<{
  success: boolean;
  path?: string;
  error?: string;
}> {
  try {
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return { success: false, error: "Authentication service unavailable" };
    }

    // Get current user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return { success: false, error: "Not authenticated" };
    }

    // Get file from form
    const file = formData.get("government_id") as File | null;
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Validate file type and size
    const validTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!validTypes.includes(file.type)) {
      return {
        success: false,
        error: "Invalid file type. Please upload JPG, PNG, WebP, or PDF.",
      };
    }

    if (file.size > 10 * 1024 * 1024) {
      // 10MB limit
      return { success: false, error: "File too large. Maximum 10MB allowed." };
    }

    // Ensure kyc-documents bucket exists (using admin client to bypass Storage RLS)
    const admin = getServiceRoleClient();
    if (!admin) {
      console.error("Service role client unavailable");
      return { success: false, error: "Server configuration error. Contact support." };
    }

    const { data: bucketsData } = await admin.storage.listBuckets();
    const bucketExists = bucketsData?.some((b) => b.name === "kyc-documents");

    if (!bucketExists) {
      // If bucket doesn't exist, create it via admin client
      await admin.storage.createBucket("kyc-documents", {
        public: false, // Private bucket; we'll use signed URLs or admin view
      });
      console.log("✅ Created kyc-documents bucket");
    }

    // Create unique file path: /kyc-documents/{userId}/government_id_{timestamp}
    const filename = `government_id_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const filepath = `kyc-documents/${user.id}/${filename}`;

    console.log(`📤 Uploading ${file.name} to Supabase Storage: ${filepath}`);

    // Upload file to Supabase Storage using admin client
    const { data, error: uploadError } = await admin.storage
      .from("kyc-documents")
      .upload(filepath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return { success: false, error: uploadError.message };
    }

    // Get public URL using admin client
    const {
      data: { publicUrl },
    } = admin.storage.from("kyc-documents").getPublicUrl(filepath);

    // Store reference in profiles table (use service role to bypass RLS)
    // Note regarding IPFS: The database schema originally named this column 
    // `government_id_ipfs_hash` planning for future decentralized storage. 
    // Currently, we use it to store the Supabase Storage filepath.

    const { error: updateError } = await admin
      .from("profiles")
      .update({
        government_id_ipfs_hash: filepath,
        government_id_url: publicUrl,
        kyc_status: "submitted",
        kyc_submitted_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateError) {
      console.error("Database update error:", updateError);
      return { success: false, error: "Failed to save document reference" };
    }

    console.log(`✅ KYC document uploaded for user ${user.id}: ${filepath}`);

    return {
      success: true,
      path: filepath,
    };
  } catch (error) {
    console.error("❌ KYC upload failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
}
