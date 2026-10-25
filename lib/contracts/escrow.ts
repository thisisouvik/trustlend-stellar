/**
 * lib/contracts/escrow.ts
 *
 * TypeScript client for the EscrowContract.
 */

import {
  callContract,
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";
import type { EscrowHold, EscrowStatus } from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_ESCROW_CONTRACT_ID is not set. " +
      "Deploy the contract and add the ID to .env.local"
  );
}

// ─── Read functions ───────────────────────────────────────────────────────────

export async function getEscrowHold(
  escrowId: number,
  callerAddress: string
): Promise<EscrowHold> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_hold",
    args: [u32ToScVal(escrowId)],
    callerAddress,
  });
  return decodeHold(raw);
}

export async function isWithinRevocationWindow(
  escrowId: number,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "is_within_revocation_window",
    args: [u32ToScVal(escrowId)],
    callerAddress,
  });
  return result as boolean;
}

export async function getEscrowCount(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_escrow_count",
    args: [],
    callerAddress,
  });
  return Number(result);
}

// ─── Write functions ──────────────────────────────────────────────────────────

/**
 * Lock the lender's tokens in the escrow contract and register the hold.
 * Returns the new escrow ID.
 *
 * Step-by-step flow:
 * 1. Frontend calls `createEscrowHold()`; the contract pulls `amountStroops`
 *    of `tokenAddress` from the lender into its own custody.
 * 2. Within 3 minutes the lender may call `revokeEscrowHold()` to get a refund.
 * 3. After 3 minutes the admin calls `confirmDisbursement()` and the contract
 *    pays the borrower.
 */
export async function createEscrowHold(
  lenderAddress: string,
  borrowerAddress: string,
  tokenAddress: string,
  loanId: number,
  amountStroops: bigint
): Promise<number> {
  const result = await callContract({
    contractId: CONTRACT_ID,
    method: "create_hold",
    args: [
      addressToScVal(lenderAddress),
      addressToScVal(borrowerAddress),
      addressToScVal(tokenAddress),
      u32ToScVal(loanId),
      i128ToScVal(amountStroops),
    ],
    callerAddress: lenderAddress,
  });
  return Number(result);
}

/**
 * Lender revokes the escrow hold within the 3-minute window.
 * The contract refunds the held tokens to the lender.
 */
export async function revokeEscrowHold(
  lenderAddress: string,
  escrowId: number
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "revoke_hold",
    args: [addressToScVal(lenderAddress), u32ToScVal(escrowId)],
    callerAddress: lenderAddress,
  });
}

/**
 * Admin releases the held tokens to the borrower after the revocation window.
 */
export async function confirmDisbursement(
  adminAddress: string,
  escrowId: number
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "confirm_disbursement",
    args: [addressToScVal(adminAddress), u32ToScVal(escrowId)],
    callerAddress: adminAddress,
  });
}

// ─── Decoder ──────────────────────────────────────────────────────────────────

function decodeHold(raw: unknown): EscrowHold {
  const r = raw as Record<string, unknown>;
  return {
    id: Number(r.id),
    loanId: Number(r.loan_id),
    lender: r.lender as string,
    borrower: r.borrower as string,
    amount: BigInt(r.amount as string | number),
    heldAt: BigInt(r.held_at as string | number),
    expiresAt: BigInt(r.expires_at as string | number),
    status: extractEnumVariant(r.status) as EscrowStatus,
  };
}

function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") {
    return Object.keys(val as object)[0];
  }
  return String(val);
}
