/**
 * lib/contracts/auto-compound-vault.ts
 *
 * TypeScript client for the AutoCompoundVaultContract. Read functions run as
 * simulations; writes are signed by the connected wallet.
 * Both paths use the shared Stellar SDK RPC executor.
 */

import {
  invokeContract,
  simulateContractCall,
  addressToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_AUTO_COMPOUND_VAULT_CONTRACT_ID ?? "";

export function isConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

function requireContract(): string {
  if (!CONTRACT_ID) throw new Error("NEXT_PUBLIC_AUTO_COMPOUND_VAULT_CONTRACT_ID is not configured");
  return CONTRACT_ID;
}

const read = async (method: string, args: Parameters<typeof simulateContractCall>[0]["args"], callerAddress: string) =>
  simulateContractCall({ contractId: requireContract(), method, args, callerAddress });

const write = async (method: string, args: Parameters<typeof invokeContract>[0]["args"], callerAddress: string) =>
  invokeContract({ contractId: requireContract(), method, args, callerAddress });

const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

export interface VaultSnapshot {
  assetToken: string;
  harvestFeeBps: number;
  totalShares: bigint;
  totalManagedAssets: bigint;
  /** Assets per share, scaled by 1e7. */
  exchangeRate: bigint;
}

export async function getVaultSnapshot(caller: string): Promise<VaultSnapshot> {
  const [assetToken, fee, shares, assets, rate] = await Promise.all([
    read("get_asset_token", [], caller),
    read("get_harvest_fee_bps", [], caller),
    read("get_total_shares", [], caller),
    read("get_total_managed_assets", [], caller),
    read("get_exchange_rate", [], caller),
  ]);
  return {
    assetToken: String(assetToken),
    harvestFeeBps: Number(fee),
    totalShares: toBig(shares),
    totalManagedAssets: toBig(assets),
    exchangeRate: toBig(rate),
  };
}

export async function getPosition(user: string, caller: string): Promise<{ shares: bigint; assetBalance: bigint }> {
  const [shares, balance] = await Promise.all([
    read("get_shares_of", [addressToScVal(user)], caller),
    read("get_user_asset_balance", [addressToScVal(user)], caller),
  ]);
  return { shares: toBig(shares), assetBalance: toBig(balance) };
}

/** Deposit `amountStroops` of the vault asset; returns shares minted. */
export async function deposit(userAddress: string, amountStroops: bigint) {
  const { returnValue, hash } = await write("deposit", [addressToScVal(userAddress), i128ToScVal(amountStroops)], userAddress);
  return { shares: toBig(returnValue), txHash: hash };
}

/** Burn `shares` and receive the underlying asset; returns assets returned. */
export async function withdraw(userAddress: string, shares: bigint) {
  const { returnValue, hash } = await write("withdraw", [addressToScVal(userAddress), i128ToScVal(shares)], userAddress);
  return { assets: toBig(returnValue), txHash: hash };
}
