/**
 * Referral qualification hook (Issue #266).
 *
 * When a borrower's loan reaches 100% funded and activates, their referrer's
 * bonus becomes payable. The authoritative payout happens on-chain — the
 * lending contract invokes ReferralRewardsContract::claim_referral_bonus during
 * activate_loan — so this module's job is only to mirror that into the database and
 * notify the referrer.
 *
 * Every failure here is swallowed and logged. A referral is a bonus; it must
 * never turn a successful loan funding into a failed API request.
 */

import { sql } from "drizzle-orm";
import type { AnyDb } from "@/lib/db/pools";

interface QualifyReferralParams {
  db: AnyDb;
  /** The borrower whose loan just activated — the referred user. */
  refereeId: string;
  /** The loan that triggered qualification. */
  loanId: string;
}

export interface QualifyReferralResult {
  /** True when a pending referral was moved to 'qualified' by this call. */
  qualified: boolean;
  /** The referrer who earned the bonus, when there was one. */
  referrerId: string | null;
  /** Status after the call, or null when the borrower had no referrer. */
  status: string | null;
}

/**
 * Mark the borrower's referral as qualified, if they have an unqualified one.
 * Attribution is immutable before this point: this flow only changes status.
 *
 * Returns a result rather than throwing so the caller can notify on success
 * and simply carry on otherwise.
 */
export async function qualifyReferralForLoan({
  db,
  refereeId,
  loanId,
}: QualifyReferralParams): Promise<QualifyReferralResult> {
  const none: QualifyReferralResult = {
    qualified: false,
    referrerId: null,
    status: null,
  };

  if (!refereeId || !loanId) return none;

  try {
    const result = await db.execute(
      sql`select referral_id, referrer_id, status from public.qualify_referral(${refereeId}::uuid, ${loanId}::uuid)`,
    );
    const row = (result.rows as Array<{ referral_id?: string; referrer_id?: string; status?: string }>)[0];
    // No row means the borrower was not referred by anyone.
    if (!row?.referral_id) return none;

    const status = String(row.status ?? "");
    return {
      // Only a transition into 'qualified' is newly earned. A row that was
      // already qualified or paid must not fire a second notification.
      qualified: status === "qualified",
      referrerId: row.referrer_id ? String(row.referrer_id) : null,
      status,
    };
  } catch (err) {
    console.error(
      "[referrals] Unexpected error qualifying referral:",
      err instanceof Error ? err.message : err,
    );
    return none;
  }
}
