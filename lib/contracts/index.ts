/**
 * lib/contracts/index.ts
 *
 * Barrel export for all TrustLend contract clients.
 */

export * as ReputationContract from "./reputation";
export * as EscrowContract from "./escrow";
export * as LendingContract from "./lending";
export * as DefaultContract from "./default";

// Re-export the soroban core helpers for convenience
export { sorobanServer, SOROBAN_RPC_URL, NETWORK_PASSPHRASE } from "@/lib/stellar/soroban";

// Re-export contract types & utilities
export {
  stroopsToXlm,
  xlmToStroops,
  calculateInterest,
  scoreToTier,
  TIER_MAX_LOAN,
  TIER_INTEREST_BPS,
  LOAN_STATUS_LABEL,
  DEFAULT_PHASE_LABEL,
} from "@/types/contracts";

export type {
  BorrowerProfile,
  LoanRecord,
  EscrowHold,
  DefaultRecord,
  InsuranceEvent,
  PaymentRecord,
  ReputationTier,
  ReputationEvent,
  LoanStatus,
  EscrowStatus,
  DefaultPhase,
} from "@/types/contracts";

