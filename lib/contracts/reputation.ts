/**
 * lib/contracts/reputation.ts
 *
 * TypeScript client for the BorrowerReputationContract.
 * Wraps every public contract function with proper arg encoding/decoding.
 */

import {
  callContract,
  simulateContractCall,
  addressToScVal,
  stringToScVal,
  enumToScVal,
  u32ToScVal,
} from "@/lib/stellar/soroban";
import type {
  BorrowerProfile,
  OracleCreditData,
  ReputationEvent,
} from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_REPUTATION_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_REPUTATION_CONTRACT_ID is not set. " +
      "Deploy the contract and add the ID to .env.local"
  );
}

// ─── Read functions (simulation only — no signing required) ───────────────────

/**
 * Check whether a borrower has an on-chain profile.
 */
export async function hasProfile(
  borrowerAddress: string,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "has_profile",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return result as boolean;
}

/**
 * Fetch a borrower's full on-chain profile.
 */
export async function getBorrowerProfile(
  borrowerAddress: string,
  callerAddress: string
): Promise<BorrowerProfile> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_profile",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return decodeProfile(raw);
}

/**
 * Get the maximum loan amount (in stroops) the borrower is eligible for.
 */
export async function getMaxLoan(
  borrowerAddress: string,
  callerAddress: string
): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "calculate_max_loan",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return BigInt(result as string | number);
}

/**
 * Get the borrower's current interest rate in basis-points (1500 = 15.00 %).
 */
export async function getInterestRate(
  borrowerAddress: string,
  callerAddress: string
): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "calculate_interest_rate",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return Number(result);
}

export async function isAccountFrozen(
  borrowerAddress: string,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "is_frozen",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return result as boolean;
}

// ─── Write functions (require Freighter signature) ────────────────────────────

/**
 * Borrower registers their on-chain profile (called after KYC approval).
 * The borrower's wallet must sign this transaction.
 */
export async function initBorrowerProfile(borrowerAddress: string) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "init_borrower",
    args: [addressToScVal(borrowerAddress)],
    callerAddress: borrowerAddress,
  });
}

/**
 * Apply a reputation event (admin only).
 * `callerAddress` must be the contract admin wallet.
 */
export async function addReputationEvent(
  callerAddress: string,
  borrowerAddress: string,
  event: ReputationEvent
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "add_reputation_event",
    args: [
      addressToScVal(callerAddress),
      addressToScVal(borrowerAddress),
      enumToScVal(event),
    ],
    callerAddress,
  });
}

/**
 * Freeze a borrower account (admin only).
 */
export async function freezeAccount(
  adminAddress: string,
  borrowerAddress: string,
  reason: string
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "freeze_account",
    args: [
      addressToScVal(adminAddress),
      addressToScVal(borrowerAddress),
      stringToScVal(reason),
    ],
    callerAddress: adminAddress,
  });
}

/**
 * Unfreeze a borrower account (admin only).
 */
export async function unfreezeAccount(
  adminAddress: string,
  borrowerAddress: string
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "unfreeze_account",
    args: [addressToScVal(adminAddress), addressToScVal(borrowerAddress)],
    callerAddress: adminAddress,
  });
}

// ─── Credit Oracle ────────────────────────────────────────────────────────────

/**
 * Read the currently authorized oracle address.
 */
export async function getOracle(callerAddress: string): Promise<string> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_oracle",
    args: [],
    callerAddress,
  });
  return result as string;
}

/**
 * Whether a borrower has any oracle credit data on-chain.
 */
export async function hasOracleData(
  borrowerAddress: string,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "has_oracle_data",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return result as boolean;
}

/**
 * Fetch a borrower's latest oracle credit data.
 */
export async function getOracleData(
  borrowerAddress: string,
  callerAddress: string
): Promise<OracleCreditData> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_oracle_data",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return decodeOracleData(raw);
}

/**
 * Register / rotate the authorized oracle (admin only — admin wallet signs).
 */
export async function setOracle(adminAddress: string, oracleAddress: string) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "set_oracle",
    args: [addressToScVal(adminAddress), addressToScVal(oracleAddress)],
    callerAddress: adminAddress,
  });
}

/**
 * Post verified off-chain credit data on-chain (oracle only — oracle wallet signs).
 *
 * NOTE: In production the credit score is posted by the trusted backend oracle
 * via `scripts/oracle-post-credit-score.mjs` (signed with the oracle secret key).
 * This browser-side wrapper exists for admin tooling / manual review flows where
 * the oracle key is held in a connected wallet.
 */
export async function submitCreditScore(
  oracleAddress: string,
  borrowerAddress: string,
  creditScore: number,
  dataSources: number,
  provider: string
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "submit_credit_score",
    args: [
      addressToScVal(oracleAddress),
      addressToScVal(borrowerAddress),
      u32ToScVal(creditScore),
      u32ToScVal(dataSources),
      stringToScVal(provider),
    ],
    callerAddress: oracleAddress,
  });
}

// ─── Decoder helpers ──────────────────────────────────────────────────────────

function decodeProfile(raw: unknown): BorrowerProfile {
  // scValToNative returns a plain object with snake_case keys matching the Rust struct
  const r = raw as Record<string, unknown>;
  return {
    address: r.address as string,
    reputationScore: BigInt(r.reputation_score as string | number),
    reputationTier: extractEnumVariant(r.reputation_tier) as BorrowerProfile["reputationTier"],
    totalBorrowed: BigInt(r.total_borrowed as string | number),
    totalRepaid: BigInt(r.total_repaid as string | number),
    defaultCount: Number(r.default_count),
    loanCount: Number(r.loan_count),
    createdAt: BigInt(r.created_at as string | number),
    isFrozen: r.is_frozen as boolean,
    freezeReason: r.freeze_reason as string,
  };
}

function decodeOracleData(raw: unknown): OracleCreditData {
  const r = raw as Record<string, unknown>;
  return {
    creditScore: Number(r.credit_score),
    dataSources: Number(r.data_sources),
    loanLimitBoostBps: Number(r.loan_limit_boost_bps),
    provider: r.provider as string,
    updatedAt: BigInt(r.updated_at as string | number),
  };
}

function extractEnumVariant(val: unknown): string {
  // Enum contracttypes decode as { variantName: {} } objects via scValToNative
  if (val && typeof val === "object") {
    return Object.keys(val as object)[0];
  }
  return String(val);
}
