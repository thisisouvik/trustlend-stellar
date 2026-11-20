/**
 * lib/stellar/sponsorship.ts
 *
 * Validation for the fee-sponsorship endpoint (`POST /api/sponsor`).
 *
 * The platform wraps borrower transactions in a FeeBumpTransaction signed with
 * ADMIN_SECRET_KEY, so every transaction we accept is paid for out of the
 * treasury's XLM. Before wrapping, the inner transaction must prove that it is
 * a TrustLend protocol call made by the signed-in borrower:
 *
 *   - it is a plain (v1) transaction, not an existing fee bump;
 *   - its source account is the borrower's own linked wallet;
 *   - it carries at least one signature;
 *   - it contains exactly one `invokeHostFunction` operation that calls
 *     `InvokeContract` on an official TrustLend contract (see
 *     `getSponsorableContractIds`), with no foreign operation source;
 *   - its total fee (inclusion + Soroban resource fee) stays under
 *     `getMaxSponsoredFeeStroops()`, so a client cannot inflate the resource
 *     fee to drain the sponsor account.
 *
 * Anything else is rejected before the platform key is ever touched.
 */

import {
  Address,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

/** Base (inclusion) fee per operation the sponsor is willing to pay, in stroops. */
export const SPONSOR_BASE_FEE_STROOPS = 100_000;

/** Default ceiling on the inner transaction's total fee: 0.5 XLM. */
export const DEFAULT_MAX_SPONSORED_FEE_STROOPS = 5_000_000;

/** Upper bound on the XDR payload size we are willing to parse. */
export const MAX_SPONSOR_XDR_LENGTH = 64 * 1024;

/**
 * Env vars naming the TrustLend protocol contracts whose calls the platform
 * sponsors. Token contracts (USDC, TLEND) and the multi-sig admin contract are
 * deliberately excluded: sponsoring plain token transfers or admin actions is
 * not a borrower protocol operation.
 */
export const SPONSORABLE_CONTRACT_ENV_VARS = [
  "NEXT_PUBLIC_LENDING_CONTRACT_ID",
  "NEXT_PUBLIC_REPUTATION_CONTRACT_ID",
  "NEXT_PUBLIC_ESCROW_CONTRACT_ID",
  "NEXT_PUBLIC_DEFAULT_CONTRACT_ID",
  "NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID",
  "NEXT_PUBLIC_USDC_LENDING_POOL_CONTRACT_ID",
  "NEXT_PUBLIC_AUTO_COMPOUND_VAULT_CONTRACT_ID",
  "NEXT_PUBLIC_BORROWER_LOYALTY_CONTRACT_ID",
  "NEXT_PUBLIC_REFERRAL_REWARDS_CONTRACT_ID",
  "NEXT_PUBLIC_ZK_CREDIT_VERIFIER_CONTRACT_ID",
  "NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID",
] as const;

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/** The set of contract IDs (C...) whose invocations may be fee-sponsored. */
export function getSponsorableContractIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ids = new Set<string>();
  for (const name of SPONSORABLE_CONTRACT_ENV_VARS) {
    const value = env[name]?.trim();
    if (value && CONTRACT_ID.test(value)) ids.add(value);
  }
  return ids;
}

/** Maximum inner-transaction fee (stroops) the sponsor will cover. */
export function getMaxSponsoredFeeStroops(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.SPONSOR_MAX_INNER_FEE_STROOPS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = BigInt(raw);
    if (parsed > 0n) return parsed;
  }
  return BigInt(DEFAULT_MAX_SPONSORED_FEE_STROOPS);
}

export type SponsorshipRejectionCode =
  | "malformed_xdr"
  | "fee_bump_not_allowed"
  | "source_mismatch"
  | "unsigned"
  | "invalid_operation_count"
  | "operation_source_mismatch"
  | "unsupported_operation"
  | "contract_not_allowed"
  | "fee_too_high"
  | "no_contracts_configured";

export type SponsorshipValidation =
  | { ok: true; transaction: Transaction; contractId: string; functionName: string }
  | { ok: false; code: SponsorshipRejectionCode; reason: string };

export interface SponsorshipValidationOptions {
  networkPassphrase: string;
  /** The signed-in borrower's linked wallet (G...). */
  walletAddress: string;
  allowedContractIds: Set<string>;
  maxFeeStroops: bigint;
}

function reject(code: SponsorshipRejectionCode, reason: string): SponsorshipValidation {
  return { ok: false, code, reason };
}

/**
 * Parse and validate a client-submitted inner transaction. Never throws:
 * malformed input is reported as `malformed_xdr`.
 */
export function validateSponsorshipTransaction(
  rawXdr: string,
  options: SponsorshipValidationOptions,
): SponsorshipValidation {
  if (options.allowedContractIds.size === 0) {
    return reject("no_contracts_configured", "No TrustLend contracts are configured for sponsorship");
  }

  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(rawXdr, options.networkPassphrase);
  } catch {
    return reject("malformed_xdr", "Transaction XDR could not be parsed");
  }

  if (parsed instanceof FeeBumpTransaction) {
    return reject("fee_bump_not_allowed", "Fee-bump transactions cannot be sponsored again");
  }
  const tx = parsed;

  if (tx.source !== options.walletAddress) {
    return reject("source_mismatch", "Transaction source must be the authenticated borrower's wallet");
  }

  if (tx.signatures.length === 0) {
    return reject("unsigned", "Transaction must be signed by the borrower before sponsorship");
  }

  if (tx.operations.length !== 1) {
    return reject("invalid_operation_count", "Sponsored transactions must contain exactly one operation");
  }

  const [op] = tx.operations;
  if (op.source && op.source !== options.walletAddress) {
    return reject("operation_source_mismatch", "Operation source must be the authenticated borrower's wallet");
  }

  if (op.type !== "invokeHostFunction") {
    return reject("unsupported_operation", `Operation type "${op.type}" is not eligible for sponsorship`);
  }

  const func = op.func as xdr.HostFunction;
  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return reject("unsupported_operation", "Only TrustLend contract invocations are eligible for sponsorship");
  }

  const invocation = func.invokeContract();
  let contractId: string;
  try {
    contractId = Address.fromScAddress(invocation.contractAddress()).toString();
  } catch {
    return reject("malformed_xdr", "Contract address could not be decoded");
  }

  if (!options.allowedContractIds.has(contractId)) {
    return reject("contract_not_allowed", "Target contract is not an official TrustLend contract");
  }

  let fee: bigint;
  try {
    fee = BigInt(tx.fee);
  } catch {
    return reject("malformed_xdr", "Transaction fee could not be decoded");
  }
  if (fee > options.maxFeeStroops) {
    return reject("fee_too_high", "Transaction fee exceeds the sponsorship limit");
  }

  // The fee bump pays SPONSOR_BASE_FEE_STROOPS per operation plus the inner
  // Soroban resource fee, and requires the inner inclusion fee not to exceed
  // that base fee.
  let resourceFee = 0n;
  try {
    const ext = tx.toEnvelope().v1().tx().ext();
    if (ext.switch() === 1) resourceFee = BigInt(ext.sorobanData().resourceFee().toString());
  } catch {
    return reject("malformed_xdr", "Soroban transaction data could not be decoded");
  }
  if (fee - resourceFee > BigInt(SPONSOR_BASE_FEE_STROOPS)) {
    return reject("fee_too_high", "Transaction inclusion fee exceeds the sponsorship base fee");
  }

  const fnName = invocation.functionName();
  const functionName = typeof fnName === "string" ? fnName : fnName.toString();

  return { ok: true, transaction: tx, contractId, functionName };
}
