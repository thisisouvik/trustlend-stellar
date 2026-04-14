import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import {
  getAdminDashboardMetrics,
  presentAdminMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function AdminSecurityPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const walletConnected = Boolean(walletAddress);

  const supabase = await getServerSupabaseClient();
  const [signalsRes, riskRes, profilesRes] = supabase
    ? await Promise.all([
        supabase
          .from("fraud_signals")
          .select("id, user_id, signal_type, severity, resolved, created_at")
          .order("created_at", { ascending: false })
          .limit(40),
        supabase
          .from("risk_assessments")
          .select("id, user_id, score, decision, assessed_at")
          .order("assessed_at", { ascending: false })
          .limit(40),
        supabase
          .from("profiles")
          .select("id, full_name, kyc_status, risk_status")
          .order("created_at", { ascending: false })
          .limit(120),
      ])
    : [{ data: [] as Array<Record<string, unknown>> }, { data: [] as Array<Record<string, unknown>> }, { data: [] as Array<Record<string, unknown>> }];

  const signals = signalsRes.data ?? [];
  const assessments = riskRes.data ?? [];
  const profiles = profilesRes.data ?? [];

  const maliciousIds = new Set(
    signals
      .filter((signal) => !signal.resolved && Number(signal.severity ?? 0) >= 4)
      .map((signal) => String(signal.user_id)),
  );

  const flaggedProfiles = profiles.filter((profile) => ["high", "blocked"].includes(String(profile.risk_status)));
  const pendingKycProfiles = profiles.filter((profile) => ["pending", "submitted", "rejected"].includes(String(profile.kyc_status)));
  flaggedProfiles.forEach((profile) => maliciousIds.add(String(profile.id)));

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="Security Center"
      description="Investigate fraud signals, manual-review decisions, and suspicious account behavior."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[...adminNavLinks]}
      currentPath="/dashboard/admin/security"
      showProfileAlert={false}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={Number(flaggedProfiles.length)}
          pending={Number(maliciousIds.size)}
          inLoansLabel="Flagged"
          compact
        />
      )}
    >
      <div className="workspace-stack">
        {!walletConnected ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">Connect wallet first to unlock security monitoring data.</p>
          </article>
        ) : (
          <>
            <section className="workspace-grid workspace-grid--two">
              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Security posture snapshot</h2>
                <ul className="workspace-list workspace-list--compact">
                  <li><span>Flagged accounts</span><strong>{flaggedProfiles.length}</strong></li>
                  <li><span>Malicious indicators</span><strong>{maliciousIds.size}</strong></li>
                  <li><span>Open fraud signals</span><strong>{signals.filter((signal) => !signal.resolved).length}</strong></li>
                  <li><span>KYC incomplete</span><strong>{pendingKycProfiles.length}</strong></li>
                </ul>
              </article>
            </section>

            <section className="workspace-grid workspace-grid--two">
              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Recent fraud signals</h2>
                <ul className="workspace-list">
                  {signals.length === 0 ? (
                    <li>No fraud signals logged.</li>
                  ) : (
                    signals.map((signal) => (
                      <li key={String(signal.id)}>
                        {String(signal.signal_type)} | severity {String(signal.severity)} | user {String(signal.user_id).slice(0, 8)} | {signal.resolved ? "resolved" : "open"}
                      </li>
                    ))
                  )}
                </ul>
              </article>

              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">Latest risk assessments</h2>
                <ul className="workspace-list">
                  {assessments.length === 0 ? (
                    <li>No risk assessments logged.</li>
                  ) : (
                    assessments.map((assessment) => (
                      <li key={String(assessment.id)}>
                        user {String(assessment.user_id).slice(0, 8)} | score {String(assessment.score)} | decision {String(assessment.decision)}
                      </li>
                    ))
                  )}
                </ul>
              </article>
            </section>
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
