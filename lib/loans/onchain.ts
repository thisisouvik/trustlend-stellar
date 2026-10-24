/**
 * lib/loans/onchain.ts
 *
 * Glue between the loan API routes and the LendingContract mirror in
 * lib/stellar/onchain-lifecycle.ts. Each helper:
 *
 *   - is a no-op (`attempted: false`) when the lifecycle is switched off or
 *     the loan row was created before on-chain loans were required,
 *   - never throws: the XLM payment it follows has already been verified and
 *     recorded, so a chain failure is written to `loans.metadata` and returned
 *     to the caller instead of unwinding the database write,
 *   - records every transaction hash it sees in `loans.metadata` so the
 *     dashboard can link to them.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { loans } from "@/lib/db/schema";
import {
  activateLoanOnchain,
  isOnchainLifecycleRequired,
  lendingContractId,
  readBorrowerHealthFactor,
  readOnchainLoan,
  readOnchainLoanId,
  readUserCollateralEntries,
  recordPaymentOnchain,
  verifyContractInvocation,
  xlmToStroops,
  type OnchainCollateralEntry,
  type OnchainLoanMetadata,
  type OnchainLoanStatus,
} from "@/lib/stellar/onchain-lifecycle";

/** Minimum required health factor in basis points (10,000 bps = 1.00x). */
export const MIN_HEALTH_FACTOR_BPS = 10_000;

export type OnchainOutcome =
  | { attempted: false; reason?: string }
  | { attempted: true; ok: true; txHash: string; status: OnchainLoanStatus }
  | { attempted: true; ok: false; error: string };

