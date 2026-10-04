// ─── Lender Earnings Estimator ───────────────────────────────────────────────
// Pure, dependency-free forecasting math for the lender earnings calculator
// (issue #322). Lets a lender model returns before committing XLM.
//
// Everything here is a *forecast*, not a quote: the numbers describe what a
// deposit would earn if the pool APR held for the whole lock-up and the capital
// stayed matched to borrowers of the selected tier. Actual returns depend on
// utilization and on the APR schedule in force at origination
// (lib/loans/rate-config.ts).

// ─── Constants ───────────────────────────────────────────────────────────────

/** Deposit slider bounds, in XLM. */
export const MIN_DEPOSIT_XLM = 100;
export const MAX_DEPOSIT_XLM = 100_000;

/** Lock-up slider bounds, in days. */
export const MIN_DURATION_DAYS = 30;
export const MAX_DURATION_DAYS = 365;

/** Protocol cut of lender interest, in bps (1.00%) — matches the fee applied in
 *  lib/dashboard/interest-rates.ts. */
export const PLATFORM_FEE_BPS = 100;

/** Days used to annualize a yield. */
export const DAYS_PER_YEAR = 365;

/** Days of lock-up that earn one full reputation accrual period. */
export const REPUTATION_PERIOD_DAYS = 30;

/** Reputation points earned per XLM deposited, before duration and tier. */
export const REPUTATION_PTS_PER_XLM = 0.01;

/** Fallback APR in bps when no pool APR is available (10.00%). */
export const DEFAULT_POOL_APR_BPS = 1000;

// ─── Tiers ───────────────────────────────────────────────────────────────────

/**
 * Borrower reputation tiers offered by the estimator.
 *
 * These are the four tiers named in issue #322. The platform's own scoring
 * ladder (lib/reputation/scoring.ts) uses None/Beginner/Silver/Gold/Platinum —
 * "Bronze" here stands for the entry band below Silver, and carries the
 * neutral 1.0x multiplier, so the two ladders agree on the tiers they share.
 */
export type LenderTier = "Bronze" | "Silver" | "Gold" | "Platinum";

export const LENDER_TIERS: readonly LenderTier[] = [
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
] as const;

export interface TierConfig {
  tier: LenderTier;
  /** Multiplier applied to interest and reputation accrual (1.0 = neutral). */
  multiplier: number;
  /** Extra APR applied on top of the pool rate, as a fraction (0.05 = +5%). */
  rateAdjustment: number;
  /** Short rationale shown in the UI. */
  blurb: string;
}

/**
 * Per-tier economics, exactly as specified in issue #322.
 *
 * Lending to better-rated borrowers is modelled as earning more, not less:
 * these borrowers are matched at higher effective rates and repay reliably, so
 * both the yield multiplier and the reputation accrual rise with tier.
 */
export const TIER_CONFIGS: Record<LenderTier, TierConfig> = {
  Bronze: {
    tier: "Bronze",
    multiplier: 1.0,
    rateAdjustment: 0,
    blurb: "Entry-tier borrowers at the pool's base APR.",
  },
  Silver: {
    tier: "Silver",
    multiplier: 1.1,
    rateAdjustment: 0.05,
    blurb: "Established borrowers — 1.10x yield, +5% rate.",
  },
  Gold: {
    tier: "Gold",
    multiplier: 1.25,
    rateAdjustment: 0.1,
    blurb: "Proven repayment history — 1.25x yield, +10% rate.",
  },
  Platinum: {
    tier: "Platinum",
    multiplier: 1.5,
    rateAdjustment: 0.15,
    blurb: "Top-tier borrowers — 1.50x yield, +15% rate.",
  },
};

