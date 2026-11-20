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

// ── Credit Oracle ───────────────────────────────────────────────────────────────

/** Verified off-chain credit data posted by the Decentralized Credit Oracle. */
export interface OracleCreditData {
  /** Normalised off-chain credit score, 0..1000 */
  creditScore: number;
  /** Number of distinct verified Web2 data sources backing the score */
  dataSources: number;
  /** Resulting max-loan boost in basis-points (10_000 = +100 %) */
  loanLimitBoostBps: number;
  /** Provider tag, e.g. "mobile-money", "plaid" */
  provider: string;
  /** Ledger timestamp when the oracle posted this record */
  updatedAt: bigint;
}

/** Maximum normalised credit score the oracle may post (mirrors the contract). */
export const MAX_ORACLE_SCORE = 1000;
/** Hard cap on the oracle max-loan boost in basis-points (mirrors the contract). */
export const MAX_LIMIT_BOOST_BPS = 10_000;
/** Oracle record freshness window in seconds (90 days; mirrors the contract). */
export const ORACLE_VALIDITY_SECONDS = 90 * 24 * 60 * 60;

/** Deterministic score → loan-boost mapping (mirrors the contract). */
export function scoreToBoostBps(creditScore: number): number {
  const score = Math.max(0, Math.min(MAX_ORACLE_SCORE, Math.trunc(creditScore)));
  return Math.trunc((score * MAX_LIMIT_BOOST_BPS) / MAX_ORACLE_SCORE);
}

// ── Escrow ────────────────────────────────────────────────────────────────────

export type EscrowStatus = "Held" | "Transferred" | "Revoked";

export interface EscrowHold {
  id: number;
  loanId: number;
  lender: string;
  borrower: string;
  /** SEP-41 token contract held in custody (e.g. native XLM or USDC). */
  token: string;
  /** Amount in the token's smallest unit (stroops for XLM) */
  amount: bigint;
  heldAt: bigint;
  expiresAt: bigint;
  status: EscrowStatus;
}

// ── Pooled Lending / JumpRateModel ────────────────────────────────────────────

export interface PoolConfig {
  baseRateBps: number;
  multiplierPerSlopeBps: number;
  jumpMultiplierBps: number;
  kinkBps: number;
  reserveFactorBps: number;
}

export interface PoolData {
  totalSupply: bigint;
  totalBorrows: bigint;
  totalReserves: bigint;
}

// ── Interest Rate Model ───────────────────────────────────────────────────────

/** Whether a loan uses a fixed or floating interest rate. */
export type InterestRateModel = "Fixed" | "Floating";

/** Fee charged when switching rate models, in bps of remaining debt (0.5%). */
export const RATE_SWITCH_FEE_BPS = 50;

/** Cooldown between rate model switches in seconds (24 hours). */
export const RATE_SWITCH_COOLDOWN_SECS = 86_400;

// ── Multi-Asset Collateral Vault ─────────────────────────────────────────────

/** A single collateral entry: asset address + amount in that asset's smallest unit. */
export interface CollateralEntry {
  asset: string;
  amount: bigint;
}

/** Per-asset collateral configuration (mirrors the contract). */
export interface AssetCollateralConfig {
  /** LTV ratio in basis-points (e.g. 8000 = 80%). */
  collateralFactorBps: number;
  /** Whether the asset has an oracle price feed configured. */
  hasPriceOracle: boolean;
  /** Estimated annualized volatility in basis-points. */
  volatilityBps: number;
}

/** Default collateral factor for assets without explicit config: 75% LTV. */
export const DEFAULT_COLLATERAL_FACTOR_BPS = 7500;
/** Maximum allowed collateral factor: 95% LTV. */
export const MAX_COLLATERAL_FACTOR_BPS = 9500;
/** Minimum allowed collateral factor: 10% LTV. */
export const MIN_COLLATERAL_FACTOR_BPS = 1000;

/**
 * Calculate borrowing power from a set of collateral entries.
 * borrowing_power = sum(amount * collateralFactorBps / 10000)
 */
export function calculateBorrowingPower(
  entries: { amount: bigint; config: AssetCollateralConfig }[]
): bigint {
  let total = 0n;
  for (const { amount, config } of entries) {
    total += (amount * BigInt(config.collateralFactorBps)) / 10_000n;
  }
  return total;
}

/**
 * Static helper to compute total collateral value from entries.
 * Without oracle prices, each unit is valued at face value.
 */
