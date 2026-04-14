import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { ProfileSettingsForm } from "@/components/dashboard/ProfileSettingsForm";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getBorrowerDashboardMetrics,
  presentBorrowerMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

// Compliance status config
const KYC_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; icon: string; description: string }
> = {
  pending: {
    label: "Pending Review",
    color: "#d97706",
    bg: "rgba(217, 119, 6, 0.08)",
    icon: "⏳",
    description: "Submit your details and government ID to start the KYC review.",
  },
  submitted: {
    label: "Under Review",
    color: "#7e2fd0",
    bg: "rgba(126, 47, 208, 0.08)",
    icon: "🔍",
    description: "Your documents are being reviewed by our compliance team. Usually takes 1–2 business days.",
  },
  verified: {
    label: "Verified",
    color: "#16a07a",
    bg: "rgba(34, 207, 157, 0.08)",
    icon: "✅",
    description: "Your identity is verified. You now have full access to lending pools.",
  },
  rejected: {
    label: "Action Required",
    color: "#dc2626",
    bg: "rgba(220, 38, 38, 0.08)",
    icon: "❌",
    description: "Your submission was rejected. Please re-upload a clear, valid government ID.",
  },
};

const RISK_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; dot: string }
> = {
  low:     { label: "Low Risk",     color: "#16a07a", bg: "rgba(34,207,157,0.1)",    dot: "#22cf9d" },
  medium:  { label: "Medium Risk",  color: "#d97706", bg: "rgba(217,119,6,0.1)",     dot: "#f59e0b" },
  high:    { label: "High Risk",    color: "#dc2626", bg: "rgba(220,38,38,0.1)",      dot: "#ef4444" },
  blocked: { label: "Blocked",      color: "#6b7280", bg: "rgba(107,114,128,0.1)",   dot: "#9ca3af" },
};

