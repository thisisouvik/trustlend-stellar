// ─── TrustLend Soroban contract TypeScript types ─────────────────────────────
// Mirrors the Rust #[contracttype] structs/enums in contracts/*.rs

// ── Reputation ────────────────────────────────────────────────────────────────

export type ReputationTier =
  | "None"
  | "Beginner"
  | "Silver"
  | "Gold"
  | "Platinum";

export type ReputationEvent =
  | "TestLoanRepaid"
  | "LoanRepaidOnTime"
  | "LoanPaidEarly"
  | "LoanLate1Day"
  | "LoanLate7Days"
  | "LoanDefaulted"
  | "LateWarning";

export interface BorrowerProfile {
  address: string;
  /** Raw score 0-1000+ */
  reputationScore: bigint;
  reputationTier: ReputationTier;
  /** Total XLM ever borrowed in stroops */
  totalBorrowed: bigint;
  /** Total XLM ever repaid in stroops */
  totalRepaid: bigint;
  defaultCount: number;
  /** Number of successfully repaid loans */
  loanCount: number;
  createdAt: bigint;
  isFrozen: boolean;
  freezeReason: string;
}

/** Max loan amounts by tier (in stroops; 1 XLM = 10_000_000 stroops) */
export const TIER_MAX_LOAN: Record<ReputationTier, bigint> = {
  None: 1_000_0000000n,
  Beginner: 2_000_0000000n,
  Silver: 5_000_0000000n,
  Gold: 10_000_0000000n,
  Platinum: 100_000_0000000n,
};

/** Interest rates by tier in basis-points (1500 = 15.00 %) */
export const TIER_INTEREST_BPS: Record<ReputationTier, number> = {
  None: 1500,
  Beginner: 1300,
  Silver: 1200,
  Gold: 1000,
  Platinum: 800,
};

// ── Escrow ────────────────────────────────────────────────────────────────────

export type EscrowStatus = "Held" | "Transferred" | "Revoked";

export interface EscrowHold {
  id: number;
  loanId: number;
  lender: string;
  borrower: string;
  /** Amount in stroops */
  amount: bigint;
  heldAt: bigint;
  expiresAt: bigint;
  status: EscrowStatus;
}

// ── Lending ───────────────────────────────────────────────────────────────────

export type LoanStatus =
  | "Pending"
  | "Approved"
  | "Active"
  | "Repaid"
  | "Defaulted"
  | "Cancelled";

export interface LoanRecord {
  id: number;
  borrower: string;
  lender: string;
  /** Principal in stroops */
  amount: bigint;
  durationDays: number;
  /** APY in basis-points */
  interestRateBps: number;
  /** Principal + interest in stroops */
  totalDue: bigint;
  /** Remaining unpaid balance in stroops */
  remainingDue: bigint;
  createdAt: bigint;
  dueAt: bigint;
  status: LoanStatus;
  escrowId: number;
  /** 1 % of interest, in stroops */
  platformFee: bigint;
}

export interface PaymentRecord {
  loanId: number;
  amount: bigint;
  paidAt: bigint;
}

// ── Default management ────────────────────────────────────────────────────────

export type DefaultPhase =
  | "Friendly"
  | "Warning"
  | "Enforcement"
  | "Reported";

export interface DefaultRecord {
  loanId: number;
  borrower: string;
  amount: bigint;
  recordedAt: bigint;
  daysOverdue: bigint;
  phase: DefaultPhase;
}

export interface InsuranceEvent {
  loanId: number;
  lender: string;
  amountPaid: bigint;
  paidAt: bigint;
}

// ── Utility helpers ───────────────────────────────────────────────────────────

const STROOPS_PER_XLM = 10_000_000n;

/** Convert stroops to XLM as a human-readable string (e.g. "12.345678 XLM"). */
export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} XLM` : `${whole} XLM`;
}

/** Convert XLM (number) to stroops (bigint). */
export function xlmToStroops(xlm: number): bigint {
  return BigInt(Math.round(xlm * 10_000_000));
}

/**
 * Calculate interest in stroops.
 * formula: principal × rate_bps × days / (10_000 × 365)
 */
export function calculateInterest(
  principal: bigint,
  rateBps: number,
  days: number
): bigint {
  return (principal * BigInt(rateBps) * BigInt(days)) / (10_000n * 365n);
}

/** Determine reputation tier from raw score. */
export function scoreToTier(score: bigint): ReputationTier {
  if (score < 50n) return "None";
  if (score < 150n) return "Beginner";
  if (score < 500n) return "Silver";
  if (score < 1000n) return "Gold";
  return "Platinum";
}

/** Human-readable label for a loan status. */
export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  Pending: "Pending Approval",
  Approved: "Approved – Awaiting Disbursement",
  Active: "Active",
  Repaid: "Repaid",
  Defaulted: "Defaulted",
  Cancelled: "Cancelled",
};

/** Human-readable label for default phase. */
export const DEFAULT_PHASE_LABEL: Record<DefaultPhase, string> = {
  Friendly: "Friendly Reminder (Days 1-7)",
  Warning: "Warning & Score Penalty (Days 8-21)",
  Enforcement: "Enforcement – Wallet Frozen (Days 22-60)",
  Reported: "Reported to Collection Agency (60+ Days)",
};
