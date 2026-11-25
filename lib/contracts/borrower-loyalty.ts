/**
 * lib/contracts/borrower-loyalty.ts
 *
 * TypeScript client for the BorrowerLoyaltyContract. Read functions run as
 * simulations through the shared Stellar SDK RPC executor.
 * simulations; writes are signed by the connected wallet.
 */

import {
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_BORROWER_LOYALTY_CONTRACT_ID ?? "";

export function isConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

function requireContract(): string {
  if (!CONTRACT_ID) throw new Error("NEXT_PUBLIC_BORROWER_LOYALTY_CONTRACT_ID is not configured");
  return CONTRACT_ID;
}

const read = async (method: string, args: Parameters<typeof simulateContractCall>[0]["args"], callerAddress: string) =>
  simulateContractCall({ contractId: requireContract(), method, args, callerAddress });


const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

export interface LoyaltyConfig {
  baseAmount: bigint;
  referenceLoanAmount: bigint;
  maxDurationMultiplierBps: number;
  tierMultipliersBps: { none: number; beginner: number; silver: number; gold: number; platinum: number };
}

export async function getConfig(caller: string): Promise<LoyaltyConfig> {
  const r = (await read("get_config", [], caller)) as Record<string, unknown>;
  return {
    baseAmount: toBig(r.base_amount),
    referenceLoanAmount: toBig(r.reference_loan_amount),
    maxDurationMultiplierBps: Number(r.max_duration_multiplier_bps),
    tierMultipliersBps: {
      none: Number(r.tier_none_multiplier_bps),
      beginner: Number(r.tier_beginner_multiplier_bps),
      silver: Number(r.tier_silver_multiplier_bps),
      gold: Number(r.tier_gold_multiplier_bps),
      platinum: Number(r.tier_platinum_multiplier_bps),
    },
  };
}

/** Total loyalty rewards (reward-token stroops) paid to a borrower so far. */
export async function getBorrowerRewards(borrower: string, caller: string): Promise<bigint> {
  return toBig(await read("get_borrower_rewards", [addressToScVal(borrower)], caller));
}

export async function getTotalRewardsDistributed(caller: string): Promise<bigint> {
  return toBig(await read("get_total_rewards_distributed", [], caller));
}

/** Preview the reward a repaid loan would earn. */
export async function calculateRewardView(
  loanAmountStroops: bigint,
  durationDays: number,
  reputationTier: number,
  caller: string,
): Promise<bigint> {
  return toBig(
    await read(
      "calculate_reward_view",
      [i128ToScVal(loanAmountStroops), u32ToScVal(durationDays), u32ToScVal(reputationTier)],
      caller,
    ),
  );
}
