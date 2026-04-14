import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function getServerSupabaseClient(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bypassEnabled = process.env.ENABLE_DEV_AUTH_BYPASS === "true";

  if (!url || (!anonKey && !(bypassEnabled && serviceRoleKey))) {
    return null;
  }

  // Optional dev-only privileged client for deterministic API testing.
  if (bypassEnabled && serviceRoleKey) {
    return createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  if (!anonKey) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components can run in contexts where setting cookies is not allowed.
        }
      },
    },
  });
}