/**
 * lib/contracts/governance.ts
 *
 * TypeScript client for the GovernanceContract — the DAO module that controls
 * the lending platform fee via reputation-weighted proposals & votes.
 */

import {
  callContract,
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
} from "@/lib/stellar/soroban";
import { nativeToScVal } from "@stellar/stellar-sdk";
import type { GovConfig, Proposal, ProposalStatus } from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID is not set. " +
      "Deploy the contract and add the ID to .env.local"
  );
}

const boolToScVal = (v: boolean) => nativeToScVal(v); // booleans infer to ScvBool

// ─── Read functions ───────────────────────────────────────────────────────────

export async function getConfig(callerAddress: string): Promise<GovConfig> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_config",
    args: [],
    callerAddress,
  });
  return decodeConfig(raw);
}

/** Reputation-weighted voting power of an account. */
export async function getVotingPower(
  account: string,
  callerAddress: string
): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_voting_power",
    args: [addressToScVal(account)],
    callerAddress,
  });
  return BigInt(result as string | number);
}

export async function getProposalCount(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_proposal_count",
    args: [],
    callerAddress,
  });
  return Number(result);
}

export async function getProposal(
  proposalId: number,
  callerAddress: string
): Promise<Proposal> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_proposal",
    args: [u32ToScVal(proposalId)],
    callerAddress,
  });
  return decodeProposal(raw);
}

export async function hasVoted(
  proposalId: number,
  account: string,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "has_voted",
    args: [u32ToScVal(proposalId), addressToScVal(account)],
    callerAddress,
  });
  return result as boolean;
}

// ─── Write functions (require wallet signature) ───────────────────────────────

/** Open a proposal to set the platform fee to `newFeeBps` (bps of interest). */
export async function proposeFeeChange(
  proposerAddress: string,
  newFeeBps: number
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "propose_fee_change",
    args: [addressToScVal(proposerAddress), u32ToScVal(newFeeBps)],
    callerAddress: proposerAddress,
  });
}

/** Cast a reputation-weighted vote (support = for/against). */
export async function vote(
  voterAddress: string,
  proposalId: number,
  support: boolean
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "vote",
    args: [addressToScVal(voterAddress), u32ToScVal(proposalId), boolToScVal(support)],
    callerAddress: voterAddress,
  });
}

/** Close voting and tally (callable by anyone after the voting period). */
export async function finalize(callerAddress: string, proposalId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "finalize",
    args: [u32ToScVal(proposalId)],
    callerAddress,
  });
}

/** Enact a passed proposal — cross-calls lending.set_platform_fee_bps. */
export async function execute(callerAddress: string, proposalId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "execute",
    args: [u32ToScVal(proposalId)],
    callerAddress,
  });
}

// ─── Decoders ─────────────────────────────────────────────────────────────────

function decodeProposal(raw: unknown): Proposal {
  const r = raw as Record<string, unknown>;
  return {
    id: Number(r.id),
    proposer: r.proposer as string,
    kind: extractEnumVariant(r.kind) as Proposal["kind"],
    newValue: Number(r.new_value),
    votesFor: BigInt(r.votes_for as string | number),
    votesAgainst: BigInt(r.votes_against as string | number),
    createdAt: BigInt(r.created_at as string | number),
    endAt: BigInt(r.end_at as string | number),
    status: extractEnumVariant(r.status) as ProposalStatus,
  };
}

function decodeConfig(raw: unknown): GovConfig {
  const r = raw as Record<string, unknown>;
  return {
    admin: r.admin as string,
    lending: r.lending as string,
    reputation: r.reputation as string,
    votingPeriodSecs: BigInt(r.voting_period_secs as string | number),
    quorumVotes: BigInt(r.quorum_votes as string | number),
    minProposerPower: BigInt(r.min_proposer_power as string | number),
    maxFeeBps: Number(r.max_fee_bps),
  };
}

function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") {
    return Object.keys(val as object)[0];
  }
  return String(val);
}
