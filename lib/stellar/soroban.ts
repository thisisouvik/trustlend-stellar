import {
  TransactionBuilder,
  BASE_FEE,
  Contract,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  StrKey,
  rpc,
} from "@stellar/stellar-sdk";
import { signTransactionWithWallet } from "@/lib/stellar/wallet";
import { redis } from "@/lib/services/redis";

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

export function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

export function u64ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "u64" });
}

export function stringToScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "string" });
}

export function bytesToScVal(value: Uint8Array | Buffer): xdr.ScVal {
  return nativeToScVal(value, { type: "bytes" });
}

export function enumToScVal(variant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
}

export function tupleEnumToScVal(variant: string, fields: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), ...fields]);
}

export function structToScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] }));
  return xdr.ScVal.scvMap(entries);
}

export function vecToScVal(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

export function decodeScVal(val: xdr.ScVal): unknown {
  return scValToNative(val);
}

export interface CallContractOptions {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  callerAddress: string;
}

function createRpcServer(): rpc.Server {
  return new rpc.Server(SOROBAN_RPC_URL, {
    allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
  });
}

async function getRpcAccount(server: rpc.Server, address: string) {
  if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(
      "Invalid Stellar account address: expected a 56-character Ed25519 public key starting with 'G'.",
    );
  }

  try {
    return await server.getAccount(address);
  } catch (error) {
    throw new Error(
      "Account " + address + " not found on Stellar network. " +
        "Make sure this wallet has been funded with at least 1 XLM on testnet " +
        "(visit https://friendbot.stellar.org?addr=" + address + ").",
      { cause: error },
    );
  }
}

/** Fetch an account sequence number through Stellar RPC's ledger lookup. */
export async function getAccountSequence(address: string): Promise<string> {
  const account = await getRpcAccount(createRpcServer(), address);
  return account.sequenceNumber();
}

export interface InvokeContractResult {
  returnValue: unknown;
  hash: string;
}

export async function callContract(options: CallContractOptions): Promise<unknown> {
  const { returnValue } = await invokeContract(options);
  return returnValue;
}

/**
 * Builds, simulates, assembles, signs, submits, and polls a contract call.
 * The Stellar SDK owns all simulation parsing and transaction assembly.
 */
export async function invokeContract({
  contractId,
  method,
  args,
  callerAddress,
}: CallContractOptions): Promise<InvokeContractResult> {
  const server = createRpcServer();
  const account = await getRpcAccount(server, callerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error("Soroban simulation failed: " + simulation.error);
  }
  if (!simulation.result) {
    throw new Error("Simulation returned no contract result.");
  }

  const assembledTx = rpc.assembleTransaction(tx, simulation).build();
  const signed = await signTransactionWithWallet({
    xdr: assembledTx.toXDR(),
    networkPassphrase: NETWORK_PASSPHRASE,
    address: callerAddress,
  });
  const signedTx = TransactionBuilder.fromXDR(
    signed.signedTxXdr,
    NETWORK_PASSPHRASE,
  );
  const sent = await server.sendTransaction(signedTx);
  if (sent.status === "ERROR") {
    throw new Error("Transaction submission failed: " + String(sent.errorResult));
  }

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      await invalidateContractCache(contractId).catch(() => {});
      return {
        hash: sent.hash,
        returnValue: result.returnValue ? decodeScVal(result.returnValue) : null,
      };
    }
    if (result.status === "FAILED") {
      throw new Error("Transaction failed on-chain: hash=" + sent.hash);
    }
  }

  throw new Error("Transaction " + sent.hash + " timed out after 30s");
}

export async function simulateContractCall({
  contractId,
  method,
  args,
  callerAddress,
}: CallContractOptions): Promise<unknown> {
  const cacheKey =
    "soroban-cache:" + contractId + ":" + method + ":" +
    args.map((arg) => arg.toXDR("base64")).join(",");

  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached !== null && cached !== undefined) {
        return parseValue(typeof cached === "string" ? cached : JSON.stringify(cached));
      }
    } catch (error) {
      console.error("[Redis] Cache read failed:", error);
    }
  }

  const server = createRpcServer();
  const account = await getRpcAccount(server, callerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error("Simulation error: " + simulation.error);
  }

  const result = simulation.result?.retval
    ? decodeScVal(simulation.result.retval)
    : null;

  if (redis && result !== null && result !== undefined) {
    try {
      await redis.set(cacheKey, stringifyValue(result), { ex: 180 });
    } catch (error) {
      console.error("[Redis] Cache write failed:", error);
    }
  }

  return result;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function stringifyValue(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "bigint" ? { __bigint: val.toString() } : val,
  );
}

function parseValue(json: string): unknown {
  return JSON.parse(json, (_key, val) =>
    val && typeof val === "object" && "__bigint" in val
      ? BigInt(val.__bigint)
      : val,
  );
}

export async function invalidateContractCache(contractId: string): Promise<void> {
  if (!redis) return;
  try {
    const keys = await redis.keys("soroban-cache:" + contractId + ":*");
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log("[Redis] Invalidated " + keys.length + " cache keys for contract " + contractId);
    }
  } catch (error) {
    console.error("[Redis] Cache invalidation failed:", error);
  }
}
