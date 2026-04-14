/**
 * lib/contracts/lending.ts
 *
 * TypeScript client for the LendingContract.
 */

import {
  callContract,
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";
import type { LoanRecord, LoanStatus, PaymentRecord } from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_LENDING_CONTRACT_ID is not set. " +
      "Deploy the contract and add the ID to .env.local"
  );
}

// ─── Read functions ───────────────────────────────────────────────────────────

export async function getLoan(
  loanId: number,
  callerAddress: string
): Promise<LoanRecord> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_loan",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return decodeLoan(raw);
}

export async function getLoanCount(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_loan_count",
    args: [],
    callerAddress,
  });
  return Number(result);
}

export async function isLoanOverdue(
  loanId: number,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "is_overdue",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return result as boolean;
}

export async function getDaysOverdue(
  loanId: number,
  callerAddress: string
): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "days_overdue",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return BigInt(result as string | number);
}

export async function getPaymentCount(
  loanId: number,
  callerAddress: string
): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_payment_count",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return Number(result);
}

export async function getPayment(
  loanId: number,
  paymentIndex: number,
  callerAddress: string
): Promise<PaymentRecord> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_payment",
    args: [u32ToScVal(loanId), u32ToScVal(paymentIndex)],
    callerAddress,
  });
  return decodePayment(raw);
}

// ─── Write functions ──────────────────────────────────────────────────────────

/**
 * Borrower creates a loan request.
 * `interestRateBps` and `maxLoanAmount` should be fetched from the
 * ReputationContract first and passed here.
 */
export async function createLoanRequest(
  borrowerAddress: string,
  amountStroops: bigint,
  durationDays: number,
  interestRateBps: number,
  maxLoanAmountStroops: bigint
): Promise<number> {
  const result = await callContract({
    contractId: CONTRACT_ID,
    method: "create_loan_request",
    args: [
      addressToScVal(borrowerAddress),
      i128ToScVal(amountStroops),
      u32ToScVal(durationDays),
      u32ToScVal(interestRateBps),
      i128ToScVal(maxLoanAmountStroops),
    ],
    callerAddress: borrowerAddress,
  });
  return Number(result);
}

/**
 * Lender approves a pending loan.
 * `escrowId` is the ID returned from `createEscrowHold()`.
 */
export async function approveLoan(
  lenderAddress: string,
  loanId: number,
  escrowId: number
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "approve_loan",
    args: [
      addressToScVal(lenderAddress),
      u32ToScVal(loanId),
      u32ToScVal(escrowId),
    ],
    callerAddress: lenderAddress,
  });
}

/**
 * Lender revokes their approval within the 1-hour window.
 */
export async function revokeLoanApproval(
  lenderAddress: string,
  loanId: number
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "revoke_approval",
    args: [addressToScVal(lenderAddress), u32ToScVal(loanId)],
    callerAddress: lenderAddress,
  });
}

/**
 * Admin activates a loan once the disbursement PAYMENT is confirmed.
 */
export async function activateLoan(adminAddress: string, loanId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "activate_loan",
    args: [addressToScVal(adminAddress), u32ToScVal(loanId)],
    callerAddress: adminAddress,
  });
}

/**
 * Admin records a repayment after the borrower's PAYMENT op is confirmed.
 * Returns the new loan status.
 */
export async function recordPayment(
  adminAddress: string,
  loanId: number,
  amountStroops: bigint
): Promise<LoanStatus> {
  const result = await callContract({
    contractId: CONTRACT_ID,
    method: "record_payment",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(loanId),
      i128ToScVal(amountStroops),
    ],
    callerAddress: adminAddress,
  });
  return extractEnumVariant(result) as LoanStatus;
}

/**
 * Admin marks a loan as defaulted.
 */
export async function markLoanDefaulted(adminAddress: string, loanId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "mark_defaulted",
    args: [addressToScVal(adminAddress), u32ToScVal(loanId)],
    callerAddress: adminAddress,
  });
}

// ─── Decoders ─────────────────────────────────────────────────────────────────

function decodeLoan(raw: unknown): LoanRecord {
  const r = raw as Record<string, unknown>;
  return {
    id: Number(r.id),
    borrower: r.borrower as string,
    lender: r.lender as string,
    amount: BigInt(r.amount as string | number),
    durationDays: Number(r.duration_days),
    interestRateBps: Number(r.interest_rate_bps),
    totalDue: BigInt(r.total_due as string | number),
    remainingDue: BigInt(r.remaining_due as string | number),
    createdAt: BigInt(r.created_at as string | number),
    dueAt: BigInt(r.due_at as string | number),
    status: extractEnumVariant(r.status) as LoanStatus,
    escrowId: Number(r.escrow_id),
    platformFee: BigInt(r.platform_fee as string | number),
  };
}

function decodePayment(raw: unknown): PaymentRecord {
  const r = raw as Record<string, unknown>;
  return {
    loanId: Number(r.loan_id),
    amount: BigInt(r.amount as string | number),
    paidAt: BigInt(r.paid_at as string | number),
  };
}

function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") {
    return Object.keys(val as object)[0];
  }
  return String(val);
}
