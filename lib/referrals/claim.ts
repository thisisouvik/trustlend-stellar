/** Transactional referral-attribution boundary. */

import { sql } from "drizzle-orm";

export interface ReferralClaim {
  referralId: string | null;
  referrerId: string | null;
  status: string;
}

type ReferralClaimRow = {
  referral_id?: string;
  referrer_id?: string;
  status?: string;
};

/**
 * Build the only statement that may create a referral edge. The caller must
 * execute it inside its pooled-client transaction.
 */
export function referralClaimStatement(
  refereeId: string,
  referralCode: string,
){
  return sql`select referral_id, referrer_id, status from public.record_referral(${refereeId}::uuid, ${referralCode}::text)`;
}

/** Convert the SQL function's row to a stable API result. */
export function readReferralClaim(rows: unknown[]): ReferralClaim {
  const row = rows[0] as ReferralClaimRow | undefined;
  return {
    referralId: row?.referral_id ? String(row.referral_id) : null,
    referrerId: row?.referrer_id ? String(row.referrer_id) : null,
    status: String(row?.status ?? "pending"),
  };
}

/** Map guarded SQL failures to public API status codes. */
export function referralClaimErrorStatus(error: unknown): 404 | 409 | null {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Unknown referral code")) return 404;
  if (message.includes("Cannot refer yourself")) return 409;
  return null;
}