export default async function BorrowerProfilePage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics = await getBorrowerDashboardMetrics(user.id);

  const supabase = await getServerSupabaseClient();
  const { data: profile } = supabase
    ? await supabase
        .from("profiles")
        .select("full_name, phone, date_of_birth, role, country_code, kyc_status, risk_status, government_id_url, kyc_submitted_at")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null as Record<string, unknown> | null };

  // Compute real profile completion based on actual data
  const checks = [
    { label: "Email confirmed",    done: Boolean(user.email_confirmed_at) },
    { label: "Full name",          done: Boolean(profile?.full_name && String(profile.full_name).trim().length > 1) },
    { label: "Phone number",       done: Boolean(profile?.phone && String(profile.phone).trim().length > 4) },
    { label: "Date of birth",      done: Boolean(profile?.date_of_birth) },
    { label: "Government ID",      done: Boolean(profile?.government_id_url || profile?.kyc_submitted_at) },
  ];

  const completedCount = checks.filter((c) => c.done).length;
  const completionPct = Math.round((completedCount / checks.length) * 100);
  const missingItems = checks.filter((c) => !c.done).map((c) => c.label);

  const kycStatusKey = String(profile?.kyc_status ?? "pending") as keyof typeof KYC_CONFIG;
  const riskStatusKey = String(profile?.risk_status ?? "medium") as keyof typeof RISK_CONFIG;
  const kycInfo  = KYC_CONFIG[kycStatusKey]  ?? KYC_CONFIG.pending;
  const riskInfo = RISK_CONFIG[riskStatusKey] ?? RISK_CONFIG.medium;

  const profileIsComplete = completionPct === 100;
  const hasGovId = Boolean(profile?.government_id_url || profile?.kyc_submitted_at);

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Profile Settings & Verification"
      description="Update your personal details and complete KYC milestones to unlock full platform features."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/profile"
      profilePath="/dashboard/borrower/profile"
      showProfileAlert={!profileIsComplete}
      profileSummary={{
        completion: completionPct,
        kycStatus: kycStatusKey,
        warningText: profileIsComplete
          ? "Your profile is complete. Keep your details up to date."
          : `Complete your profile to unlock borrowing. ${missingItems.length} item${missingItems.length !== 1 ? "s" : ""} remaining.`,
        requiredItems: missingItems,
      }}
      links={[
        { href: "/dashboard/borrower",          label: "Home" },
        { href: "/dashboard/borrower/loans",    label: "My loans" },
        { href: "/dashboard/borrower/tasks",    label: "Tasks" },
        { href: "/dashboard/borrower/profile",  label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-grid workspace-grid--two">
        {/* ── LEFT: Identity Verification Form ── */}
        <article className="workspace-card">
          <div style={{ marginBottom: "1.25rem" }}>
            <h2 className="workspace-card-title">Identity Verification</h2>
            <p className="workspace-card-copy" style={{ marginTop: "0.35rem" }}>
              Provide accurate details to generate your on-chain KYC certificate.
              Required for all loan applications.
            </p>
          </div>

          {/* Completion progress bar */}
          <div
            style={{
              marginBottom: "1.5rem",
              padding: "0.9rem 1rem",
              borderRadius: "0.6rem",
              background: "linear-gradient(135deg, rgba(126,47,208,0.04) 0%, rgba(34,207,157,0.04) 100%)",
              border: "1px solid rgba(126,47,208,0.1)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.5rem",
              }}
            >
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#374151" }}>
                Profile Completion
              </span>
              <span
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 700,
                  color: completionPct === 100 ? "#16a07a" : "#7e2fd0",
                }}
              >
                {completionPct}%
              </span>
            </div>
            <div
              style={{
                height: "6px",
                borderRadius: "3px",
                background: "#e5e7eb",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${completionPct}%`,
                  background:
                    completionPct === 100
                      ? "linear-gradient(90deg, #16a07a 0%, #22cf9d 100%)"
                      : "linear-gradient(90deg, #7e2fd0 0%, #22cf9d 100%)",
                  transition: "width 0.4s ease",
                  borderRadius: "3px",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.4rem",
                marginTop: "0.65rem",
              }}
            >
              {checks.map((c) => (
                <span
                  key={c.label}
                  style={{
                    fontSize: "0.72rem",
                    padding: "0.2rem 0.5rem",
                    borderRadius: "999px",
                    background: c.done
                      ? "rgba(34,207,157,0.1)"
                      : "rgba(107,114,128,0.08)",
                    color: c.done ? "#16a07a" : "#6b7280",
                    fontWeight: 500,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.25rem",
                  }}
                >
                  {c.done ? "✓" : "○"} {c.label}
                </span>
              ))}
            </div>
          </div>

          <ProfileSettingsForm
            initialName={String(profile?.full_name ?? "")}
            initialPhone={String(profile?.phone ?? "")}
            initialDob={profile?.date_of_birth ? String(profile.date_of_birth) : ""}
            kycStatus={kycStatusKey}
            hasGovId={hasGovId}
          />
        </article>

        {/* ── RIGHT: Compliance + Security ── */}
        <div className="workspace-stack">
          {/* Compliance State */}
          <article className="workspace-card">
            <h2 className="workspace-card-title" style={{ marginBottom: "1rem" }}>
              Compliance Status
            </h2>

            {/* KYC Status Badge */}
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
              <div style={{ flex: 1 }}>
                <p
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: kycInfo.color,
                    marginBottom: "0.2rem",
                  }}
                >
                  KYC · {kycInfo.label}
                </p>
                <p style={{ fontSize: "0.82rem", color: "#4b5563", lineHeight: 1.5 }}>
                  {kycInfo.description}
                </p>
                {profile?.kyc_submitted_at && (
                  <p style={{ fontSize: "0.75rem", color: "#9ca3af", marginTop: "0.35rem" }}>
                    Submitted:{" "}
                    {new Date(String(profile.kyc_submitted_at)).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                )}
              </div>
            </div>

            {/* Risk Profile */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.85rem 1rem",
                borderRadius: "0.75rem",
                background: riskInfo.bg,
                border: `1px solid ${riskInfo.dot}30`,
                marginBottom: "1rem",
              }}
            >
              <span
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  background: riskInfo.dot,
                  flexShrink: 0,
                  boxShadow: `0 0 0 3px ${riskInfo.dot}30`,
                }}
              />
              <div>
                <p
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 700,
                    color: riskInfo.color,
                    margin: 0,
                  }}
                >
                  Risk Profile · {riskInfo.label}
                </p>
                <p style={{ fontSize: "0.78rem", color: "#6b7280", marginTop: "0.2rem" }}>
                  {riskStatusKey === "low"
                    ? "Excellent standing. You qualify for higher loan tiers."
                    : riskStatusKey === "medium"
                    ? "Complete KYC verification to lower your risk profile."
                    : riskStatusKey === "high"
                    ? "High risk flag detected. Review your account history."
                    : "Account access is currently restricted. Contact support."}
                </p>
              </div>
            </div>

            {/* Reputation note */}
            <p
              style={{
                fontSize: "0.78rem",
                color: "#9ca3af",
                lineHeight: 1.6,
                padding: "0.75rem",
                borderRadius: "0.5rem",
                background: "rgba(126,47,208,0.03)",
                border: "1px solid rgba(126,47,208,0.08)",
              }}
            >
              🔗 Your profile data is anchored to an on-chain reputation score on the
              Stellar testnet. Only verified users can access active lending pools.
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
                <strong style={{ fontSize: "0.85rem", wordBreak: "break-all" }}>
                  {user.email ?? "Unknown"}
                </strong>
              </li>
              <li>
                <span>Role</span>
                <span
                  style={{
                    fontSize: "0.75rem",
                    background: "rgba(126,47,208,0.08)",
                    color: "#7e2fd0",
                    padding: "0.2rem 0.6rem",
                    borderRadius: "999px",
                    fontWeight: 600,
                    textTransform: "capitalize",
                  }}
                >
                  {String(profile?.role ?? "borrower")}
                </span>
              </li>
              <li>
                <span>Email Verified</span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    fontSize: "0.8rem",
                    color: user.email_confirmed_at ? "#16a07a" : "#d97706",
                    fontWeight: 600,
                  }}
                >
                  <span
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "50%",
                      background: user.email_confirmed_at ? "#22cf9d" : "#f59e0b",
                      display: "inline-block",
                    }}
                  />
                  {user.email_confirmed_at ? "Verified" : "Not verified"}
                </span>
              </li>
              <li>
                <span>Member Since</span>
                <strong style={{ fontSize: "0.82rem" }}>
                  {user.created_at
                    ? new Date(user.created_at).toLocaleDateString("en-US", {
                        month: "long",
                        year: "numeric",
                      })
                    : "—"}
                </strong>
              </li>
            </ul>

            <div className="workspace-inline-actions" style={{ marginTop: "1rem" }}>
              <button type="button" className="workspace-nav-link">
                Change Password
              </button>
            </div>
          </article>
        </div>
      </div>
    </WorkspaceFrame>
  );
}
