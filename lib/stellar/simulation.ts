import {
  TransactionBuilder,
  BASE_FEE,
  Contract,
  xdr,
  Address,
  nativeToScVal,
  rpc,
  StrKey,
} from "@stellar/stellar-sdk";

export const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

export interface SimulationResources {
  instructions: number;
  readBytes: number;
  writeBytes: number;
  ledgerFootprintEntries: number;
}

export interface SimulationResult {
  success: boolean;
  method: string;
  contractId: string;
  feeStroops: number;
  feeXlm: string;
  resources: SimulationResources;
  error?: string;
  returnValue?: unknown;
  latestLedger: number;
}

function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

function stringToScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "string" });
}

export function encodeArg(arg: unknown): xdr.ScVal {
  if (typeof arg === "string" && StrKey.isValidEd25519PublicKey(arg)) {
    return addressToScVal(arg);
  }
  if (typeof arg === "bigint") return i128ToScVal(arg);
  if (typeof arg === "number" && Number.isInteger(arg)) return u32ToScVal(arg);
  if (typeof arg === "number") return nativeToScVal(arg);
  if (arg instanceof xdr.ScVal) return arg;
  if (typeof arg === "boolean") return nativeToScVal(arg);
  if (typeof arg === "string") return stringToScVal(arg);
  return nativeToScVal(arg);
}

function createRpcServer(): rpc.Server {
  return new rpc.Server(SOROBAN_RPC_URL, {
    allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
  });
}

const STROOPS_PER_XLM = 10_000_000;
const emptyResources = (): SimulationResources => ({
  instructions: 0,
  readBytes: 0,
  writeBytes: 0,
  ledgerFootprintEntries: 0,
});

function stroopsToXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7);
}

/**
 * Simulates a Soroban invocation through the SDK RPC client and returns a
 * user-facing resource and fee preview. No raw JSON-RPC response is unpacked.
 */
export async function simulatePreview(
  contractId: string,
  method: string,
  args: unknown[],
  callerAddress: string,
): Promise<SimulationResult> {
  const baseResult = {
    method,
    contractId,
    feeStroops: 0,
    feeXlm: "0",
    latestLedger: 0,
  };
  const server = createRpcServer();

  let account;
  try {
    if (!StrKey.isValidEd25519PublicKey(callerAddress)) {
      throw new Error("Invalid Stellar account address.");
    }
    account = await server.getAccount(callerAddress);
  } catch (error) {
    return {
      ...baseResult,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      resources: emptyResources(),
    };
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args.map(encodeArg)))
    .setTimeout(30)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(tx);
  } catch (error) {
    return {
      ...baseResult,
      success: false,
      error: "RPC call failed: " + (error instanceof Error ? error.message : String(error)),
      resources: emptyResources(),
    };
  }

  if (rpc.Api.isSimulationError(simulation)) {
    return {
      ...baseResult,
      success: false,
      error: simulation.error,
      resources: emptyResources(),
      latestLedger: simulation.latestLedger,
    };
  }
  if (!simulation.result) {
    return {
      ...baseResult,
      success: false,
      error: "Simulation returned no contract result.",
      resources: emptyResources(),
      latestLedger: simulation.latestLedger,
    };
  }

  const totalFeeStroops = Number(BASE_FEE) + Number(simulation.minResourceFee);
  let resources = emptyResources();
  try {
    const sorobanResources = simulation.transactionData.build().resources();
    resources = {
      instructions: sorobanResources.instructions(),
      readBytes: sorobanResources.diskReadBytes(),
      writeBytes: sorobanResources.writeBytes(),
      ledgerFootprintEntries: sorobanResources.footprint().readWrite().length,
    };
  } catch {
    // A fee preview remains useful even if a provider returns incomplete data.
  }

  let returnValue: unknown;
  try {
    const { scValToNative } = await import("@stellar/stellar-sdk");
    returnValue = scValToNative(simulation.result.retval);
  } catch {
    // Contract return-value decoding is non-essential for the preview.
  }

  return {
    ...baseResult,
    success: true,
    feeStroops: totalFeeStroops,
    feeXlm: stroopsToXlm(totalFeeStroops),
    resources,
    returnValue,
    latestLedger: simulation.latestLedger,
  };
}
