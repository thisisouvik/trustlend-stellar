import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { ProfileSettingsForm } from "@/components/dashboard/ProfileSettingsForm";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

const KYC_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; icon: string; description: string }
> = {
  pending:   { label: "Pending",       color: "#d97706", bg: "rgba(217,119,6,0.08)",     icon: "⏳", description: "Submit your details to begin lender compliance review." },
  submitted: { label: "Under Review",  color: "#7e2fd0", bg: "rgba(126,47,208,0.08)",    icon: "🔍", description: "Documents under review. Usually takes 1–2 business days." },
  verified:  { label: "Verified",      color: "#16a07a", bg: "rgba(34,207,157,0.08)",    icon: "✅", description: "Fully verified. You can create and manage lending pools." },
  rejected:  { label: "Action Needed", color: "#dc2626", bg: "rgba(220,38,38,0.08)",     icon: "❌", description: "Submission rejected. Re-upload a clear government ID." },
};

export default async function LenderProfilePage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const { data: profile } = supabase
    ? await supabase
        .from("profiles")
        .select("full_name, phone, date_of_birth, role, kyc_status, risk_status, government_id_url, kyc_submitted_at")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null as Record<string, unknown> | null };

  const kycStatusKey = String(profile?.kyc_status ?? "pending") as keyof typeof KYC_CONFIG;
  const kycInfo = KYC_CONFIG[kycStatusKey] ?? KYC_CONFIG.pending;
  const hasGovId = Boolean(profile?.government_id_url || profile?.kyc_submitted_at);

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
        { href: "/dashboard/lender",          label: "Home" },
        { href: "/dashboard/lender/pools",    label: "Pools" },
        { href: "/dashboard/lender/portfolio", label: "Portfolio" },
        { href: "/dashboard/lender/risk",     label: "Risk" },
        { href: "/dashboard/lender/profile",  label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-grid workspace-grid--two">
        <article className="workspace-card">
          <h2 className="workspace-card-title">Identity Verification</h2>
          <p className="workspace-card-copy" style={{ marginTop: "0.35rem", marginBottom: "1rem" }}>
            Provide accurate details to generate your on-chain KYC certificate for lender compliance.
          </p>
          <ProfileSettingsForm
            initialName={String(profile?.full_name ?? "")}
            initialPhone={String(profile?.phone ?? "")}
            initialDob={profile?.date_of_birth ? String(profile.date_of_birth) : ""}
            kycStatus={kycStatusKey}
            hasGovId={hasGovId}
          />
        </article>

        <div className="workspace-stack">
          {/* Compliance State */}
          <article className="workspace-card">
            <h2 className="workspace-card-title" style={{ marginBottom: "1rem" }}>
              Compliance Status
            </h2>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.85rem",
                padding: "1rem",
                borderRadius: "0.75rem",
                background: kycInfo.bg,
                border: `1px solid ${kycInfo.color}30`,
                marginBottom: "1rem",
              }}
            >
              <span style={{ fontSize: "1.4rem", lineHeight: 1 }}>{kycInfo.icon}</span>
              <div>
                <p style={{ fontSize: "0.8rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: kycInfo.color, marginBottom: "0.2rem" }}>
                  KYC · {kycInfo.label}
                </p>
                <p style={{ fontSize: "0.82rem", color: "#4b5563", lineHeight: 1.5 }}>
                  {kycInfo.description}
                </p>
                {profile?.kyc_submitted_at && (
                  <p style={{ fontSize: "0.75rem", color: "#9ca3af", marginTop: "0.35rem" }}>
                    Submitted: {new Date(String(profile.kyc_submitted_at)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                )}
              </div>
            </div>
            
            <div style={{ padding: "0.85rem", borderRadius: "0.5rem", background: "rgba(126, 47, 208, 0.04)", border: "1px dashed rgba(126, 47, 208, 0.3)", marginBottom: "1rem" }}>
              <p style={{ fontSize: "0.75rem", fontWeight: 700, color: "#7e2fd0", textTransform: "uppercase", marginBottom: "0.2rem" }}>🚀 Upcoming Security Feature</p>
              <p style={{ fontSize: "0.78rem", color: "#64719a", lineHeight: 1.5 }}>
                <strong>Live Facial Recognition</strong> is coming soon. Once deployed, biometric hashes will strictly enforce a "one person, one account" rule to dramatically harden network security and prevent identity fraud.
              </p>
            </div>

            <p style={{ fontSize: "0.78rem", color: "#9ca3af", lineHeight: 1.6, padding: "0.75rem", borderRadius: "0.5rem", background: "rgba(34,207,157,0.03)", border: "1px solid rgba(34,207,157,0.1)" }}>
              🔗 Lender reputation is anchored on the Stellar testnet. Verified lenders unlock higher pool deposit limits.
            </p>
          </article>

          {/* Account Security */}
          <article className="workspace-card">
            <h2 className="workspace-card-title" style={{ marginBottom: "1rem" }}>
              Account Security
            </h2>
            <ul className="workspace-list workspace-list--compact">
              <li>
                <span>Email Address</span>
                <strong style={{ fontSize: "0.85rem", wordBreak: "break-all" }}>{user.email ?? "Unknown"}</strong>
              </li>
              <li>
                <span>Role</span>
                <span style={{ fontSize: "0.75rem", background: "rgba(34,207,157,0.08)", color: "#16a07a", padding: "0.2rem 0.6rem", borderRadius: "999px", fontWeight: 600, textTransform: "capitalize" }}>
                  {String(profile?.role ?? "lender")}
                </span>
              </li>
              <li>
                <span>Email Verified</span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", color: user.email_confirmed_at ? "#16a07a" : "#d97706", fontWeight: 600 }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: user.email_confirmed_at ? "#22cf9d" : "#f59e0b", display: "inline-block" }} />
                  {user.email_confirmed_at ? "Verified" : "Not verified"}
                </span>
              </li>
              <li>
                <span>Member Since</span>
                <strong style={{ fontSize: "0.82rem" }}>
                  {user.created_at ? new Date(user.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "—"}
                </strong>
              </li>
            </ul>
            <div className="workspace-inline-actions" style={{ marginTop: "1rem" }}>
              <button type="button" className="workspace-nav-link">Change Password</button>
            </div>
          </article>
        </div>
      </div>
    </WorkspaceFrame>
  );
}
