/**
 * lib/contracts/treasury.ts
 *
 * TypeScript client for the TreasuryContract. Read functions run as
 * simulations; writes are signed by the connected wallet.
 * Both paths use the shared Stellar SDK RPC executor.
 */

import {
  invokeContract,
  simulateContractCall,
  addressToScVal,
} from "@/lib/stellar/soroban";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_TREASURY_CONTRACT_ID ?? "";

export function isConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

function requireContract(): string {
  if (!CONTRACT_ID) throw new Error("NEXT_PUBLIC_TREASURY_CONTRACT_ID is not configured");
  return CONTRACT_ID;
}

const read = async (method: string, args: Parameters<typeof simulateContractCall>[0]["args"], callerAddress: string) =>
  simulateContractCall({ contractId: requireContract(), method, args, callerAddress });

const write = async (method: string, args: Parameters<typeof invokeContract>[0]["args"], callerAddress: string) =>
  invokeContract({ contractId: requireContract(), method, args, callerAddress });

const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

export interface DistributionRules {
  insuranceShareBps: number;
  daoShareBps: number;
}

export interface DistributionRecord {
  timestamp: bigint;
  asset: string;
  total: bigint;
  toInsurance: bigint;
  toDao: bigint;
}

export async function getInsuranceFund(caller: string): Promise<string> {
  return String(await read("get_insurance_fund", [], caller));
}

export async function getDaoTreasury(caller: string): Promise<string> {
  return String(await read("get_dao_treasury", [], caller));
}

export async function getDistributionRules(caller: string): Promise<DistributionRules> {
  const r = (await read("get_distribution_rules", [], caller)) as Record<string, unknown>;
  return { insuranceShareBps: Number(r.insurance_share_bps), daoShareBps: Number(r.dao_share_bps) };
}

export async function getTreasuryBalance(assetToken: string, caller: string): Promise<bigint> {
  return toBig(await read("get_treasury_balance", [addressToScVal(assetToken)], caller));
}

export async function getTotals(caller: string): Promise<{ collected: bigint; toInsurance: bigint; toDao: bigint; count: number }> {
  const [collected, toInsurance, toDao, count] = await Promise.all([
    read("get_total_collected_fees", [], caller),
    read("get_total_distributed_insurance", [], caller),
    read("get_total_distributed_dao", [], caller),
    read("get_distribution_count", [], caller),
  ]);
  return { collected: toBig(collected), toInsurance: toBig(toInsurance), toDao: toBig(toDao), count: Number(count) };
}

export async function getDistributionHistory(caller: string): Promise<DistributionRecord[]> {
  const rows = ((await read("get_distribution_history", [], caller)) as Record<string, unknown>[] | null) ?? [];
  return rows.map((r) => ({
    timestamp: toBig(r.timestamp),
    asset: String(r.asset_token ?? r.asset ?? ""),
    total: toBig(r.total_amount ?? r.total),
    toInsurance: toBig(r.insurance_amount ?? r.to_insurance),
    toDao: toBig(r.dao_amount ?? r.to_dao),
  }));
}

/** Pull uncollected platform fees from the lending contract into the treasury (admin). */
export async function collectProtocolFees(adminAddress: string, lendingContract: string) {
  return write("collect_protocol_fees", [addressToScVal(adminAddress), addressToScVal(lendingContract)], adminAddress);
}

/** Split the treasury balance of `assetToken` between the insurance fund and the DAO (admin). */
export async function distribute(adminAddress: string, assetToken: string) {
  return write("distribute", [addressToScVal(adminAddress), addressToScVal(assetToken)], adminAddress);
}
