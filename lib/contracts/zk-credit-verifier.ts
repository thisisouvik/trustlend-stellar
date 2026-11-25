/**
 * lib/contracts/zk-credit-verifier.ts
 *
 * TypeScript client for the ZkCreditVerifierContract. Read functions run as
 * simulations; writes are signed by the connected wallet.
 * Both paths use the shared Stellar SDK RPC executor.
 */

import {
  simulateContractCall,
  addressToScVal,
  stringToScVal,
} from "@/lib/stellar/soroban";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_ZK_CREDIT_VERIFIER_CONTRACT_ID ?? "";

export function isConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

function requireContract(): string {
  if (!CONTRACT_ID) throw new Error("NEXT_PUBLIC_ZK_CREDIT_VERIFIER_CONTRACT_ID is not configured");
  return CONTRACT_ID;
}

const read = async (method: string, args: Parameters<typeof simulateContractCall>[0]["args"], callerAddress: string) =>
  simulateContractCall({ contractId: requireContract(), method, args, callerAddress });


const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

export interface ZkVerificationRecord {
  borrower: string;
  providerId: string;
  verifiedAt: bigint;
  [key: string]: unknown;
}

export async function isProviderRegistered(providerId: string, caller: string): Promise<boolean> {
  return Boolean(await read("is_provider_registered", [stringToScVal(providerId)], caller));
}

export async function getBorrowerRecord(borrower: string, caller: string): Promise<ZkVerificationRecord> {
  const r = (await read("get_borrower_record", [addressToScVal(borrower)], caller)) as Record<string, unknown>;
  return {
    ...r,
    borrower: String(r.borrower ?? borrower),
    providerId: String(r.provider_id ?? ""),
    verifiedAt: toBig(r.verified_at ?? r.timestamp),
  };
}

export async function getTotalVerifications(caller: string): Promise<number> {
  return Number(await read("get_total_verifications", [], caller));
}
