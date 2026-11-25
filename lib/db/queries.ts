/**
 * lib/db/queries.ts
 *
 * Shared read queries for server components. Each returns the snake_case row
 * shapes from lib/db/rows.ts. Functions accept a nullable db so pages can
 * render an empty state when DATABASE_URL is not configured.
 */

import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  cronAlerts,
  cronExecutionLogs,
  ledgerTransactions,
  loanFundings,
  loanRepayments,
  loans,
  profiles,
  reputationEvents,
  reputationSnapshots,
} from "@/lib/db/schema";
import {
  cronAlertToRow,
  cronExecutionLogToRow,
  ledgerToRow,
  loanToRow,
  profileToRow,
  repaymentToRow,
  reputationEventToRow,
  snapshotToRow,
  type CronAlertRow,
  type CronExecutionLogRow,
  type LedgerRow,
  type LoanRow,
  type ProfileRow,
  type RepaymentRow,
  type ReputationEventRow,
  type SnapshotRow,
} from "@/lib/db/rows";

export async function getProfile(db: Db | null, userId: string): Promise<ProfileRow | null> {
  if (!db) return null;
  const [row] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
  return row ? profileToRow(row) : null;
}

export async function getProfilesByIds(db: Db | null, ids: string[]): Promise<Map<string, ProfileRow>> {
  if (!db || ids.length === 0) return new Map();
  const rows = await db.select().from(profiles).where(inArray(profiles.id, ids));
  return new Map(rows.map((r) => [r.id, profileToRow(r)]));
}

export async function getBorrowerLoans(db: Db | null, borrowerId: string, limit = 20): Promise<LoanRow[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(loans)
    .where(eq(loans.borrowerId, borrowerId))
    .orderBy(desc(loans.createdAt))
    .limit(limit);
  return rows.map(loanToRow);
}

export async function getLoansByIds(db: Db | null, ids: string[]): Promise<LoanRow[]> {
  if (!db || ids.length === 0) return [];
  const rows = await db.select().from(loans).where(inArray(loans.id, ids));
  return rows.map(loanToRow);
}

export async function getRepaymentsForLoans(db: Db | null, loanIds: string[], limit = 100): Promise<RepaymentRow[]> {
  if (!db || loanIds.length === 0) return [];
  const rows = await db
    .select()
    .from(loanRepayments)
    .where(inArray(loanRepayments.loanId, loanIds))
    .orderBy(desc(loanRepayments.createdAt))
    .limit(limit);
  return rows.map(repaymentToRow);
}

export async function getLedgerByRef(
  db: Db | null,
  refType: string,
  refIds: string[],
): Promise<LedgerRow[]> {
  if (!db || refIds.length === 0) return [];
  const rows = await db
    .select()
    .from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.refType, refType), inArray(ledgerTransactions.refId, refIds)))
    .orderBy(desc(ledgerTransactions.createdAt));
  return rows.map(ledgerToRow);
}

export async function getUserLedger(db: Db | null, userId: string, limit = 50): Promise<LedgerRow[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.userId, userId))
    .orderBy(desc(ledgerTransactions.createdAt))
    .limit(limit);
  return rows.map(ledgerToRow);
}

export async function getReputationSnapshot(db: Db | null, userId: string): Promise<SnapshotRow | null> {
  if (!db) return null;
  const [row] = await db.select().from(reputationSnapshots).where(eq(reputationSnapshots.userId, userId)).limit(1);
  return row ? snapshotToRow(row) : null;
}

export async function getReputationEvents(db: Db | null, userId: string, limit = 50): Promise<ReputationEventRow[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(reputationEvents)
    .where(eq(reputationEvents.userId, userId))
    .orderBy(desc(reputationEvents.createdAt))
    .limit(limit);
  return rows.map(reputationEventToRow);
}

