/**
 * Pooled lending facade backed by the shared Stellar SDK RPC executor.
 */
import type { xdr } from "@stellar/stellar-sdk";
import {
  simulateContractCall,
  callContract,
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
  structToScVal,
} from "@/lib/stellar/soroban";
import type { PoolConfig, PoolData } from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID is not set. " +
      "Deploy the pooled lending contract and add the ID to .env.local"
  );
}

export async function getPoolUtilization(
  poolId: number,
  callerAddress: string
): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_pool_utilization",
    args: [u32ToScVal(poolId)],
    callerAddress,
  });
  return Number(result);
}

export async function getBorrowApy(
  poolId: number,
  callerAddress: string
): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_borrow_apy",
    args: [u32ToScVal(poolId)],
    callerAddress,
  });
  return Number(result);
}

export async function getSupplyApy(
  poolId: number,
  callerAddress: string
): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_supply_apy",
    args: [u32ToScVal(poolId)],
    callerAddress,
  });
  return Number(result);
}

export async function getInterestRateModel(
  poolId: number,
  callerAddress: string
): Promise<PoolConfig> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_interest_rate_model",
    args: [u32ToScVal(poolId)],
    callerAddress,
  });
  return decodePoolConfig(raw);
}

export async function getPoolConfig(
  poolId: number,
  callerAddress: string
): Promise<PoolConfig> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_pool_config",
    args: [u32ToScVal(poolId)],
    callerAddress,
  });
  return decodePoolConfig(raw);
}

export async function getPoolData(
  poolId: number,
  callerAddress: string
): Promise<PoolData> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_pool_data",
    args: [u32ToScVal(poolId)],
    callerAddress,
  });
  return decodePoolData(raw);
}

export async function setPoolConfig(
  adminAddress: string,
  poolId: number,
  config: PoolConfig
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "set_pool_config",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(poolId),
      encodePoolConfig(config),
    ],
    callerAddress: adminAddress,
  });
}

export async function updatePoolState(
  adminAddress: string,
  poolId: number,
  totalSupply: bigint,
  totalBorrows: bigint
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "update_pool_state",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(poolId),
      i128ToScVal(totalSupply),
      i128ToScVal(totalBorrows),
    ],
    callerAddress: adminAddress,
  });
}

export async function initializePool(
  adminAddress: string,
  poolId: number,
  config: PoolConfig
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "initialize",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(poolId),
      encodePoolConfig(config),
    ],
    callerAddress: adminAddress,
  });
}

// ─── Decoders / Encoders ─────────────────────────────────────────────────

function decodePoolConfig(raw: unknown): PoolConfig {
  const r = raw as Record<string, unknown>;
  return {
    baseRateBps: Number(r.base_rate_bps),
    multiplierPerSlopeBps: Number(r.multiplier_per_slope_bps),
    jumpMultiplierBps: Number(r.jump_multiplier_bps),
    kinkBps: Number(r.kink_bps),
    reserveFactorBps: Number(r.reserve_factor_bps),
  };
}

function decodePoolData(raw: unknown): PoolData {
  const r = raw as Record<string, unknown>;
  return {
    totalSupply: BigInt(r.total_supply as string | number),
    totalBorrows: BigInt(r.total_borrows as string | number),
    totalReserves: BigInt(r.total_reserves as string | number),
  };
}

export function encodePoolConfig(config: PoolConfig): xdr.ScVal {
  return structToScVal({
    base_rate_bps: u32ToScVal(config.baseRateBps),
    multiplier_per_slope_bps: u32ToScVal(config.multiplierPerSlopeBps),
    jump_multiplier_bps: u32ToScVal(config.jumpMultiplierBps),
    kink_bps: u32ToScVal(config.kinkBps),
    reserve_factor_bps: u32ToScVal(config.reserveFactorBps),
  });
}
