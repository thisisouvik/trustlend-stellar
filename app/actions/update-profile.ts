"use server";

/**
 * Server Action: Update user profile fields
 * Uses getServerSupabaseClient() — authenticated via cookie (anon key + user JWT).
 * DB writes are done with the caller session and enforced by RLS.
 */

import { getServerSupabaseClient } from "@/lib/supabase/server";

import { z } from "zod";
import sanitizeHtml from "sanitize-html";

const profileSchema = z.object({
  full_name: z.string().min(2, "Full legal name must be at least 2 characters."),
  phone: z.string().min(7, "Please enter a valid phone number."),
  date_of_birth: z.string().optional().refine((val) => {
    if (!val || val.trim() === "") return true;
    const dob = new Date(val);
    const eighteenYearsAgo = new Date();
    eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);
    return !isNaN(dob.getTime()) && dob <= eighteenYearsAgo;
  }, "You must be at least 18 years old and provide a valid date."),
});

// Helper for sanitizing strings
function sanitize(input: string) {
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  });
}

interface ProfileUpdatePayload {
  full_name: string;
  phone: string;
  date_of_birth?: string;
}

interface ProfileUpdateResult {
  success: boolean;
  error?: string;
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

    // 2. Validate fields using Zod
    const validationResult = profileSchema.safeParse(payload);
    if (!validationResult.success) {
      return { 
        success: false, 
        error: validationResult.error.issues[0]?.message || "Invalid input data." 
      };
    }

    const validatedData = validationResult.data;

    // 3. Sanitize inputs to prevent XSS
    const name = sanitize(validatedData.full_name.trim());
    const phone = sanitize(validatedData.phone.trim());

    // 4. Build update object
    const updates: Record<string, string> = {
      full_name: name,
      phone: phone,
    };

    if (validatedData.date_of_birth && validatedData.date_of_birth.trim() !== "") {
      updates.date_of_birth = sanitize(validatedData.date_of_birth.trim());
    }

    // 5. Write with the caller session; RLS restricts updates to the caller row
    const { error: updateError } = await supabase
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
