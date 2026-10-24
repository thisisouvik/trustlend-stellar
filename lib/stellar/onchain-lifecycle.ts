/**
 * lib/stellar/onchain-lifecycle.ts
 *
 * Server-side mirror of the loan lifecycle onto the Soroban LendingContract.
 *
 * XLM itself moves through classic PAYMENT operations that the wallets sign
 * (see verify-payment.ts). The contract is the auditable record of *state*:
 *
 *   create_loan_request  — signed by the borrower in the browser; this module
 *                          verifies that transaction before the loan row is
 *                          created (`verifyContractInvocation` + `readOnchainLoan`).
 *   approve_loan         — signed by the lender who completes the funding.
 *   activate_loan        — admin-signed here once the funding payment is verified.
 *   record_payment       — admin-signed here once a repayment payment is verified.
 *   mark_defaulted       — admin/multisig via lib/scheduler/default-management.ts.
 *
 * Pool deposits and withdrawals are mirrored to the PooledLendingContract
 * with `update_pool_state`.
 *
 * Everything is gated by `onchainLifecycleMode()` so a deployment without the
 * contracts (or without ADMIN_SECRET_KEY) degrades to database-only mode with
 * an explicit error instead of silently skipping the chain.
 *
 * SERVER-ONLY: imports the admin signer. Never import from client components.
 */

import {
  Address,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { getAdminKeypair, invokeReadOnly, invokeSigned, addr, i128, u32 } from "./server-contract";

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

export const STROOPS_PER_XLM = 10_000_000n;

export const xlmToStroops = (xlm: number): bigint =>
  BigInt(Math.round(xlm * Number(STROOPS_PER_XLM)));

export const stroopsToXlm = (stroops: bigint | number): number =>
  Number(stroops) / Number(STROOPS_PER_XLM);

// ─── Configuration ───────────────────────────────────────────────────────────

export { onchainLifecycleMode, isOnchainLifecycleRequired, type LifecycleMode } from "./lifecycle-mode";

export class OnchainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnchainConfigError";
  }
}

export function lendingContractId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.NEXT_PUBLIC_LENDING_CONTRACT_ID;
  if (!id) throw new OnchainConfigError("NEXT_PUBLIC_LENDING_CONTRACT_ID is not configured");
  return id;
}

export function pooledLendingContractId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID || null;
}

/** The admin keypair, or a clear error when the server cannot sign. */
export function requireAdminSigner(): Keypair {
  const signer = getAdminKeypair();
  if (!signer) {
    throw new OnchainConfigError(
      "ADMIN_SECRET_KEY is not configured — the server cannot sign LendingContract calls. " +
        "Set it, or set NEXT_PUBLIC_ONCHAIN_LOAN_LIFECYCLE=off to run in database-only mode.",
    );
  }
  return signer;
}

function adminAddress(): string {
  const signer = getAdminKeypair();
  if (signer) return signer.publicKey();
  const configured = process.env.NEXT_PUBLIC_ADMIN_ADDRESS;
  if (configured) return configured;
  throw new OnchainConfigError("Neither ADMIN_SECRET_KEY nor NEXT_PUBLIC_ADMIN_ADDRESS is configured");
}

// ─── Transaction verification (Soroban RPC) ──────────────────────────────────

export interface RpcTransactionLookup {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  /** Base64 TransactionEnvelope, present for SUCCESS/FAILED. */
  envelopeXdr?: string;
  /** Base64 ScVal return value, present for SUCCESS when the fn returns one. */
  returnValue?: string;
}

export interface LifecycleDeps {
  getTransaction(hash: string): Promise<RpcTransactionLookup>;
}

async function defaultGetTransaction(hash: string): Promise<RpcTransactionLookup> {
  const server = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: SOROBAN_RPC_URL.startsWith("http://") });
  const res = await server.getTransaction(hash);
  if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { status: "NOT_FOUND" };
  const envelope = "envelopeXdr" in res && res.envelopeXdr ? res.envelopeXdr.toXDR("base64") : undefined;
  if (res.status === rpc.Api.GetTransactionStatus.FAILED) return { status: "FAILED", envelopeXdr: envelope };
  return {
    status: "SUCCESS",
    envelopeXdr: envelope,
    returnValue: res.returnValue ? res.returnValue.toXDR("base64") : undefined,
  };
}

export const defaultLifecycleDeps: LifecycleDeps = { getTransaction: defaultGetTransaction };

export interface InvocationCheck {
  txHash: string;
  contractId: string;
  method: string;
  /** G... account that must have been the transaction source. */
  expectedInvoker: string;
}

export type InvocationResult =
  | { ok: true; returnValue: unknown }
  | { ok: false; status: number; reason: string };

