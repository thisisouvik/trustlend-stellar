/**
 * lib/reputation/daily-sync.ts
 *
 * Daily reputation calculation runner. Iterates over borrower accounts,
 * aggregates loan/repayment performance, recalculates scores, and updates the
 * persistent snapshots.
 */

import { eq, inArray } from "drizzle-orm";
import { getActiveCronSignal } from "@/lib/auth/cron";
import { getDb } from "@/lib/db/client";
import { loanRepayments, loans, profiles, reputationEvents, reputationSnapshots } from "@/lib/db/schema";
import {
  computeBorrowerReputationScore,
  BorrowerRepaymentStats,
  BorrowerReputationResult,
} from "@/lib/reputation/scoring";

export interface DailyCalculationSummary {
  scanned: number;
  updated: number;
  tierUpgrades: number;
  errors: number;
  timedOut?: boolean;
  details: Array<{
    userId: string;
    walletAddress?: string;
    previousScore: number;
    newScore: number;
    tier: string;
    discountPct: number;
  }>;
}

/**
 * Runs the daily reputation recalculation for all active borrowers.
 */
export async function runDailyReputationRecalculation(options?: {
  signal?: AbortSignal;
}): Promise<DailyCalculationSummary> {
  const signal = options?.signal ?? getActiveCronSignal();
  const db = getDb();
  if (!db) {
    throw new Error("Database unavailable");
  }

  // 1. Fetch all borrower profiles
  const borrowers = await db
    .select({
      id: profiles.id,
      walletAddress: profiles.walletAddress,
      kycStatus: profiles.kycStatus,
      createdAt: profiles.createdAt,
    })
    .from(profiles)
    .where(eq(profiles.role, "borrower"));

  const summary: DailyCalculationSummary = {
    scanned: borrowers.length,
    updated: 0,
    tierUpgrades: 0,
    errors: 0,
    details: [],
  };

  if (borrowers.length === 0) {
    return summary;
  }

  // 2. Bulk-load loans, repayments and snapshots for every borrower (3 queries
  //    instead of 3 per borrower).
  const borrowerIds = borrowers.map((b) => b.id);
  const [allLoans, allRepayments, allSnapshots] = await Promise.all([
    db
      .select({
        id: loans.id,
        borrowerId: loans.borrowerId,
        status: loans.status,
        principalAmount: loans.principalAmount,
        dueAt: loans.dueAt,
        createdAt: loans.createdAt,
        metadata: loans.metadata,
      })
      .from(loans)
      .where(inArray(loans.borrowerId, borrowerIds)),
    db
      .select({
        payerId: loanRepayments.payerId,
        loanId: loanRepayments.loanId,
        amount: loanRepayments.amount,
        paidAt: loanRepayments.paidAt,
      })
      .from(loanRepayments)
      .where(inArray(loanRepayments.payerId, borrowerIds)),
    db
      .select({
        userId: reputationSnapshots.userId,
        scoreTotal: reputationSnapshots.scoreTotal,
        level: reputationSnapshots.reputationLevel,
      })
      .from(reputationSnapshots)
      .where(inArray(reputationSnapshots.userId, borrowerIds)),
  ]);

  const loansByBorrower = groupBy(allLoans, (l) => l.borrowerId);
  const repaymentsByPayer = groupBy(allRepayments, (r) => r.payerId);
  const snapshotByUser = new Map(allSnapshots.map((s) => [s.userId, s]));

  for (const borrower of borrowers) {
    if (signal?.aborted) {
      summary.timedOut = true;
      console.warn(
        `[Reputation Cron] Execution deadline reached before borrower ${borrower.id}; halting batch.`,
      );
      return summary;
    }

    try {
      const userLoans = loansByBorrower.get(borrower.id) ?? [];
      const userRepayments = repaymentsByPayer.get(borrower.id) ?? [];
      const snapshot = snapshotByUser.get(borrower.id);

      const previousScore = snapshot?.scoreTotal ?? 250;
      const previousTier = snapshot?.level ?? "None";

      const completedLoans = userLoans.filter((l) => l.status === "repaid").length;
      const defaultedLoans = userLoans.filter((l) => l.status === "defaulted").length;

      let onTimeCount = 0;
      let earlyCount = 0;
      let lateCount = 0;

      for (const loan of userLoans) {
        if (loan.status !== "repaid") continue;
        const dueTime = loan.dueAt ? loan.dueAt.getTime() : 0;
        const creationTime = loan.createdAt ? loan.createdAt.getTime() : 0;

        if (loan.metadata && typeof loan.metadata === "object" && (loan.metadata as { is_early?: boolean }).is_early) {
          earlyCount++;
        } else if (dueTime > 0) {
          const loanPayments = userRepayments.filter((r) => r.loanId === loan.id);
          const latestPayment = loanPayments.reduce(
            (latest, r) => Math.max(latest, r.paidAt.getTime()),
            creationTime,
          );
          if (latestPayment <= dueTime) onTimeCount++;
          else lateCount++;
        } else {
          onTimeCount++;
        }
      }

      const totalBorrowed = userLoans.reduce((sum, l) => sum + Number(l.principalAmount ?? 0), 0);
      const totalRepaid = userRepayments.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
      const accountAgeDays = borrower.createdAt
        ? Math.floor((Date.now() - borrower.createdAt.getTime()) / (86400 * 1000))
        : 0;

      const stats: BorrowerRepaymentStats = {
        totalLoans: userLoans.length,
        completedLoans,
        onTimeRepayments: onTimeCount,
        earlyRepayments: earlyCount,
        lateRepayments: lateCount,
        defaultedLoans,
        totalBorrowedXlm: totalBorrowed,
        totalRepaidXlm: totalRepaid,
        kycVerified: borrower.kycStatus === "verified",
        emailVerified: true,
        accountAgeDays,
      };

      const result: BorrowerReputationResult = computeBorrowerReputationScore(stats);

      // Persist snapshot
      await db
        .insert(reputationSnapshots)
        .values({
          userId: borrower.id,
          scoreTotal: result.score,
          reputationLevel: result.tier,
          scoreBreakdown: result.breakdown,
          calculatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: reputationSnapshots.userId,
          set: {
            scoreTotal: result.score,
            reputationLevel: result.tier,
            scoreBreakdown: result.breakdown,
            calculatedAt: new Date(),
          },
        });

      // Tier upgrade: log a zero-point event so the timeline shows it
      // without double-counting the score (the snapshot is authoritative).
      if (previousTier !== result.tier && result.score > previousScore) {
        summary.tierUpgrades++;
        await db.insert(reputationEvents).values({
          userId: borrower.id,
          sourceType: "tier_upgrade",
          sourceKey: `${result.tier}:${new Date().toISOString().slice(0, 10)}`,
          pointsDelta: 0,
          reason: `Tier upgraded to ${result.tier}! Unlocked rate discount: ${result.rateDiscountPct}% APR.`,
          metadata: { previousTier, previousScore, newScore: result.score },
        });
      }

      summary.updated++;
      summary.details.push({
        userId: borrower.id,
        walletAddress: borrower.walletAddress ?? undefined,
        previousScore,
        newScore: result.score,
        tier: result.tier,
        discountPct: result.rateDiscountPct,
      });
    } catch (err) {
      console.error(`[Reputation Cron] Error processing borrower ${borrower.id}:`, err);
      summary.errors++;
    }
  }

  return summary;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
