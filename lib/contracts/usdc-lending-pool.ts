/**
 * lib/contracts/usdc-lending-pool.ts
 *
 * TypeScript client for the UsdcLendingPoolContract. Read functions run as
 * simulations; writes are signed by the connected wallet.
 */

import {
  invokeContract,
  simulateContractCall,
  addressToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_USDC_LENDING_POOL_CONTRACT_ID ?? "";

export function isConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

function requireContract(): string {
  if (!CONTRACT_ID) throw new Error("NEXT_PUBLIC_USDC_LENDING_POOL_CONTRACT_ID is not configured");
  return CONTRACT_ID;
}

const read = async (method: string, args: Parameters<typeof simulateContractCall>[0]["args"], callerAddress: string) =>
  simulateContractCall({ contractId: requireContract(), method, args, callerAddress });

const write = async (method: string, args: Parameters<typeof invokeContract>[0]["args"], callerAddress: string) =>
  invokeContract({ contractId: requireContract(), method, args, callerAddress });

const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

export interface UsdcPoolState {
  totalDeposits: bigint;
  /** Maximum APY; yield only accrues while the funded reserve covers it. */
  annualYieldBps: number;
  /** Principal currently owed to depositors. */
  totalPrincipal: bigint;
  /** Funded yield not yet released to depositors (see `fundYield`). */
  yieldReserve: bigint;
  paused: boolean;
  [key: string]: unknown;
}

export async function getPoolState(caller: string): Promise<UsdcPoolState> {
  const [state, paused] = await Promise.all([read("get_pool_state", [], caller), read("is_paused", [], caller)]);
  const r = (state ?? {}) as Record<string, unknown>;
  return {
    ...r,
    totalDeposits: toBig(r.total_deposits ?? r.total_deposited),
    annualYieldBps: Number(r.annual_yield_bps ?? 0),
    totalPrincipal: toBig(r.total_principal),
    yieldReserve: toBig(r.yield_reserve),
    paused: Boolean(paused),
  };
}

/** `(principal, accrued yield)` for a depositor, in USDC stroops. */
export async function getDeposit(depositor: string, caller: string): Promise<{ principal: bigint; accruedYield: bigint }> {
  const r = (await read("get_deposit", [addressToScVal(depositor)], caller)) as unknown[] | null;
  return { principal: toBig(r?.[0]), accruedYield: toBig(r?.[1]) };
}

export async function deposit(depositorAddress: string, amountStroops: bigint) {
  const { hash } = await write("deposit", [addressToScVal(depositorAddress), i128ToScVal(amountStroops)], depositorAddress);
  return { txHash: hash };
}

/** Withdraw `amountStroops` of principal plus all accrued yield; the rest stays deposited. */
export async function withdraw(depositorAddress: string, amountStroops: bigint) {
  const { hash } = await write("withdraw", [addressToScVal(depositorAddress), i128ToScVal(amountStroops)], depositorAddress);
  return { txHash: hash };
}

/**
 * Pay USDC into the pool's yield reserve — the only source of depositor
 * yield (e.g. borrower interest or a treasury top-up).
 */
export async function fundYield(funderAddress: string, amountStroops: bigint) {
  const { hash } = await write("fund_yield", [addressToScVal(funderAddress), i128ToScVal(amountStroops)], funderAddress);
  return { txHash: hash };
}
