import { PoolCardSkeleton } from "@/components/dashboard/PoolCardSkeleton";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";

/**
 * Next.js automatically renders this file (via React Suspense) while
 * `LenderPoolsPage` is waiting for its async server-side data fetches
 * (Supabase queries + Stellar Horizon balance).
 *
 * The result: users see a polished skeleton layout instantly on navigation
 * instead of a blank/delayed screen.
 */
export default function LenderPoolsLoading() {
  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Pool Investment"
      description="Deposit XLM into a lending pool and earn passive APR. The pool auto-matches your capital to open borrower requests."
      email={null}
      userName={null}
      metrics={[
        { label: "Total Deployed", value: "—" },
        { label: "Interest Earned", value: "—" },
        { label: "Active Positions", value: "—" },
        { label: "P2P Funded", value: "—" },
      ]}
      currentPath="/dashboard/lender/pools"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <PoolCardSkeleton />
    </WorkspaceFrame>
  );
}
