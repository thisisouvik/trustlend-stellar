import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { ReferralWidget } from "@/components/dashboard/ReferralWidget";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { borrowerNavLinks } from "@/lib/dashboard/borrower-links";

/**
 * /dashboard/borrower/referrals — the user's invite link and referral progress
 * (Issue #266).
 */
export default async function BorrowerReferralsPage() {
  const { user } = await requireAuthenticatedUser("borrower");

  return (
    <WorkspaceFrame
      roleLabel="Borrower"
      heading="Refer a friend"
      description="Share your invite link and earn a TLND bonus each time someone you invited takes out their first loan. Each invite can be attributed only once."
      email={user.email ?? null}
      userName={String(user.fullName ?? "")}
      metrics={[]}
      links={borrowerNavLinks}
      currentPath="/dashboard/borrower/referrals"
      showProfileAlert={false}
    >
      <ReferralWidget />
    </WorkspaceFrame>
  );
}
