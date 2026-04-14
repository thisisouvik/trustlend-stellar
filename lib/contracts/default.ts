/**
 * lib/contracts/default.ts
 *
 * TypeScript client for the DefaultManagementContract.
 */

import {
  callContract,
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
  u64ToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";
import type {
  DefaultRecord,
  DefaultPhase,
  InsuranceEvent,
} from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_DEFAULT_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_DEFAULT_CONTRACT_ID is not set. " +
      "Deploy the contract and add the ID to .env.local"
  );
}

// ─── Read functions ───────────────────────────────────────────────────────────

export async function getDefaultRecord(
  loanId: number,
  callerAddress: string
): Promise<DefaultRecord> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_default_record",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return decodeDefaultRecord(raw);
}

export async function getInsuranceBalance(
  callerAddress: string
): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_insurance_balance",
    args: [],
    callerAddress,
  });
  return BigInt(result as string | number);
}

export async function getInsuranceEventCount(
  callerAddress: string
): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_insurance_event_count",
    args: [],
    callerAddress,
  });
  return Number(result);
}

export async function getInsuranceEvent(
  eventIndex: number,
  callerAddress: string
): Promise<InsuranceEvent> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_insurance_event",
    args: [u32ToScVal(eventIndex)],
    callerAddress,
  });
  return decodeInsuranceEvent(raw);
}

// ─── Write functions ──────────────────────────────────────────────────────────

/**
 * Record / update the default phase for an overdue loan.
 * Called daily by the backend cron job after checking Horizon.
 * Returns the current DefaultPhase.
 */
export async function recordDefault(
  adminAddress: string,
  loanId: number,
  borrowerAddress: string,
  amountStroops: bigint,
  daysOverdue: bigint
): Promise<DefaultPhase> {
  const result = await callContract({
    contractId: CONTRACT_ID,
    method: "record_default",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(loanId),
      addressToScVal(borrowerAddress),
      i128ToScVal(amountStroops),
      u64ToScVal(daysOverdue),
    ],
    callerAddress: adminAddress,
  });
  return extractEnumVariant(result) as DefaultPhase;
}

/**
 * Add funds to the insurance pool (from platform fee income).
 */
export async function addToInsurance(
  adminAddress: string,
  amountStroops: bigint
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "add_to_insurance",
    args: [addressToScVal(adminAddress), i128ToScVal(amountStroops)],
    callerAddress: adminAddress,
  });
}

/**
 * Trigger an insurance payout for a defaulted loan.
 * Records the event on-chain and deducts from the fund.
 * Admin must separately send the XLM PAYMENT to the lender.
 */
export async function triggerInsurancePayout(
  adminAddress: string,
  loanId: number,
  lenderAddress: string,
  amountStroops: bigint
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "trigger_insurance_payout",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(loanId),
      addressToScVal(lenderAddress),
      i128ToScVal(amountStroops),
    ],
    callerAddress: adminAddress,
  });
}

// ─── Decoders ─────────────────────────────────────────────────────────────────

function decodeDefaultRecord(raw: unknown): DefaultRecord {
  const r = raw as Record<string, unknown>;
  return {
    loanId: Number(r.loan_id),
    borrower: r.borrower as string,
    amount: BigInt(r.amount as string | number),
    recordedAt: BigInt(r.recorded_at as string | number),
    daysOverdue: BigInt(r.days_overdue as string | number),
    phase: extractEnumVariant(r.phase) as DefaultPhase,
  };
}

function decodeInsuranceEvent(raw: unknown): InsuranceEvent {
  const r = raw as Record<string, unknown>;
  return {
    loanId: Number(r.loan_id),
    lender: r.lender as string,
    amountPaid: BigInt(r.amount_paid as string | number),
    paidAt: BigInt(r.paid_at as string | number),
  };
}

function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") {
    return Object.keys(val as object)[0];
  }
  return String(val);
}
