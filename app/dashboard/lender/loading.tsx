import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";

/**
 * Next.js renders this file immediately (via React Suspense) while
 * the main `LenderHomePage` resolves its Supabase + Stellar fetches.
 * Prevents the blank/jump screen on initial lender dashboard load.
 */
export default function LenderDashboardLoading() {
  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Welcome back 👋"
      description="Your lending overview at a glance. Use the navigation to fund loans or manage your pool investments."
      email={null}
      userName={null}
      metrics={[
        { label: "Total Deployed", value: "—" },
        { label: "Net Earnings", value: "—" },
        { label: "Active Positions", value: "—" },
        { label: "P2P Funded", value: "—" },
      ]}
      currentPath="/dashboard/lender"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <LenderDashboardSkeleton />
    </WorkspaceFrame>
  );
}

function LenderDashboardSkeleton() {
  return (
    <div className="workspace-stack" aria-busy="true" aria-label="Loading dashboard…">
      {/* Quick action cards */}
      <section className="workspace-grid workspace-grid--two">
        {[0, 1].map((i) => (
          <article
            key={i}
            className="workspace-card animate-pulse"
            style={{ minHeight: "140px", display: "flex", flexDirection: "column", gap: "0.75rem" }}
          >
            <div
              className="rounded-full bg-gray-200 dark:bg-white/10"
              style={{ width: "2.25rem", height: "2.25rem" }}
            />
            <div className="rounded bg-gray-200 dark:bg-white/10" style={{ height: "0.9rem", width: "55%" }} />
            <div className="rounded bg-gray-100 dark:bg-white/5" style={{ height: "0.7rem", width: "85%" }} />
            <div className="rounded bg-gray-100 dark:bg-white/5" style={{ height: "0.7rem", width: "70%" }} />
            <div className="rounded bg-gray-200 dark:bg-white/10" style={{ height: "0.75rem", width: "8rem", marginTop: "auto" }} />
          </article>
        ))}
      </section>

      {/* Summary stats row */}
      <section className="workspace-grid workspace-grid--two">
        {[0, 1].map((i) => (
          <article
            key={i}
            className="workspace-card animate-pulse"
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
          >
            <div className="rounded bg-gray-200 dark:bg-white/10" style={{ height: "0.65rem", width: "50%" }} />
            <div className="rounded bg-gray-200 dark:bg-white/10" style={{ height: "1.6rem", width: "70%" }} />
            <div className="rounded bg-gray-100 dark:bg-white/5" style={{ height: "0.6rem", width: "45%" }} />
          </article>
        ))}
      </section>

      {/* Recent activity table placeholder */}
      <article
        className="workspace-card workspace-card--full animate-pulse"
        style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}
      >
        <div className="rounded bg-gray-200 dark:bg-white/10" style={{ height: "0.9rem", width: "9rem" }} />
        <div
          className="rounded-xl bg-gray-100 dark:bg-white/5"
          style={{ height: "180px" }}
        />
      </article>
    </div>
  );
}
