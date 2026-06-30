import type { SupabaseClient } from "@supabase/supabase-js";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const ANALYTICS_CACHE_TTL_SECONDS = 60 * 60;
export const ANALYTICS_ACTIVE_WINDOW_MS = 30 * DAY_MS;

export interface PlatformAnalyticsMetrics {
  tvl: number;
  totalRepaid: number;
  platformYields: number;
  activeUsers: number;
  cumulativeTransactionVolume: number;
}

export interface PlatformAnalyticsResponse {
  success: true;
  metrics: PlatformAnalyticsMetrics;
  generatedAt: string;
}

type LoanRow = {
  principal_amount?: unknown;
  status?: unknown;
};

type PoolPositionRow = {
  principal_amount?: unknown;
  earned_interest?: unknown;
  status?: unknown;
};

type LoanRepaymentRow = {
  amount?: unknown;
};

type LedgerTransactionRow = {
  amount?: unknown;
  user_id?: unknown;
  status?: unknown;
  created_at?: unknown;
};

function toNumber(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function isActiveLoanStatus(status: unknown): boolean {
  return ["funded", "active"].includes(String(status ?? "").toLowerCase());
}

function isConfirmedLedgerRow(row: LedgerTransactionRow): boolean {
  return String(row.status ?? "").toLowerCase() === "confirmed";
}

function isWithinWindow(createdAt: unknown, windowStart: number): boolean {
  const timestamp = new Date(String(createdAt ?? "")).getTime();
  return Number.isFinite(timestamp) && timestamp >= windowStart;
}

function normalizeRows<T>(rows: T[] | null | undefined): T[] {
  return Array.isArray(rows) ? rows : [];
}

export function aggregatePlatformAnalytics(
  rows: {
    loans?: LoanRow[] | null;
    poolPositions?: PoolPositionRow[] | null;
    loanRepayments?: LoanRepaymentRow[] | null;
    ledgerTransactions?: LedgerTransactionRow[] | null;
  },
  activeWindowMs: number = ANALYTICS_ACTIVE_WINDOW_MS,
): PlatformAnalyticsMetrics {
  const loans = normalizeRows(rows.loans);
  const poolPositions = normalizeRows(rows.poolPositions);
  const loanRepayments = normalizeRows(rows.loanRepayments);
  const ledgerTransactions = normalizeRows(rows.ledgerTransactions);

  const activeWindowStart = Date.now() - activeWindowMs;

  const tvlFromLoans = loans
    .filter((loan) => isActiveLoanStatus(loan.status))
    .reduce((sum, loan) => sum + toNumber(loan.principal_amount), 0);

  const tvlFromPools = poolPositions
    .filter((position) => String(position.status ?? "").toLowerCase() === "active")
    .reduce((sum, position) => sum + toNumber(position.principal_amount), 0);

  const totalRepaid = loanRepayments.reduce((sum, repayment) => sum + toNumber(repayment.amount), 0);

  const platformYields = poolPositions.reduce((sum, position) => sum + toNumber(position.earned_interest), 0);

  const cumulativeTransactionVolume = ledgerTransactions
    .filter((row) => isConfirmedLedgerRow(row))
    .reduce((sum, row) => sum + toNumber(row.amount), 0);

  const activeUsers = new Set(
    ledgerTransactions
      .filter((row) => isConfirmedLedgerRow(row) && isWithinWindow(row.created_at, activeWindowStart))
      .map((row) => String(row.user_id ?? "").trim())
      .filter(Boolean),
  ).size;

  return {
    tvl: tvlFromLoans + tvlFromPools,
    totalRepaid,
    platformYields,
    activeUsers,
    cumulativeTransactionVolume,
  };
}

export async function fetchPlatformAnalytics(
  supabase: SupabaseClient,
): Promise<PlatformAnalyticsMetrics> {
  const [loansRes, poolPositionsRes, loanRepaymentsRes, ledgerTransactionsRes] = await Promise.all([
    supabase.from("loans").select("principal_amount,status"),
    supabase.from("pool_positions").select("principal_amount,earned_interest,status"),
    supabase.from("loan_repayments").select("amount"),
    supabase.from("ledger_transactions").select("amount,user_id,status,created_at"),
  ]);

  const firstError =
    loansRes.error ??
    poolPositionsRes.error ??
    loanRepaymentsRes.error ??
    ledgerTransactionsRes.error;

  if (firstError) {
    throw new Error(firstError.message);
  }

  return aggregatePlatformAnalytics({
    loans: loansRes.data,
    poolPositions: poolPositionsRes.data,
    loanRepayments: loanRepaymentsRes.data,
    ledgerTransactions: ledgerTransactionsRes.data,
  });
}

export function buildPlatformAnalyticsResponse(
  metrics: PlatformAnalyticsMetrics,
  generatedAt: string = new Date().toISOString(),
): PlatformAnalyticsResponse {
  return {
    success: true,
    metrics,
    generatedAt,
  };
}
