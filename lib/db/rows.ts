/**
 * lib/db/rows.ts
 *
 * Snake_case row shapes for server components.
 *
 * The dashboard pages were written against PostgREST rows (snake_case keys,
 * ISO-8601 timestamp strings, numeric columns as strings). These mappers turn
 * Drizzle rows into that shape so the rendering code is untouched by the
 * database migration. New code should prefer the camelCase Drizzle types.
 */

import type {
  CronAlert,
  CronExecutionLog,
  LedgerTransaction,
  LendingPool,
  Loan,
  LoanFunding,
  LoanRepayment,
  PoolPosition,
  Profile,
  ReputationEvent,
  ReputationSnapshot,
} from "@/lib/db/schema";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function profileToRow(p: Profile) {
  return {
    id: p.id,
    full_name: p.fullName,
    role: p.role,
    wallet_address: p.walletAddress,
    country_code: p.countryCode,
    phone: p.phone,
    date_of_birth: p.dateOfBirth,
    kyc_status: p.kycStatus,
    risk_status: p.riskStatus,
    government_id_ipfs_hash: p.governmentIdIpfsHash,
    government_id_url: p.governmentIdUrl,
    kyc_submitted_at: iso(p.kycSubmittedAt),
    kyc_verified_at: iso(p.kycVerifiedAt),
    kyc_rejection_reason: p.kycRejectionReason,
    kyc_provider_id: p.kycProviderId,
    kyc_provider_status: p.kycProviderStatus,
    regulated_pool_access: p.regulatedPoolAccess,
    referral_code: p.referralCode,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
export type ProfileRow = ReturnType<typeof profileToRow>;

export function loanToRow(l: Loan) {
  return {
    id: l.id,
    borrower_id: l.borrowerId,
    pool_id: l.poolId,
    status: l.status,
    principal_amount: l.principalAmount,
    apr_bps: l.aprBps,
    duration_days: l.durationDays,
    rate_model: l.rateModel,
    rate_switch_count: l.rateSwitchCount,
    last_rate_switch_at: iso(l.lastRateSwitchAt),
    funded_amount: l.fundedAmount,
    repaid_amount: l.repaidAmount,
    requested_at: l.requestedAt.toISOString(),
    approved_at: iso(l.approvedAt),
    funded_at: iso(l.fundedAt),
    due_at: iso(l.dueAt),
    closed_at: iso(l.closedAt),
    defaulted_at: iso(l.defaultedAt),
    metadata: (l.metadata ?? {}) as Record<string, unknown>,
    created_at: l.createdAt.toISOString(),
    updated_at: l.updatedAt.toISOString(),
  };
}
export type LoanRow = ReturnType<typeof loanToRow>;

export function repaymentToRow(r: LoanRepayment) {
  return {
    id: r.id,
    loan_id: r.loanId,
    payer_id: r.payerId,
    amount: r.amount,
    paid_at: r.paidAt.toISOString(),
    tx_ref: r.txRef,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    created_at: r.createdAt.toISOString(),
  };
}
export type RepaymentRow = ReturnType<typeof repaymentToRow>;

export function fundingToRow(f: LoanFunding) {
  return {
    id: f.id,
    loan_id: f.loanId,
    lender_id: f.lenderId,
    amount: f.amount,
    tx_hash: f.txHash,
    lender_address: f.lenderAddress,
    funded_at: f.fundedAt.toISOString(),
    metadata: (f.metadata ?? {}) as Record<string, unknown>,
    created_at: f.createdAt.toISOString(),
  };
}
export type FundingRow = ReturnType<typeof fundingToRow>;

export function ledgerToRow(t: LedgerTransaction) {
  return {
    id: t.id,
    user_id: t.userId,
    category: t.category,
    amount: t.amount,
    currency: t.currency,
    status: t.status,
    ref_type: t.refType,
    ref_id: t.refId,
    metadata: (t.metadata ?? {}) as Record<string, unknown>,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  };
}
export type LedgerRow = ReturnType<typeof ledgerToRow>;

export function poolToRow(p: LendingPool) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    currency: p.currency,
    apr_bps: p.aprBps,
    total_liquidity: p.totalLiquidity,
    available_liquidity: p.availableLiquidity,
    total_borrowed: p.totalBorrowed,
    borrow_cap: p.borrowCap,
    created_by: p.createdBy,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
export type PoolRow = ReturnType<typeof poolToRow>;

export function positionToRow(p: PoolPosition) {
  return {
    id: p.id,
    pool_id: p.poolId,
    lender_id: p.lenderId,
    status: p.status,
    principal_amount: p.principalAmount,
    earned_interest: p.earnedInterest,
    withdrawn_amount: p.withdrawnAmount,
    opened_at: p.openedAt.toISOString(),
    closed_at: iso(p.closedAt),
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
export type PositionRow = ReturnType<typeof positionToRow>;

export function reputationEventToRow(e: ReputationEvent) {
  return {
    id: e.id,
    user_id: e.userId,
    source_type: e.sourceType,
    source_id: e.sourceId,
    source_key: e.sourceKey,
    points_delta: e.pointsDelta,
    reason: e.reason,
    metadata: (e.metadata ?? {}) as Record<string, unknown>,
    created_at: e.createdAt.toISOString(),
  };
}
export type ReputationEventRow = ReturnType<typeof reputationEventToRow>;

export function snapshotToRow(s: ReputationSnapshot) {
  return {
    user_id: s.userId,
    score_total: s.scoreTotal,
    repayment_score: s.repaymentScore,
    lending_score: s.lendingScore,
    consistency_score: s.consistencyScore,
    external_score: s.externalScore,
    reputation_level: s.reputationLevel,
    score_breakdown: (s.scoreBreakdown ?? {}) as Record<string, unknown>,
    calculated_at: s.calculatedAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}
export type SnapshotRow = ReturnType<typeof snapshotToRow>;

export function cronExecutionLogToRow(c: CronExecutionLog) {
  return {
    id: c.id,
    job_name: c.jobName,
    status: c.status,
    started_at: c.startedAt.toISOString(),
    completed_at: iso(c.completedAt),
    duration_ms: c.durationMs,
    processed_count: c.processedCount,
    success_count: c.successCount,
    failure_count: c.failureCount,
    aborted: c.aborted,
    abort_reason: c.abortReason,
    error: c.error,
    metadata: (c.metadata ?? {}) as Record<string, unknown>,
    created_at: c.createdAt.toISOString(),
  };
}
export type CronExecutionLogRow = ReturnType<typeof cronExecutionLogToRow>;

export function cronAlertToRow(a: CronAlert) {
  return {
    id: a.id,
    log_id: a.logId,
    job_name: a.jobName,
    level: a.level,
    message: a.message,
    details: (a.details ?? {}) as Record<string, unknown>,
    resolved: a.resolved,
    created_at: a.createdAt.toISOString(),
  };
}
export type CronAlertRow = ReturnType<typeof cronAlertToRow>;
