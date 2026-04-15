import {
  TransactionBuilder,
  BASE_FEE,
  Contract,
  Operation,
  Account,
  SorobanDataBuilder,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

// ─── Network config ───────────────────────────────────────────────────────────

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

/**
 * Horizon REST base URL — used for account sequence number lookups.
 */
export const HORIZON_URL =
  process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
  "https://horizon-testnet.stellar.org";

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
  callerAddress: string;
}

// ─── Raw JSON-RPC helper ──────────────────────────────────────────────────────

/**
 * Single JSON-RPC 2.0 call directly to the Soroban RPC node.
 * Replaces all sorobanServer.* calls to avoid SDK instanceof failures.
 */
async function sorobanRpc<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  const res = await fetch(SOROBAN_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`Soroban RPC transport error (${method}): ${res.statusText}`);
  }
  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error) {
    throw new Error(`Soroban RPC error (${method}): ${JSON.stringify(json.error)}`);
  }
  return json.result as T;
}

/**
 * Fetch account sequence number from Horizon REST API.
 * Soroban RPC has no getAccount method — account data lives on Horizon.
 */
async function getAccountSequence(address: string): Promise<string> {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `Account ${address} not found on Stellar network. ` +
        `Make sure this wallet has been funded with at least 1 XLM on testnet ` +
        `(visit https://friendbot.stellar.org?addr=${address}).`
      );
    }
    throw new Error(`Horizon account fetch failed: ${res.statusText}`);
  }
  const data = (await res.json()) as { sequence: string };
  return data.sequence;
}

// ─── Write: build → simulate → assemble → sign → submit → poll ───────────────

/**
 * Full transaction flow without any SDK RPC calls.
 * Returns the decoded contract return value, or `null` for void functions.
 */
export async function callContract({
  contractId,
  method,
  args,
  callerAddress,
}: CallContractOptions): Promise<unknown> {

  // ── 1. Fetch account sequence from Horizon REST API ──────────────────────
  // (Soroban RPC has no getAccount — account data lives on Horizon)
  const originalSequence = await getAccountSequence(callerAddress);

  // ── 2. Build simulation tx (pure local, no network) ───────────────────────
  const simAccount = new Account(callerAddress, originalSequence);
  const contract = new Contract(contractId);
  const simTx = new TransactionBuilder(simAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  // ── 3. Simulate via raw RPC ────────────────────────────────────────────────
  const simData = await sorobanRpc<{
    error?: string;
    transactionData: string;           // base64 SorobanTransactionData XDR
    minResourceFee: string;            // stroops to add on top of base fee
    results: Array<{ auth: string[]; xdr: string }>;
    latestLedger: number;
  }>("simulateTransaction", { transaction: simTx.toXDR() });

  if (simData.error) {
    throw new Error(`Soroban simulation failed: ${simData.error}`);
  }
  if (!simData.results?.length || !simData.transactionData) {
    throw new Error("Simulation returned no results — contract may not exist on this network.");
  }

  // ── 4. Assemble: build a FRESH tx with simulation results ─────────────────
  const authEntries = (simData.results[0]?.auth ?? []).map(
    (a: string) => xdr.SorobanAuthorizationEntry.fromXDR(a, "base64")
  );

  // Fee = base fee + simulation's minResourceFee
  const assembledFee = String(Number(BASE_FEE) + Number(simData.minResourceFee));

  // Extract the HostFunction from the first operation of our sim tx
  // tx.operations returns decoded JS objects; func is the raw xdr.HostFunction
  const originalOp = simTx.operations[0] as {
    type: string;
    func: xdr.HostFunction;
    source?: string;
  };

  // Fresh account with the original sequence so assembled tx seq matches
  const assembleAccount = new Account(callerAddress, originalSequence);

  const assembledTx = new TransactionBuilder(assembleAccount, {
    fee: assembledFee,
    networkPassphrase: NETWORK_PASSPHRASE,
    // Pass the raw base64 string — TransactionBuilder wraps it in
    // SorobanDataBuilder internally, no isinstance check on our side.
    sorobanData: new SorobanDataBuilder(simData.transactionData).build(),
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: originalOp.func,
        auth: authEntries,
      })
    )
    .setTimeout(30)
    .build();

  // ── 5. Sign with Freighter ─────────────────────────────────────────────────
  // signTransaction returns { signedTxXdr, signerAddress, error? }
  const freighterResult = await signTransaction(assembledTx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: callerAddress,
  });
  if (freighterResult.error) {
    throw new Error(`Freighter signing failed: ${JSON.stringify(freighterResult.error)}`);
  }
  if (!freighterResult.signedTxXdr) {
    throw new Error("Freighter returned no signed XDR — user may have cancelled.");
  }

  // ── 6. Submit via raw RPC ──────────────────────────────────────────────────
  const sendData = await sorobanRpc<{
    status: string;
    hash: string;
    errorResult?: unknown;
  }>("sendTransaction", { transaction: freighterResult.signedTxXdr });

  if (sendData.status === "ERROR") {
    throw new Error(`Transaction submission failed: ${JSON.stringify(sendData.errorResult)}`);
  }

  // ── 7. Poll for finality via raw RPC ──────────────────────────────────────
  const hash = sendData.hash;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const txResult = await sorobanRpc<{
      status: string;
      returnValue?: string;  // base64 XDR SCVal when SUCCESS
    }>("getTransaction", { hash });

    if (txResult.status === "SUCCESS") {
      return txResult.returnValue
        ? decodeScVal(xdr.ScVal.fromXDR(txResult.returnValue, "base64"))
        : null;
    }
    if (txResult.status === "FAILED") {
      throw new Error(`Transaction failed on-chain: hash=${hash}`);
    }
    // NOT_FOUND or PENDING — keep polling
  }

  throw new Error(`Transaction ${hash} timed out after 30s`);
}

// ─── Read: simulation only (no signing required) ──────────────────────────────

/**
 * Read-only contract call via simulation — no Freighter signing needed.
 * Use for all get_* / is_* / calculate_* view functions.
 */
export async function simulateContractCall({
  contractId,
  method,
  args,
  callerAddress,
}: CallContractOptions): Promise<unknown> {
  // Get account sequence from Horizon REST API
  const sequence = await getAccountSequence(callerAddress);
  const account = new Account(callerAddress, sequence);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simData = await sorobanRpc<{
    error?: string;
    results?: Array<{ auth: string[]; xdr: string }>;
    latestLedger?: number;
  }>("simulateTransaction", { transaction: tx.toXDR() });

  if (simData.error) {
    throw new Error(`Simulation error: ${simData.error}`);
  }

  // results[0].xdr is the base64-encoded SCVal return value
  const retvalXdr = simData.results?.[0]?.xdr;
  return retvalXdr
    ? decodeScVal(xdr.ScVal.fromXDR(retvalXdr, "base64"))
    : null;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
