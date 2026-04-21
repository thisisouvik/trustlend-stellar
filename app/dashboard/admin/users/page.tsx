import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import {
  getAdminDashboardMetrics,
  presentAdminMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export default async function AdminUsersPage() {
  const { user } = await requireTradeVaultAdmin();
  const metrics = await getAdminDashboardMetrics();
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const walletConnected = Boolean(walletAddress);

  const supabase = await getServerSupabaseClient();
  const { data: users } = supabase
    ? await supabase
        .from("profiles")
        .select("id, full_name, role, kyc_status, risk_status, created_at")
        .order("created_at", { ascending: false })
        .limit(80)
    : { data: [] as Array<Record<string, unknown>> };

  const allUsers = users ?? [];
  const borrowers = allUsers.filter((profile) => String(profile.role) === "borrower").length;
  const lenders = allUsers.filter((profile) => String(profile.role) === "lender").length;
  const flagged = allUsers.filter((profile) => ["high", "blocked"].includes(String(profile.risk_status))).length;
  const pendingKyc = allUsers.filter((profile) => ["pending", "submitted", "rejected"].includes(String(profile.kyc_status))).length;

  return (
    <WorkspaceFrame
      roleLabel="Trade Vault Admin"
      heading="User Governance"
      description="Review user role distribution, KYC state, and high-risk identities."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      links={[...adminNavLinks]}
      currentPath="/dashboard/admin/users"
      showProfileAlert={false}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={Number(allUsers.length)}
          pending={Number(flagged)}
          inLoansLabel="Users"
          compact
        />
      )}
    >
      <div className="workspace-stack">
        {!walletConnected ? (
          <article className="workspace-card workspace-card--full">
            <h2 className="workspace-card-title">Wallet connection required</h2>
            <p className="workspace-card-copy">Connect wallet first to unlock user governance data.</p>
          </article>
        ) : (
          <>
            <section className="workspace-grid workspace-grid--two">
              <article className="workspace-card workspace-card--full">
                <h2 className="workspace-card-title">User segments</h2>
                <ul className="workspace-list workspace-list--compact">
                  <li><span>Total accounts</span><strong>{allUsers.length}</strong></li>
                  <li><span>Borrowers</span><strong>{borrowers}</strong></li>
                  <li><span>Lenders</span><strong>{lenders}</strong></li>
                  <li><span>Flagged risk profiles</span><strong>{flagged}</strong></li>
                  <li><span>Pending KYC profiles</span><strong>{pendingKyc}</strong></li>
                </ul>
              </article>
            </section>

            <div className="workspace-table-wrap">
                  <table className="workspace-table">
                    <thead>
                      <tr>
                        <th>User ID</th>
                        <th>Role</th>
                        <th>Name</th>
                        <th>KYC</th>
                        <th>Risk</th>
                        <th>Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allUsers.length === 0 ? (
                        <tr><td colSpan={6} style={{ textAlign: "center", padding: "1.5rem", opacity: 0.5 }}>No users found.</td></tr>
                      ) : allUsers.map((p) => (
                        <tr key={String(p.id)}>
                          <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{String(p.id).slice(0,8)}</td>
                          <td><span style={{ textTransform: "capitalize", fontWeight: 600 }}>{String(p.role)}</span></td>
                          <td>{String(p.full_name || "Unknown")}</td>
                          <td>
                            <span style={{ padding: "0.15rem 0.5rem", borderRadius: "999px", fontSize: "0.75rem", fontWeight: 600, background: p.kyc_status === "verified" ? "rgba(34,207,157,0.12)" : "rgba(245,166,35,0.12)", color: p.kyc_status === "verified" ? "#22cf9d" : "#f5a623" }}>
                              {String(p.kyc_status).toUpperCase()}
                            </span>
                          </td>
                          <td>
                            <span style={{ padding: "0.15rem 0.5rem", borderRadius: "999px", fontSize: "0.75rem", fontWeight: 600, color: p.risk_status === "low" ? "#22cf9d" : p.risk_status === "blocked" ? "#ff6b6b" : "#f5a623", background: p.risk_status === "low" ? "rgba(34,207,157,0.12)" : p.risk_status === "blocked" ? "rgba(255,107,107,0.12)" : "rgba(245,166,35,0.12)" }}>
                              {String(p.risk_status).toUpperCase()}
                            </span>
                          </td>
                          <td>{p.created_at ? new Date(String(p.created_at)).toLocaleDateString() : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
            </div>
          </>
        )}
      </div>
    </WorkspaceFrame>
  );
}
