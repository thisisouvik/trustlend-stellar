import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { ProfileSettingsForm } from "@/components/dashboard/ProfileSettingsForm";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function LenderProfilePage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);

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
      roleLabel="Lender Dashboard"
      heading="Profile Settings & Security"
      description="Update your personal details and complete required compliance checks to manage lending pools."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/profile"
      links={[
        { href: "/dashboard/lender", label: "Home" },
        { href: "/dashboard/lender/pools", label: "Pools" },
        { href: "/dashboard/lender/portfolio", label: "Portfolio" },
        { href: "/dashboard/lender/risk", label: "Risk" },
        { href: "/dashboard/lender/profile", label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-grid workspace-grid--two">
        <article className="workspace-card">
          <h2 className="workspace-card-title">Identity Verification</h2>
          <p className="workspace-card-copy">
            Please provide accurate details to generate an on-chain zero-knowledge compliance certificate for lenders.
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
            <div className="profile-summary-grid">
              <div className="profile-summary-item">
                <span className="profile-summary-label">KYC Status</span>
                <p className="profile-summary-value">
                  {String(profile?.kyc_status ?? "pending").toUpperCase()}
                  {profile?.kyc_status === "verified" ? (
                    <span style={{ marginLeft: "0.5rem", color: "#10b981", fontSize: "1.1rem" }}>✅</span>
                  ) : null}
                </p>
              </div>
              <div className="profile-summary-item">
                <span className="profile-summary-label">Risk Profile</span>
                <p className="profile-summary-value">{String(profile?.risk_status ?? "low").toUpperCase()}</p>
              </div>
            </div>
            <p className="workspace-card-copy profile-note">
              Your profile data unlocks higher deposit limits and verified status in decentralized lending operations.
            </p>
          </article>

          <article className="workspace-card">
            <h2 className="workspace-card-title">Account Security</h2>
            <div className="profile-security-list">
              <div className="profile-security-row">
                <span className="profile-security-label">Email Address</span>
                <strong className="profile-security-value">{user.email ?? "Unknown"}</strong>
              </div>
              <div className="profile-security-row">
                <span className="profile-security-label">Role</span>
                <strong className="profile-security-value">{String(profile?.role ?? "lender")}</strong>
              </div>
              <div className="profile-security-row">
                <span className="profile-security-label">Two-Factor Auth</span>
                <span className="profile-security-dot wallet-status-indicator wallet-status-active" />
              </div>
            </div>
            <div className="workspace-inline-actions profile-security-actions">
              <button type="button" className="workspace-nav-link">Change Password</button>
            </div>
          </article>
        </div>
      </div>
    </WorkspaceFrame>
  );
}
