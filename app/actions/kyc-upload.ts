"use server";

/**
 * Server Action: Handle KYC document upload
 * Validates user, uploads to Supabase Storage, stores reference in database
 */

import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseClient } from "@/lib/supabase/server";

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

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      return { success: false, error: "Supabase is not configured." };
    }

    // Use session token for storage upload so deployment does not require service-role key.
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: session?.access_token
        ? {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
          }
        : undefined,
    });

    // Create unique file path: /kyc-documents/{userId}/government_id_{timestamp}
    const filename = `government_id_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const filepath = `kyc-documents/${user.id}/${filename}`;

    console.log(`📤 Uploading ${file.name} to Supabase Storage: ${filepath}`);

    const { error: uploadError } = await client.storage
      .from("kyc-documents")
      .upload(filepath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return { success: false, error: uploadError.message };
    }

    // Get public URL for the uploaded document path
    const {
      data: { publicUrl },
    } = client.storage.from("kyc-documents").getPublicUrl(filepath);

    // Store reference in profiles table with caller session (RLS-protected)
    // Note regarding IPFS: The database schema originally named this column 
    // `government_id_ipfs_hash` planning for future decentralized storage. 
    // Currently, we use it to store the Supabase Storage filepath.

    const { error: updateError } = await supabase
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