export function calculateTotalCollateralValue(entries: CollateralEntry[]): bigint {
  return entries.reduce((sum, e) => sum + e.amount, 0n);
}

// ── Lending ───────────────────────────────────────────────────────────────────

export type LoanStatus =
  | "Pending"
  | "Approved"
  | "Active"
  | "Repaid"
  | "Defaulted"
  | "Cancelled";

/** Input struct for creating a loan request (mirrors Rust LoanRequestInput). */
export interface LoanRequestInput {
  amount: bigint;
  durationDays: number;
  interestRateBps: number;
  maxLoanAmount: bigint;
  /** Multi-asset collateral entries supporting this loan. */
  collateralEntries: CollateralEntry[];
  /** Interest rate model: Fixed or Floating */
  rateModel: InterestRateModel;
}

export interface LoanRecord {
  id: number;
  borrower: string;
  lender: string;
  /** Principal in stroops */
  amount: bigint;
  durationDays: number;
  /** APY in basis-points (current effective rate) */
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
  /** Interest rate model: Fixed or Floating */
  rateModel: InterestRateModel;
  /** Baseline rate at loan creation in bps (anchors floating calculations) */
  baseRateBps: number;
  /** Timestamp of the last floating rate adjustment */
  lastRateUpdate: bigint;
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

// ── DAO Governance ────────────────────────────────────────────────────────────

export type ProposalStatus = "Active" | "Passed" | "Rejected" | "Executed";

export type ProposalKind = "SetPlatformFeeBps";

export interface Proposal {
  id: number;
  proposer: string;
  kind: ProposalKind;
  /** Proposed parameter value (for SetPlatformFeeBps: new fee in bps). */
  newValue: number;
  /** Sum of reputation-weighted voting power in favour. */
  votesFor: bigint;
  /** Sum of reputation-weighted voting power against. */
  votesAgainst: bigint;
  createdAt: bigint;
  /** Ledger timestamp when voting closes. */
  endAt: bigint;
  status: ProposalStatus;
}

export interface GovConfig {
  admin: string;
  lending: string;
  reputation: string;
  votingPeriodSecs: bigint;
  quorumVotes: bigint;
  minProposerPower: bigint;
  maxFeeBps: number;
}

/** Default lending platform fee in bps of interest (mirrors the contract). */
export const DEFAULT_PLATFORM_FEE_BPS = 100;
/** Hard ceiling on the platform fee in bps (mirrors the lending contract). */
export const MAX_PLATFORM_FEE_BPS = 1000;

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  Active: "Voting Open",
  Passed: "Passed – Awaiting Execution",
  Rejected: "Rejected",
  Executed: "Executed",
};

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

// ── Multi-Sig Admin ────────────────────────────────────────────────────────────

export type MultiSigProposalStatus = "Active" | "Executed" | "Cancelled";

/**
 * Mirrors the Rust `AdminAction` tuple-variant enum. Decoded shape from
 * `scValToNative` is `{ VariantName: [field0, field1, ...] }`.
 */
export type MultiSigAdminAction =
  | { WhitelistAsset: [string, string] } // [target, asset]
  | { SetFlashLoanFeeBps: [string, number] } // [target, newFeeBps]
  | { SetGovernance: [string, string] } // [target, governance]
  | { SetOracle: [string, string] } // [target, oracle]
  | { AddToInsurance: [string, bigint] } // [target, amount]
  | { TriggerInsurancePayout: [string, number, string, bigint] } // [target, loanId, lender, amount]
  | { AddSigner: [string] } // [newSigner]
  | { RemoveSigner: [string] } // [signer]
  | { SetThreshold: [number] }; // [newThreshold]

export interface MultiSigProposal {
  id: number;
  proposer: string;
  action: MultiSigAdminAction;
  /** Distinct signer addresses who have approved, in approval order. */
  approvals: string[];
  createdAt: bigint;
  status: MultiSigProposalStatus;
}

export const MULTISIG_PROPOSAL_STATUS_LABEL: Record<MultiSigProposalStatus, string> = {
  Active: "Awaiting Approvals",
  Executed: "Executed",
  Cancelled: "Cancelled",
};

/** Human-readable label for default phase. */
export const DEFAULT_PHASE_LABEL: Record<DefaultPhase, string> = {
  Friendly: "Friendly Reminder (Days 1-7)",
  Warning: "Warning & Score Penalty (Days 8-21)",
  Enforcement: "Enforcement – Wallet Frozen (Days 22-60)",
  Reported: "Reported to Collection Agency (60+ Days)",
};
