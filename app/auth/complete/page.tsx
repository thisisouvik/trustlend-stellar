"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  PENDING_ROLE_KEY,
  getDashboardPath,
  isUserRole,
  normalizeUserRole,
  type UserRole,
} from "@/lib/auth/roles";

export default function AuthCompletePage() {
  const router = useRouter();
  const [message, setMessage] = useState("Finishing sign in...");

  useEffect(() => {
    let cancelled = false;

    const isInvalidRefreshTokenError = (value: unknown) => {
      const text = String(value ?? "").toLowerCase();
      return text.includes("invalid refresh token") || text.includes("refresh token not found");
    };

    const completeAuth = async () => {
      const supabase = getBrowserSupabaseClient();
      if (!supabase) {
        if (!cancelled) {
          setMessage("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment.");
        }
        return;
      }

      const pendingRoleRaw =
        typeof window !== "undefined" ? window.localStorage.getItem(PENDING_ROLE_KEY) : null;
      const pendingRole = isUserRole(pendingRoleRaw) ? pendingRoleRaw : null;

      let session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] = null;

      try {
        const { data } = await supabase.auth.getSession();
        session = data.session;
      } catch (error) {
        if (isInvalidRefreshTokenError(error)) {
          await supabase.auth.signOut({ scope: "local" });
          if (!cancelled) {
            setMessage("Session expired. Redirecting back to sign in...");
            router.replace("/auth");
          }
          return;
        }

        if (!cancelled) {
          setMessage("Unable to complete sign in. Please try again.");
          router.replace("/auth");
        }
        return;
      }

      if (!session) {
        if (!cancelled) {
          setMessage("No active session found. Redirecting back to home...");
          router.replace("/");
        }
        return;
      }

      let role: UserRole = normalizeUserRole(session.user.user_metadata?.account_type);

      if (!isUserRole(session.user.user_metadata?.account_type) && pendingRole) {
        const { error } = await supabase.auth.updateUser({
          data: {
            ...session.user.user_metadata,
            account_type: pendingRole,
          },
        });

        if (error) {
          if (!cancelled) {
            setMessage(error.message);
          }
          return;
        }

        role = pendingRole;
      }

      if (typeof window !== "undefined") {
        window.localStorage.removeItem(PENDING_ROLE_KEY);
      }

      if (!cancelled) {
        router.replace(getDashboardPath(role));
      }
    };

    void completeAuth();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="role-dashboard-shell">
      <p className="role-loading">{message}</p>
    </main>
  );
}
