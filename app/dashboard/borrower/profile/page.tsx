import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { ProfileSettingsForm } from "@/components/dashboard/ProfileSettingsForm";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getBorrowerDashboardMetrics,
  presentBorrowerMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function BorrowerProfilePage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const { data: profile } = supabase
    ? await supabase
        .from("profiles")
        .select("full_name, phone, role, country_code, kyc_status, risk_status")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null as Record<string, unknown> | null };

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Profile Settings & Verification"
      description="Update your personal details and complete KYC milestones to unlock full platform features."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/profile"
      links={[
        { href: "/dashboard/borrower", label: "Home" },
        { href: "/dashboard/borrower/loans", label: "My loans" },
        { href: "/dashboard/borrower/tasks", label: "Tasks" },
        { href: "/dashboard/borrower/profile", label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-grid workspace-grid--two">
        <article className="workspace-card">
          <h2 className="workspace-card-title">Identity Verification</h2>
          <p className="workspace-card-copy">
            Please provide accurate details to generate an on-chain zero-knowledge compliance certificate.
          </p>
          <ProfileSettingsForm 
            initialName={String(profile?.full_name ?? "")}
            initialPhone={String(profile?.phone ?? "")}
            initialCountry={String(profile?.country_code ?? "")}
          />
        </article>

        <div className="workspace-stack">
          <article className="workspace-card">
            <h2 className="workspace-card-title">Compliance State</h2>
            <div className="workspace-mini-metrics" style={{ marginTop: '1rem', gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <div>
                <span className="wallet-balance-label">KYC Status</span>
                <p style={{ marginTop: '0.2rem', fontWeight: 600 }}>{String(profile?.kyc_status ?? "pending").toUpperCase()}</p>
              </div>
              <div>
                <span className="wallet-balance-label">Risk Profile</span>
                <p style={{ marginTop: '0.2rem', fontWeight: 600 }}>{String(profile?.risk_status ?? "medium").toUpperCase()}</p>
              </div>
            </div>
            <p className="workspace-card-copy" style={{ marginTop: '1rem' }}>
              Your profile data is mapped to a decentralized reputation score. Only verified users can access lending pools.
            </p>
          </article>

          <article className="workspace-card">
            <h2 className="workspace-card-title">Account Security</h2>
            <ul className="workspace-list workspace-list--compact">
              <li>
                <span>Email Address</span>
                <strong>{user.email ?? "Unknown"}</strong>
              </li>
              <li>
                <span>Role</span>
                <strong>{String(profile?.role ?? "borrower")}</strong>
              </li>
              <li>
                <span>Two-Factor Auth</span>
                <span className="wallet-status-indicator wallet-status-active"></span>
              </li>
            </ul>
            <div className="workspace-inline-actions" style={{ marginTop: '1rem' }}>
              <button type="button" className="workspace-nav-link">Change Password</button>
            </div>
          </article>
        </div>
      </div>
    </WorkspaceFrame>
  );
}
