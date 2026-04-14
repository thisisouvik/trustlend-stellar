/**
 * lib/stellar/soroban.ts
 *
 * Core Soroban RPC helpers used by all contract wrappers.
 * Handles: transaction building → simulation → Freighter signing → submission → polling.
 *
 * Utility math helpers (stroopsToXlm, calculateInterest, etc.) live in types/contracts.ts.
 *
 * @stellar/stellar-sdk v13+ ships the RPC client as a separate sub-path:
 *   import { Server, assembleTransaction, Api } from "@stellar/stellar-sdk/rpc"
 */

import {
  TransactionBuilder,
  Transaction,
  BASE_FEE,
  Contract,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  Server,
  assembleTransaction,
  Api,
} from "@stellar/stellar-sdk/rpc";
import { signTransaction } from "@stellar/freighter-api";

// ─── Network config ───────────────────────────────────────────────────────────

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

/** Shared Soroban RPC server instance. */
export const sorobanServer = new Server(SOROBAN_RPC_URL, {
  allowHttp: false,
});

// ─── Encoding helpers ─────────────────────────────────────────────────────────

/** Encode a Stellar address string as an XDR ScVal. */
export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/** Encode a bigint as an i128 ScVal. */
export function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/** Encode a number as a u32 ScVal. */
export function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

/** Encode a bigint as a u64 ScVal. */
export function u64ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "u64" });
}

/** Encode a string as a Soroban String ScVal. */
export function stringToScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "string" });
}

/**
 * Encode a unit #[contracttype] enum variant as an ScVec([ScSymbol("Variant")]).
 * This matches the XDR representation Soroban uses for C-style enum variants.
 */
export function enumToScVal(variant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
}

/** Decode an ScVal returned by the contract back to a native JS value. */
export function decodeScVal(val: xdr.ScVal): unknown {
  return scValToNative(val);
}

// ─── Call options type ────────────────────────────────────────────────────────

export interface CallContractOptions {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /** Public key (G...) of the Freighter wallet that will sign. */
  callerAddress: string;
}

// ─── Write: build → simulate → sign → submit → poll ──────────────────────────

/**
 * Full transaction flow: build → simulate → Freighter sign → submit → poll.
 * Returns the decoded contract return value, or `null` for void functions.
 */
export async function callContract({
  contractId,
  method,
  args,
  callerAddress,
}: CallContractOptions): Promise<unknown> {
  const account = await sorobanServer.getAccount(callerAddress);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  // Simulate to get resource usage & footprint
  const simResult = await sorobanServer.simulateTransaction(tx);
  if (Api.isSimulationError(simResult)) {
    throw new Error(`Soroban simulation failed: ${simResult.error}`);
  }

  // Assemble: inject auth entries and set resources
  const preparedTx = assembleTransaction(tx, simResult).build();

  // Sign with Freighter (freighter-api v6 options use `address` not `accountToSign`)
  const freighterResult = await signTransaction(preparedTx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: callerAddress,
  });
  if ("error" in freighterResult) {
    throw new Error(`Freighter signing failed: ${freighterResult.error}`);
  }

  const signedTx = TransactionBuilder.fromXDR(
    freighterResult.signedTxXdr,
    NETWORK_PASSPHRASE
  ) as Transaction;

  // Submit
  const sendResult = await sorobanServer.sendTransaction(signedTx);
  if (sendResult.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`
    );
  }

  // Poll up to 30 seconds for finality
  const hash = sendResult.hash;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const txResult = await sorobanServer.getTransaction(hash);
    if (txResult.status === Api.GetTransactionStatus.SUCCESS) {
      return txResult.returnValue ? decodeScVal(txResult.returnValue) : null;
    }
    if (txResult.status === Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed on-chain: hash=${hash}`);
    }
    // PENDING — keep polling
  }

  throw new Error(`Transaction ${hash} timed out after 30 s`);
}

// ─── Read: simulation only (no signing required) ──────────────────────────────

/**
 * Read-only simulation — does NOT require Freighter signing.
 * Use for all `get_*` / `is_*` / `calculate_*` view functions.
 */
export async function simulateContractCall({
  contractId,
  method,
  args,
  callerAddress,
}: CallContractOptions): Promise<unknown> {
  const account = await sorobanServer.getAccount(callerAddress);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await sorobanServer.simulateTransaction(tx);

  if (Api.isSimulationError(simResult)) {
    throw new Error(`Simulation error: ${simResult.error}`);
  }
  if (!Api.isSimulationSuccess(simResult)) {
    throw new Error("Unexpected simulation result type");
  }

  return simResult.result?.retval ? decodeScVal(simResult.result.retval) : null;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
