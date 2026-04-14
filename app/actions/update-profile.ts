"use server";

/**
 * Server Action: Update user profile fields
 * Uses getServerSupabaseClient() — authenticated via cookie (anon key + user JWT).
 * The actual DB write uses a service-role client to bypass RLS and avoid
 * WITH CHECK edge-cases, after verifying the caller matches the row id.
 */

import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseClient } from "@/lib/supabase/server";

interface ProfileUpdatePayload {
  full_name: string;
  phone: string;
  date_of_birth?: string;
}

interface ProfileUpdateResult {
  success: boolean;
  error?: string;
}

/**
 * Returns a service-role Supabase client that bypasses RLS entirely.
 * Only used server-side after the caller's identity is verified.
 */
function getServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function updateUserProfile(
  payload: ProfileUpdatePayload
): Promise<ProfileUpdateResult> {
  try {
    // 1. Identify the caller using the cookie-based client (verifies their JWT)
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return { success: false, error: "Authentication service unavailable." };
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { success: false, error: "You must be logged in to update your profile." };
    }

    // 2. Validate required fields
    const name = payload.full_name?.trim() ?? "";
    const phone = payload.phone?.trim() ?? "";

    if (name.length < 2) {
      return { success: false, error: "Full legal name must be at least 2 characters." };
    }
    if (phone.length < 7) {
      return { success: false, error: "Please enter a valid phone number." };
    }

    // 3. Build update object — only columns that exist in profiles
    const updates: Record<string, string> = {
      full_name: name,
      phone: phone,
    };

    if (payload.date_of_birth && payload.date_of_birth.trim() !== "") {
      // Basic date validation (YYYY-MM-DD)
      const dob = new Date(payload.date_of_birth);
      const eighteenYearsAgo = new Date();
      eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);

      if (isNaN(dob.getTime())) {
        return { success: false, error: "Invalid date of birth." };
      }
      if (dob > eighteenYearsAgo) {
        return { success: false, error: "You must be at least 18 years old." };
      }
      updates.date_of_birth = payload.date_of_birth.trim();
    }

    // 4. Write via service-role client (RLS bypass) — safe because we verified caller above
    const admin = getServiceRoleClient();
    if (!admin) {
      return { success: false, error: "Server configuration error. Contact support." };
    }

    const { error: updateError } = await admin
      .from("profiles")
      .update(updates)
      .eq("id", user.id);

    if (updateError) {
      console.error("[TrustLend] Profile update error:", updateError);
      return {
        success: false,
        error: updateError.message ?? "Failed to update profile.",
      };
    }

    console.log(`[TrustLend] Profile updated for user ${user.id}`);
    return { success: true };
  } catch (err) {
    console.error("[TrustLend] updateUserProfile unexpected error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "An unexpected error occurred.",
    };
  }
}
