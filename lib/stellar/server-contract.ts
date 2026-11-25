/**
 * lib/stellar/server-contract.ts
 *
 * Server-side (trusted backend) Soroban contract invoker. Unlike the browser
 * client in `lib/stellar/soroban.ts` (which signs via Varial), this signs
 * with a secret key held only on the server — used by automated cron jobs such
 * as the Default-Management insurance automation.
 *
 * SERVER-ONLY: never import this into client components. It reads ADMIN_SECRET_KEY.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

// ─── Encoding helpers ─────────────────────────────────────────────────────────

export const addr = (g: string): xdr.ScVal => new Address(g).toScVal();
export const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
export const u64 = (n: bigint | number): xdr.ScVal =>
  nativeToScVal(typeof n === "bigint" ? n : BigInt(n), { type: "u64" });
export const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });

const STROOPS_PER_XLM = 10_000_000n;
/** Convert an XLM amount (number) to stroops (bigint). */
export const xlmToStroops = (xlm: number): bigint =>
  BigInt(Math.round(xlm * Number(STROOPS_PER_XLM)));

/**
 * Encode a tuple-variant `#[contracttype]` enum (e.g. `MultiSigAdmin::AdminAction`)
 * as `ScVec([ScSymbol(variant), field0, field1, ...])`. Unit variants use
 * `enumToScVal` in `lib/stellar/soroban.ts`; this is the tuple-field equivalent.
 */
export function tupleEnumToScVal(variant: string, fields: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), ...fields]);
}

// ─── Signer ───────────────────────────────────────────────────────────────────

/** Load the admin signer from ADMIN_SECRET_KEY, or null if unconfigured. */
export function getAdminKeypair(): Keypair | null {
  const secret = process.env.ADMIN_SECRET_KEY;
  if (!secret) return null;
  return Keypair.fromSecret(secret);
}

export interface InvokeResult {
  hash: string;
  returnValue: unknown;
}

/**
 * Build → simulate → assemble → sign → submit → poll a contract invocation,
 * signed by `signer`. Returns the decoded return value (or null for void fns).
 */
export async function invokeSigned(params: {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  signer: Keypair;
  timeoutSecs?: number;
}): Promise<InvokeResult> {
  const { contractId, method, args, signer } = params;
  const server = new rpc.Server(SOROBAN_RPC_URL, {
    allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
  });

  const account = await server.getAccount(signer.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(params.timeoutSecs ?? 60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed for ${method}: ${sim.error}`);
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Submission error for ${method}: ${JSON.stringify(sent.errorResult)}`);
  }

  // Poll for finality.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === "SUCCESS") {
      return {
        hash: sent.hash,
        returnValue: res.returnValue ? scValToNative(res.returnValue) : null,
      };
    }
    if (res.status === "FAILED") {
      throw new Error(`Transaction failed on-chain for ${method}: hash=${sent.hash}`);
    }
    // NOT_FOUND → keep polling
  }
  throw new Error(`Transaction ${sent.hash} for ${method} timed out after 30s`);
}

/**
 * Read-only contract call via simulation — no signing, no submission, no
 * on-chain state change. `sourceAddress` just needs to be a funded account
 * (e.g. the admin address); it isn't authorising anything for a pure read.
 */
export async function invokeReadOnly(params: {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  sourceAddress: string;
}): Promise<unknown> {
  const server = new rpc.Server(SOROBAN_RPC_URL, {
    allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
  });
  const account = await server.getAccount(params.sourceAddress);
  const contract = new Contract(params.contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(params.method, ...params.args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed for ${params.method}: ${sim.error}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

/**
 * Fetch the latest ledger close time (unix seconds) from Horizon. Used to
 * evaluate overdue windows against on-chain ledger time rather than wall-clock.
 * Falls back to the current system time on any failure.
 */
export async function getLedgerTimeSecs(): Promise<number> {
  const horizon =
    process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  try {
    const res = await fetch(`${horizon}/ledgers?order=desc&limit=1`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Horizon ${res.status}`);
    const json = (await res.json()) as {
      _embedded?: { records?: Array<{ closed_at?: string }> };
    };
    const closedAt = json._embedded?.records?.[0]?.closed_at;
    if (closedAt) {
      return Math.floor(new Date(closedAt).getTime() / 1000);
    }
  } catch {
    // fall through to wall-clock
  }
  return Math.floor(Date.now() / 1000);
}
