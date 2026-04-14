"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  getDashboardPath,
  isUserRole,
  normalizeUserRole,
  type UserRole,
} from "@/lib/auth/roles";

interface RoleMetric {
  label: string;
  value: string;
}

interface RoleDashboardScreenProps {
  expectedRole: UserRole;
  heading: string;
  description: string;
  metrics: RoleMetric[];
  primaryHref: string;
  primaryLabel: string;
  secondaryHref: string;
  secondaryLabel: string;
}

export function RoleDashboardScreen({
  expectedRole,
  heading,
  description,
  metrics,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: RoleDashboardScreenProps) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const ensureRoleAccess = async () => {
      const supabase = getBrowserSupabaseClient();
      if (!supabase) {
        if (!cancelled) {
          setError("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment.");
        }
        return;
      }

      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        router.replace("/");
        return;
      }

      const metadataRole = session.user.user_metadata?.account_type;
      const roleFromUser = normalizeUserRole(metadataRole);

      if (isUserRole(metadataRole) && roleFromUser !== expectedRole) {
        router.replace(getDashboardPath(roleFromUser));
        return;
      }

      if (!isUserRole(metadataRole)) {
        const { error: updateError } = await supabase.auth.updateUser({
          data: {
            ...session.user.user_metadata,
            account_type: expectedRole,
          },
        });

        if (updateError) {
          if (!cancelled) {
            setError(updateError.message);
          }
          return;
        }
      }

      if (!cancelled) {
        setEmail(session.user.email ?? null);
        setReady(true);
      }
    };

    void ensureRoleAccess();

    return () => {
      cancelled = true;
    };
  }, [expectedRole, router]);

  const handleSignOut = async () => {
    const supabase = getBrowserSupabaseClient();
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
    router.replace("/");
  };

  if (error) {
    return (
      <main className="role-dashboard-shell">
        <p className="role-error">{error}</p>
      </main>
    );
  }

  if (!ready) {
    return (
      <main className="role-dashboard-shell">
        <p className="role-loading">Loading your {expectedRole} workspace...</p>
      </main>
    );
  }

  return (
    <main className="role-dashboard-shell">
      <section className="role-dashboard-card">
        <div className="role-head">
          <div>
            <p className="role-kicker">{expectedRole} dashboard</p>
            <h1 className="font-display role-title">{heading}</h1>
            <p className="role-description">{description}</p>
          </div>
          <button type="button" className="role-signout" onClick={handleSignOut}>
            Sign out
          </button>
        </div>

        <p className="role-email">Signed in as: {email ?? "Unknown"}</p>

        <div className="role-metrics">
          {metrics.map((item) => (
            <article key={item.label} className="role-metric-card">
              <p className="role-metric-value font-display">{item.value}</p>
              <p className="role-metric-label">{item.label}</p>
            </article>
          ))}
        </div>

        <div className="role-actions">
          <Link href={primaryHref} className="role-action-primary">
            {primaryLabel}
          </Link>
          <Link href={secondaryHref} className="role-action-secondary">
            {secondaryLabel}
          </Link>
        </div>
      </section>
    </main>
  );
}