export interface MarketplaceLoan {
  id: string;
  principal_amount: number;
  /** Total contributed by all lenders so far (Issue #269). */
  funded_amount: number;
  /** Lenders who already hold a slice of this loan. */
  lender_count: number;
  apr_bps: number;
  duration_days: number;
  borrower_id: string;
  borrower_name: string;
  borrower_wallet: string;
  trust_score: number;
  /** LendingContract loan id, when the request was created on-chain. */
  onchain_loan_id: number | null;
}

/**
 * Open loan requests for the lender marketplace: requested/approved loans that
 * are not yet fully funded, with the borrower's display name, wallet and trust
 * score. Ordered oldest-first so early requests get seen.
 */
export async function getMarketplaceLoans(db: Db | null): Promise<MarketplaceLoan[]> {
  if (!db) return [];
  const rows = await db
    .select({
      id: loans.id,
      principal_amount: loans.principalAmount,
      funded_amount: loans.fundedAmount,
      apr_bps: loans.aprBps,
      duration_days: loans.durationDays,
      borrower_id: loans.borrowerId,
      borrower_name: profiles.fullName,
      borrower_wallet: profiles.walletAddress,
      trust_score: reputationSnapshots.scoreTotal,
      lender_count: sql<number>`(select count(*)::int from ${loanFundings} lf where lf.loan_id = ${loans.id})`,
      onchain_loan_id: sql<number | null>`(${loans.metadata}->>'onchain_loan_id')::int`,
    })
    .from(loans)
    .leftJoin(profiles, eq(profiles.id, loans.borrowerId))
    .leftJoin(reputationSnapshots, eq(reputationSnapshots.userId, loans.borrowerId))
    .where(and(inArray(loans.status, ["requested", "approved"]), lt(loans.fundedAmount, loans.principalAmount)))
    .orderBy(asc(loans.createdAt));

  return rows.map((r) => ({
    id: r.id,
    principal_amount: Number(r.principal_amount),
    funded_amount: Number(r.funded_amount),
    lender_count: r.lender_count ?? 0,
    apr_bps: r.apr_bps,
    duration_days: r.duration_days,
    borrower_id: r.borrower_id,
    borrower_name:
      r.borrower_name && r.borrower_name.trim() !== "" ? r.borrower_name : `Borrower ${r.borrower_id.slice(0, 6)}`,
    borrower_wallet: r.borrower_wallet ?? "",
    trust_score: r.trust_score ?? 250,
    onchain_loan_id: r.onchain_loan_id ?? null,
  }));
}

export async function getRecentCronExecutionLogs(
  db: Db | null,
  jobName?: string,
  limit = 20,
): Promise<CronExecutionLogRow[]> {
  if (!db) return [];
  const query = db.select().from(cronExecutionLogs);
  const rows = jobName
    ? await query
        .where(eq(cronExecutionLogs.jobName, jobName))
        .orderBy(desc(cronExecutionLogs.startedAt))
        .limit(limit)
    : await query.orderBy(desc(cronExecutionLogs.startedAt)).limit(limit);
  return rows.map(cronExecutionLogToRow);
}

export async function getCronExecutionLogById(
  db: Db | null,
  id: string,
): Promise<CronExecutionLogRow | null> {
  if (!db) return null;
  const [row] = await db
    .select()
    .from(cronExecutionLogs)
    .where(eq(cronExecutionLogs.id, id))
    .limit(1);
  return row ? cronExecutionLogToRow(row) : null;
}

export async function getCronAlerts(
  db: Db | null,
  jobName?: string,
  unresolvedOnly = false,
  limit = 50,
): Promise<CronAlertRow[]> {
  if (!db) return [];
  const conditions = [];
  if (jobName) conditions.push(eq(cronAlerts.jobName, jobName));
  if (unresolvedOnly) conditions.push(eq(cronAlerts.resolved, false));
  const rows = await db
    .select()
    .from(cronAlerts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(cronAlerts.createdAt))
    .limit(limit);
  return rows.map(cronAlertToRow);
}