async function mergeLoanMetadata(db: Db, loanId: string, patch: OnchainLoanMetadata): Promise<void> {
  await db
    .update(loans)
    .set({ metadata: sql`${loans.metadata} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(loans.id, loanId));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CollateralVerificationResult =
  | {
      ok: true;
      entries: OnchainCollateralEntry[];
      totalCollateralStroops: bigint;
      healthFactorBps: number;
    }
  | { ok: false; status: number; reason: string };

/**
 * Verify that the borrower has deposited sufficient collateral into the on-chain
 * LendingContract vault (`get_user_collateral_entries`) and maintains a healthy
 * collateral ratio / health factor (`get_health_factor` >= 10,000 bps).
 */
export async function verifyBorrowerCollateralOnchain(params: {
  borrowerAddress: string;
  requiredAmountStroops: bigint;
}): Promise<CollateralVerificationResult> {
  if (!isOnchainLifecycleRequired()) {
    return {
      ok: true,
      entries: [],
      totalCollateralStroops: params.requiredAmountStroops,
      healthFactorBps: MIN_HEALTH_FACTOR_BPS,
    };
  }

  let entries: OnchainCollateralEntry[];
  let healthFactorBps: number;
  try {
    entries = await readUserCollateralEntries(params.borrowerAddress);
    healthFactorBps = await readBorrowerHealthFactor(params.borrowerAddress);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      reason: `Could not verify on-chain collateral for ${params.borrowerAddress}: ${errorMessage(error)}`,
    };
  }

  const totalCollateralStroops = entries.reduce(
    (sum, entry) => sum + (entry.amountStroops > 0n ? entry.amountStroops : 0n),
    0n,
  );

  if (entries.length === 0 || totalCollateralStroops < params.requiredAmountStroops) {
    return {
      ok: false,
      status: 422,
      reason: "Insufficient on-chain collateral deposited in the lending vault",
    };
  }

  if (!Number.isFinite(healthFactorBps) || healthFactorBps < MIN_HEALTH_FACTOR_BPS) {
    return {
      ok: false,
      status: 422,
      reason: `Borrower health factor (${healthFactorBps} bps) is below minimum threshold (${MIN_HEALTH_FACTOR_BPS} bps)`,
    };
  }

  return {
    ok: true,
    entries,
    totalCollateralStroops,
    healthFactorBps,
  };
}

/**
 * Called by POST /api/loans/fund before recording lender contributions when
 * on-chain loan lifecycle is active, ensuring the borrower's collateral is still
 * locked in custody before lenders fund the loan.
 */
export async function verifyLoanCollateralForFunding(params: {
  loanMetadata: unknown;
  borrowerWallet: string;
  principalAmountXlm: number;
}): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  if (!isOnchainLifecycleRequired()) return { ok: true };
  const onchainLoanId = readOnchainLoanId(params.loanMetadata);
  if (!onchainLoanId) return { ok: true };

  return verifyBorrowerCollateralOnchain({
    borrowerAddress: params.borrowerWallet,
    requiredAmountStroops: xlmToStroops(params.principalAmountXlm),
  });
}

/**
 * Called by POST /api/loans/fund once the contribution that completes the
 * funding has been verified and recorded.
 *
 * Expects the completing lender to have signed `approve_loan(lender, id, 0)`
 * (escrow id 0: direct funding bypasses the escrow contract) and to have sent
 * that hash as `approveTxHash`. The server then signs `activate_loan`.
 */
export async function activateFundedLoanOnchain(params: {
  db: Db;
  loanId: string;
  loanMetadata: unknown;
  lenderAddress: string;
  approveTxHash?: string;
}): Promise<OnchainOutcome> {
  const { db, loanId } = params;
  if (!isOnchainLifecycleRequired()) return { attempted: false, reason: "lifecycle off" };

  const onchainLoanId = readOnchainLoanId(params.loanMetadata);
  if (!onchainLoanId) {
    return { attempted: false, reason: "loan predates on-chain requests" };
  }

  try {
    if (!params.approveTxHash) {
      throw new Error("approveTxHash is required: the completing lender must sign approve_loan");
    }

    const approval = await verifyContractInvocation({
      txHash: params.approveTxHash,
      contractId: lendingContractId(),
      method: "approve_loan",
      expectedInvoker: params.lenderAddress,
    });
    if (!approval.ok) throw new Error(`approve_loan verification failed: ${approval.reason}`);

    const loan = await readOnchainLoan(onchainLoanId);
    if (loan.status === "Active") {
      // Already activated (retry after a partial failure) — just record it.
      await mergeLoanMetadata(db, loanId, {
        onchain_approve_tx: params.approveTxHash,
        onchain_status: "Active",
        onchain_error: undefined,
      });
      return { attempted: true, ok: true, txHash: params.approveTxHash, status: "Active" };
    }
    if (loan.status !== "Approved") {
      throw new Error(`on-chain loan is ${loan.status}, expected Approved`);
    }
    if (loan.lender !== params.lenderAddress) {
      throw new Error("on-chain loan was approved by a different lender");
    }

    const { hash } = await activateLoanOnchain(onchainLoanId);
    await mergeLoanMetadata(db, loanId, {
      onchain_approve_tx: params.approveTxHash,
      onchain_activate_tx: hash,
      onchain_status: "Active",
      onchain_error: undefined,
    });
    return { attempted: true, ok: true, txHash: hash, status: "Active" };
  } catch (error) {
    const message = errorMessage(error);
    console.error("[onchain] activate_loan failed for loan %s:", loanId, message);
    await mergeLoanMetadata(db, loanId, {
      onchain_approve_tx: params.approveTxHash,
      onchain_error: `activate: ${message}`,
    }).catch(() => {});
    return { attempted: true, ok: false, error: message };
  }
}

/**
 * Called by POST /api/loans/repay after a repayment payment has been verified
 * and recorded. Signs `record_payment` so the contract's remaining balance and
 * status track the off-chain ledger.
 */
export async function recordRepaymentOnchain(params: {
  db: Db;
  loanId: string;
  loanMetadata: unknown;
  amountXlm: number;
}): Promise<OnchainOutcome> {
  const { db, loanId } = params;
  if (!isOnchainLifecycleRequired()) return { attempted: false, reason: "lifecycle off" };

  const onchainLoanId = readOnchainLoanId(params.loanMetadata);
  if (!onchainLoanId) {
    return { attempted: false, reason: "loan predates on-chain requests" };
  }

  try {
    const loan = await readOnchainLoan(onchainLoanId);
    if (loan.status !== "Active") {
      throw new Error(`on-chain loan is ${loan.status}, expected Active`);
    }

    // The contract rejects overpayment; cap at what it still tracks as due.
    const requested = xlmToStroops(params.amountXlm);
    const amountStroops = requested > loan.remainingDueStroops ? loan.remainingDueStroops : requested;
    if (amountStroops <= 0n) throw new Error("nothing left to record on-chain");

    const { hash, status } = await recordPaymentOnchain(onchainLoanId, amountStroops);
    const previous = ((params.loanMetadata ?? {}) as OnchainLoanMetadata).onchain_payment_txs ?? [];
    await mergeLoanMetadata(db, loanId, {
      onchain_payment_txs: [...previous, hash],
      onchain_status: status,
      onchain_error: undefined,
    });
    return { attempted: true, ok: true, txHash: hash, status };
  } catch (error) {
    const message = errorMessage(error);
    console.error("[onchain] record_payment failed for loan %s:", loanId, message);
    await mergeLoanMetadata(db, loanId, { onchain_error: `record_payment: ${message}` }).catch(() => {});
    return { attempted: true, ok: false, error: message };
  }
}

// ─── Loan request verification (POST /api/loans/apply) ───────────────────────

export type LoanRequestCheck =
  | { ok: true; metadata: OnchainLoanMetadata }
  | { ok: false; status: number; reason: string };

/**
 * When the lifecycle is required, confirm that the borrower really signed
 * `create_loan_request` and that the on-chain record matches what they are
 * asking the database to store. Returns the metadata to persist on the row.
 */
export async function verifyOnchainLoanRequest(params: {
  db: Db;
  onchainLoanId: unknown;
  onchainTxHash: unknown;
  walletAddress: string;
  /** Wallets this account is allowed to sign from (session + profile). */
  borrowerWallets: string[];
  amountXlm: number;
  durationDays: number;
  interestRateBps: number;
}): Promise<LoanRequestCheck> {
  if (!isOnchainLifecycleRequired()) return { ok: true, metadata: {} };

  const onchainLoanId = Number(params.onchainLoanId);
  const txHash = typeof params.onchainTxHash === "string" ? params.onchainTxHash.trim() : "";

  if (!Number.isInteger(onchainLoanId) || onchainLoanId <= 0 || !txHash) {
    return {
      ok: false,
      status: 400,
      reason:
        "On-chain loan requests are required: sign create_loan_request with your wallet and send onchainLoanId + onchainTxHash",
    };
  }

  const allowed = new Set(params.borrowerWallets.filter((w) => w.length > 0));
  if (!params.walletAddress || !allowed.has(params.walletAddress)) {
    return { ok: false, status: 400, reason: "walletAddress does not match a wallet linked to your account" };
  }

  let contractId: string;
  try {
    contractId = lendingContractId();
  } catch (error) {
    return { ok: false, status: 503, reason: errorMessage(error) };
  }

  const invocation = await verifyContractInvocation({
    txHash,
    contractId,
    method: "create_loan_request",
    expectedInvoker: params.walletAddress,
  });
  if (!invocation.ok) {
    return { ok: false, status: invocation.status, reason: `On-chain request verification failed: ${invocation.reason}` };
  }
  if (invocation.returnValue !== null && Number(invocation.returnValue) !== onchainLoanId) {
    return { ok: false, status: 422, reason: "onchainLoanId does not match the id returned by create_loan_request" };
  }

  let loan;
  try {
    loan = await readOnchainLoan(onchainLoanId);
  } catch (error) {
    return { ok: false, status: 502, reason: `Could not read on-chain loan ${onchainLoanId}: ${errorMessage(error)}` };
  }
  if (loan.borrower !== params.walletAddress) {
    return { ok: false, status: 422, reason: "On-chain loan belongs to a different borrower" };
  }
  if (loan.amountStroops !== xlmToStroops(params.amountXlm)) {
    return { ok: false, status: 422, reason: "On-chain loan amount does not match the requested amount" };
  }
  if (loan.durationDays !== params.durationDays) {
    return { ok: false, status: 422, reason: "On-chain loan duration does not match the requested duration" };
  }
  if (loan.interestRateBps !== params.interestRateBps) {
    return { ok: false, status: 422, reason: "On-chain loan interest rate does not match the quoted APR" };
  }
  if (loan.status !== "Pending") {
    return { ok: false, status: 409, reason: `On-chain loan is already ${loan.status}` };
  }

  // Verify on-chain collateral custody and borrower health factor (#427)
  const collateralCheck = await verifyBorrowerCollateralOnchain({
    borrowerAddress: params.walletAddress,
    requiredAmountStroops: loan.amountStroops,
  });
  if (!collateralCheck.ok) {
    return {
      ok: false,
      status: collateralCheck.status,
      reason: collateralCheck.reason,
    };
  }

  // One on-chain loan maps to exactly one row.
  const [existing] = await params.db
    .select({ id: loans.id })
    .from(loans)
    .where(sql`(${loans.metadata}->>'onchain_loan_id')::int = ${onchainLoanId}`)
    .limit(1);
  if (existing) {
    return { ok: false, status: 409, reason: "This on-chain loan request has already been recorded" };
  }

  return {
    ok: true,
    metadata: {
      onchain_loan_id: onchainLoanId,
      onchain_request_tx: txHash.toLowerCase(),
      onchain_status: "Pending",
    },
  };
}
