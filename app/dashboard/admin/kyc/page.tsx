import { getPendingKYCDocuments } from "@/app/actions/admin-kyc";
import { requireTradeVaultAdmin } from "@/lib/auth/session";
import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { WalletCard } from "@/components/dashboard/WalletCard";
import { adminNavLinks } from "@/lib/dashboard/admin-links";
import {
  getAdminDashboardMetrics,
  presentAdminMetrics,
} from "@/lib/dashboard/metrics";
import AdminKYCClient from "./kyc-client";

export default async function AdminKYCPage() {
  const { user } = await requireTradeVaultAdmin();
  const walletAddress = String(user.user_metadata?.wallet_address ?? "") || null;
  const walletConnected = Boolean(walletAddress);

  const metrics = await getAdminDashboardMetrics();
  const pendingDocs = await getPendingKYCDocuments();

  return (
    <WorkspaceFrame
      roleLabel="Admin Dashboard"
      heading="KYC Verification Center"
      description="Review and verify identity documents for lender/borrower KYC compliance."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? "Admin")}
      metrics={presentAdminMetrics(metrics)}
      currentPath="/dashboard/admin/kyc"
      links={[...adminNavLinks]}
      showProfileAlert={false}
      headerWidget={(
        <WalletCard
          address={walletAddress}
          available={0}
          inLoansOrPools={Number(pendingDocs?.length ?? 0)}
          pending={0}
          inLoansLabel="Pending Docs"
          compact
        />
      )}
    >
      {!walletConnected ? (
        <article className="workspace-card workspace-card--full">
          <h2 className="workspace-card-title">Wallet connection required</h2>
          <p className="workspace-card-copy">Connect wallet first to unlock KYC review controls.</p>
        </article>
      ) : (
        <AdminKYCClient documents={pendingDocs || []} />
      )}
    </WorkspaceFrame>
  );
}