export function isLenderTier(value: unknown): value is LenderTier {
  return typeof value === "string" && value in TIER_CONFIGS;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EarningsEstimateParams {
  /** Deposit in XLM. Clamped into [MIN_DEPOSIT_XLM, MAX_DEPOSIT_XLM]. */
  depositXlm: number;
  /** Lock-up in days. Clamped into [MIN_DURATION_DAYS, MAX_DURATION_DAYS]. */
  durationDays: number;
  /** Pool APR in basis points (e.g. 1200 = 12.00%). */
  poolAprBps: number;
  /** Target borrower reputation tier. */
  tier: LenderTier;
  /** Override the platform fee in bps (defaults to PLATFORM_FEE_BPS). */
  platformFeeBps?: number;
}

export interface EarningsEstimate {
  /** Inputs after clamping, so the UI can show what was actually used. */
  depositXlm: number;
  durationDays: number;
  tier: LenderTier;
  /** Gross interest over the lock-up, in XLM. */
  interestYield: number;
  /** Protocol cut of that interest, in XLM. */
  platformFee: number;
  /** Interest net of the platform fee, in XLM — what the lender receives. */
  netRewards: number;
  /** Deposit plus net rewards, in XLM. */
  totalPayout: number;
  /** Tier-adjusted annualized rate, in bps. */
  dynamicAprBps: number;
  /** The same rate as a percentage, rounded for display. */
  dynamicAprPct: number;
  /** Reputation points the lender would earn. */
  reputationPoints: number;
  /** Net rewards as a fraction of the deposit over the period. */
  periodReturnPct: number;
  /** The tier economics that were applied. */
  tierConfig: TierConfig;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Rounds to 7 decimals — the precision of a stroop, Stellar's smallest unit. */
function toStroopPrecision(value: number): number {
  return Number(value.toFixed(7));
}

export function clampDeposit(value: number): number {
  return clamp(value, MIN_DEPOSIT_XLM, MAX_DEPOSIT_XLM);
}

export function clampDuration(value: number): number {
  return Math.round(clamp(value, MIN_DURATION_DAYS, MAX_DURATION_DAYS));
}

// ─── Estimation ──────────────────────────────────────────────────────────────

/**
 * Forecasts what a deposit would earn over a lock-up period.
 *
 * Follows the model specified in issue #322:
 *
 *   interestYield    = deposit × (poolApr / 10000) × (days / 365) × multiplier
 *   platformFee      = interestYield × feeBps / 10000
 *   netRewards       = interestYield − platformFee
 *   reputationPoints = deposit × 0.01 × (days / 30) × multiplier
 *
 * `dynamicAprBps` reports the tier-adjusted annual rate the forecast implies,
 * so the headline percentage and the reward figure always agree.
 */
export function estimateLenderEarnings(params: EarningsEstimateParams): EarningsEstimate {
  const depositXlm = clampDeposit(params.depositXlm);
  const durationDays = clampDuration(params.durationDays);
  const tier = isLenderTier(params.tier) ? params.tier : "Bronze";
  const tierConfig = TIER_CONFIGS[tier];

  // A negative or unusable pool APR falls back to the default rather than
  // producing a nonsensical negative forecast.
  const rawAprBps = Number(params.poolAprBps);
  const poolAprBps =
    Number.isFinite(rawAprBps) && rawAprBps > 0 ? rawAprBps : DEFAULT_POOL_APR_BPS;

  const feeBps = clamp(params.platformFeeBps ?? PLATFORM_FEE_BPS, 0, 10_000);

  const yearFraction = durationDays / DAYS_PER_YEAR;
  const interestYield = toStroopPrecision(
    depositXlm * (poolAprBps / 10_000) * yearFraction * tierConfig.multiplier,
  );

  const platformFee = toStroopPrecision(interestYield * (feeBps / 10_000));
  const netRewards = toStroopPrecision(interestYield - platformFee);

  // The rate the gross forecast annualizes to. Computed directly from the pool rate
  // and multiplier to avoid floating point division bugs that appear if we back-calculate
  // from the stroop-rounded interestYield.
  const dynamicAprBps = Math.round(poolAprBps * tierConfig.multiplier);

  const reputationPoints = Math.round(
    depositXlm *
      REPUTATION_PTS_PER_XLM *
      (durationDays / REPUTATION_PERIOD_DAYS) *
      tierConfig.multiplier,
  );

  return {
    depositXlm,
    durationDays,
    tier,
    interestYield,
    platformFee,
    netRewards,
    totalPayout: toStroopPrecision(depositXlm + netRewards),
    dynamicAprBps,
    dynamicAprPct: Number((dynamicAprBps / 100).toFixed(2)),
    reputationPoints,
    periodReturnPct:
      depositXlm > 0 ? Number(((netRewards / depositXlm) * 100).toFixed(2)) : 0,
    tierConfig,
  };
}

/**
 * Picks the APR to seed the estimator with: the best rate among active pools,
 * since that is the one a new deposit would realistically target.
 * Falls back to DEFAULT_POOL_APR_BPS when nothing is available.
 */
export function selectEstimatorAprBps(
  pools: { status?: unknown; apr_bps?: unknown }[],
): number {
  const activeAprs = pools
    .filter((pool) => String(pool.status ?? "") === "active")
    .map((pool) => Number(pool.apr_bps ?? 0))
    .filter((bps) => Number.isFinite(bps) && bps > 0);

  if (activeAprs.length === 0) return DEFAULT_POOL_APR_BPS;
  return Math.max(...activeAprs);
}