function innerTransaction(envelope: Transaction | FeeBumpTransaction): Transaction {
  return "innerTransaction" in envelope ? envelope.innerTransaction : envelope;
}

/**
 * Confirm that `txHash` is a successful invocation of `method` on `contractId`
 * whose source account is `expectedInvoker`, and return its decoded result.
 */
export async function verifyContractInvocation(
  check: InvocationCheck,
  deps: LifecycleDeps = defaultLifecycleDeps,
): Promise<InvocationResult> {
  const hash = check.txHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return { ok: false, status: 400, reason: "Transaction hash is not a valid Stellar hash" };
  }

  let lookup: RpcTransactionLookup;
  try {
    lookup = await deps.getTransaction(hash);
  } catch (error) {
    return { ok: false, status: 502, reason: `Soroban RPC unavailable: ${(error as Error).message}` };
  }

  if (lookup.status === "NOT_FOUND") {
    return { ok: false, status: 404, reason: "Contract transaction not found on the Stellar network" };
  }
  if (lookup.status === "FAILED") {
    return { ok: false, status: 422, reason: "Contract transaction failed on-chain" };
  }
  if (!lookup.envelopeXdr) {
    return { ok: false, status: 422, reason: "Soroban RPC returned no envelope for the transaction" };
  }

  let tx: Transaction;
  try {
    tx = innerTransaction(TransactionBuilder.fromXDR(lookup.envelopeXdr, NETWORK_PASSPHRASE));
  } catch (error) {
    return { ok: false, status: 422, reason: `Could not decode transaction envelope: ${(error as Error).message}` };
  }

  if (tx.source !== check.expectedInvoker) {
    return { ok: false, status: 422, reason: "Contract transaction was not signed by the expected wallet" };
  }

  const op = tx.operations[0] as { type?: string; func?: xdr.HostFunction } | undefined;
  if (!op || op.type !== "invokeHostFunction" || !op.func) {
    return { ok: false, status: 422, reason: "Transaction is not a contract invocation" };
  }
  if (op.func.switch().name !== "hostFunctionTypeInvokeContract") {
    return { ok: false, status: 422, reason: "Transaction does not invoke a contract function" };
  }

  const invocation = op.func.invokeContract();
  const calledContract = Address.fromScAddress(invocation.contractAddress()).toString();
  const calledMethod = invocation.functionName().toString();

  if (calledContract !== check.contractId) {
    return { ok: false, status: 422, reason: "Transaction targets a different contract" };
  }
  if (calledMethod !== check.method) {
    return { ok: false, status: 422, reason: `Transaction calls ${calledMethod}, expected ${check.method}` };
  }

  const returnValue = lookup.returnValue
    ? scValToNative(xdr.ScVal.fromXDR(lookup.returnValue, "base64"))
    : null;

  return { ok: true, returnValue };
}

// ─── Loan reads ──────────────────────────────────────────────────────────────

export type OnchainLoanStatus = "Pending" | "Approved" | "Active" | "Repaid" | "Defaulted" | "Cancelled";

export interface OnchainLoan {
  id: number;
  borrower: string;
  lender: string;
  amountStroops: bigint;
  durationDays: number;
  interestRateBps: number;
  totalDueStroops: bigint;
  remainingDueStroops: bigint;
  status: OnchainLoanStatus;
  escrowId: number;
}

export interface OnchainCollateralEntry {
  asset: string;
  amountStroops: bigint;
}

/** `scValToNative` renders unit enum variants as `[variant]` or `variant`. */
export function decodeEnumVariant(value: unknown): string {
  if (Array.isArray(value)) return String(value[0]);
  if (value && typeof value === "object" && "0" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)["0"]);
  }
  return String(value);
}

export function decodeOnchainLoan(raw: unknown): OnchainLoan {
  const r = raw as Record<string, unknown>;
  const toBig = (v: unknown) => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));
  return {
    id: Number(r.id),
    borrower: String(r.borrower),
    lender: String(r.lender),
    amountStroops: toBig(r.amount),
    durationDays: Number(r.duration_days),
    interestRateBps: Number(r.interest_rate_bps),
    totalDueStroops: toBig(r.total_due),
    remainingDueStroops: toBig(r.remaining_due),
    status: decodeEnumVariant(r.status) as OnchainLoanStatus,
    escrowId: Number(r.escrow_id ?? 0),
  };
}

export async function readOnchainLoan(onchainLoanId: number): Promise<OnchainLoan> {
  const raw = await invokeReadOnly({
    contractId: lendingContractId(),
    method: "get_loan",
    args: [u32(onchainLoanId)],
    sourceAddress: adminAddress(),
  });
  return decodeOnchainLoan(raw);
}

/**
 * Read the borrower's collateral vault entries from the LendingContract
 * (`get_user_collateral_entries`).
 */
