/**
 * lib/contracts/referral-rewards.ts
 *
 * TypeScript client for the ReferralRewardsContract. Read functions run as
 * simulations; writes are signed by the connected wallet.
 */

import {
  invokeContract,
  simulateContractCall,
  addressToScVal,
  i128ToScVal,
  u32ToScVal,
  vecToScVal,
} from "@/lib/stellar/soroban";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_REFERRAL_REWARDS_CONTRACT_ID ?? "";

export function isConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

function requireContract(): string {
  if (!CONTRACT_ID) throw new Error("NEXT_PUBLIC_REFERRAL_REWARDS_CONTRACT_ID is not configured");
  return CONTRACT_ID;
}

const read = async (method: string, args: Parameters<typeof simulateContractCall>[0]["args"], callerAddress: string) =>
  simulateContractCall({ contractId: requireContract(), method, args, callerAddress });

const write = async (method: string, args: Parameters<typeof invokeContract>[0]["args"], callerAddress: string) =>
  invokeContract({ contractId: requireContract(), method, args, callerAddress });

const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

export interface ReferralConfig {
  baseBonus: bigint;
  referenceLoanAmount: bigint;
  maxSizeMultiplierBps: number;
  minQualifyingLoan: bigint;
  maxReferralsPerReferrer: number;
}

export async function getConfig(caller: string): Promise<ReferralConfig> {
  const r = (await read("get_config", [], caller)) as Record<string, unknown>;
  return {
    baseBonus: toBig(r.base_bonus),
    referenceLoanAmount: toBig(r.reference_loan_amount),
    maxSizeMultiplierBps: Number(r.max_size_multiplier_bps),
    minQualifyingLoan: toBig(r.min_qualifying_loan),
    maxReferralsPerReferrer: Number(r.max_referrals_per_referrer),
  };
}

export async function getReferrerOf(referee: string, caller: string): Promise<string | null> {
  const r = await read("get_referrer_of", [addressToScVal(referee)], caller);
  return r ? String(r) : null;
}

export async function isBonusPaid(referee: string, caller: string): Promise<boolean> {
  return Boolean(await read("is_bonus_paid", [addressToScVal(referee)], caller));
}

export async function getReferrerStats(referrer: string, caller: string): Promise<{ paidCount: number; earnings: bigint }> {
  const [count, earnings] = await Promise.all([
    read("get_paid_referral_count", [addressToScVal(referrer)], caller),
    read("get_referrer_earnings", [addressToScVal(referrer)], caller),
  ]);
  return { paidCount: Number(count), earnings: toBig(earnings) };
}

export async function getProgramTotals(caller: string): Promise<{ bonusesPaid: bigint; referralsRegistered: number }> {
  const [paid, registered] = await Promise.all([
    read("get_total_bonuses_paid", [], caller),
    read("get_total_referrals_registered", [], caller),
  ]);
  return { bonusesPaid: toBig(paid), referralsRegistered: Number(registered) };
}

export async function calculateBonusView(loanAmountStroops: bigint, caller: string): Promise<bigint> {
  return toBig(await read("calculate_bonus_view", [i128ToScVal(loanAmountStroops)], caller));
}

/** The referee signs this once to attribute themselves to a referrer. */
export async function registerReferral(refereeAddress: string, referrerAddress: string) {
  return write("register_referral", [addressToScVal(refereeAddress), addressToScVal(referrerAddress)], refereeAddress);
}

// ─── Multi-Sig Governance and Pause Controls ────────────────────────────────

export async function isPaused(caller: string): Promise<boolean> {
  return Boolean(await read("is_paused", [], caller));
}

export async function getMultisigAdmins(caller: string): Promise<string[]> {
  const r = (await read("get_multisig_admins", [], caller)) as string[];
  return Array.isArray(r) ? r.map(String) : [];
}

export async function getMultisigThreshold(caller: string): Promise<number> {
  return Number(await read("get_multisig_threshold", [], caller));
}

export async function getPauseSignerCount(caller: string): Promise<number> {
  return Number(await read("get_pause_signer_count", [], caller));
}

export async function setupMultisig(
  adminAddress: string,
  admins: string[],
  threshold: number
) {
  return write(
    "setup_multisig",
    [
      addressToScVal(adminAddress),
      vecToScVal(admins.map(addressToScVal)),
      u32ToScVal(threshold),
    ],
    adminAddress
  );
}

export async function setMultisigAdmin(
  adminAddress: string,
  multisigAddress: string
) {
  return write(
    "set_multisig_admin",
    [addressToScVal(adminAddress), addressToScVal(multisigAddress)],
    adminAddress
  );
}

export async function pause(callerAddress: string) {
  return write("pause", [addressToScVal(callerAddress)], callerAddress);
}

export async function unpause(callerAddress: string) {
  return write("unpause", [addressToScVal(callerAddress)], callerAddress);
}

export async function withdrawUnspent(
  adminAddress: string,
  toAddress: string,
  amountStroops: bigint
) {
  return write(
    "withdraw_unspent",
    [
      addressToScVal(adminAddress),
      addressToScVal(toAddress),
      i128ToScVal(amountStroops),
    ],
    adminAddress
  );
}