export async function readUserCollateralEntries(
  borrowerAddress: string,
): Promise<OnchainCollateralEntry[]> {
  const raw = await invokeReadOnly({
    contractId: lendingContractId(),
    method: "get_user_collateral_entries",
    args: [addr(borrowerAddress)],
    sourceAddress: adminAddress(),
  });
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const amountRaw = record.amount ?? record.amountStroops ?? 0;
    return {
      asset: String(record.asset ?? ""),
      amountStroops: typeof amountRaw === "bigint" ? amountRaw : BigInt(String(amountRaw)),
    };
  });
}

/**
 * Read the borrower's health factor in basis points (`get_health_factor`, where
 * 10000 = 1.00x healthy threshold) from the LendingContract.
 */
export async function readBorrowerHealthFactor(borrowerAddress: string): Promise<number> {
  const raw = await invokeReadOnly({
    contractId: lendingContractId(),
    method: "get_health_factor",
    args: [addr(borrowerAddress)],
    sourceAddress: adminAddress(),
  });
  return Number(raw ?? 0);
}

// ─── Admin-signed writes ─────────────────────────────────────────────────────

export async function activateLoanOnchain(onchainLoanId: number): Promise<{ hash: string }> {
  const signer = requireAdminSigner();
  const { hash } = await invokeSigned({
    contractId: lendingContractId(),
    method: "activate_loan",
    args: [addr(signer.publicKey()), u32(onchainLoanId)],
    signer,
  });
  return { hash };
}

export async function recordPaymentOnchain(
  onchainLoanId: number,
  amountStroops: bigint,
): Promise<{ hash: string; status: OnchainLoanStatus }> {
  const signer = requireAdminSigner();
  const { hash, returnValue } = await invokeSigned({
    contractId: lendingContractId(),
    method: "record_payment",
    args: [addr(signer.publicKey()), u32(onchainLoanId), i128(amountStroops)],
    signer,
  });
  return { hash, status: decodeEnumVariant(returnValue) as OnchainLoanStatus };
}

/**
 * Mirror a pool's aggregate supply / borrows to the PooledLendingContract.
 * Returns null when no pooled-lending contract is configured.
 */
export async function syncPoolStateOnchain(params: {
  onchainPoolId: number;
  totalSupplyStroops: bigint;
  totalBorrowsStroops: bigint;
}): Promise<{ hash: string } | null> {
  const contractId = pooledLendingContractId();
  if (!contractId) return null;
  const signer = requireAdminSigner();
  const { hash } = await invokeSigned({
    contractId,
    method: "update_pool_state",
    args: [
      addr(signer.publicKey()),
      u32(params.onchainPoolId),
      i128(params.totalSupplyStroops),
      i128(params.totalBorrowsStroops),
    ],
    signer,
  });
  return { hash };
}

/** Register / update the interest-rate curve of a pool on the PooledLendingContract. */
export async function setPoolConfigOnchain(
  onchainPoolId: number,
  config: {
    baseRateBps: number;
    multiplierPerSlopeBps: number;
    jumpMultiplierBps: number;
    kinkBps: number;
    reserveFactorBps: number;
  },
): Promise<{ hash: string }> {
  const contractId = pooledLendingContractId();
  if (!contractId) throw new OnchainConfigError("NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID is not configured");
  const signer = requireAdminSigner();
  // ScMap keys must be sorted.
  const entries: Array<[string, number]> = [
    ["base_rate_bps", config.baseRateBps],
    ["jump_multiplier_bps", config.jumpMultiplierBps],
    ["kink_bps", config.kinkBps],
    ["multiplier_per_slope_bps", config.multiplierPerSlopeBps],
    ["reserve_factor_bps", config.reserveFactorBps],
  ];
  const encoded = xdr.ScVal.scvMap(
    entries.map(([key, value]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: u32(value) })),
  );
  const { hash } = await invokeSigned({
    contractId,
    method: "set_pool_config",
    args: [addr(signer.publicKey()), u32(onchainPoolId), encoded],
    signer,
  });
  return { hash };
}

// ─── Loan metadata helpers ───────────────────────────────────────────────────

/** Keys stored in `loans.metadata` that link a row to its on-chain record. */
export interface OnchainLoanMetadata {
  onchain_loan_id?: number;
  onchain_request_tx?: string;
  onchain_approve_tx?: string;
  onchain_activate_tx?: string;
  onchain_payment_txs?: string[];
  onchain_status?: OnchainLoanStatus;
  onchain_error?: string;
  onchain_collateral_verified?: boolean;
  onchain_health_factor_bps?: number;
}

export function readOnchainLoanId(metadata: unknown): number | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const raw = meta.onchain_loan_id ?? meta.onchainLoanId;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
