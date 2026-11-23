/**
 * lib/contracts/multisig-admin.ts
 *
 * TypeScript client for the MultiSigAdminContract (issue #73). Lets N-of-M
 * authorised admin wallets propose, approve, and execute the rare,
 * high-impact protocol configuration changes that used to be a single-admin
 * bypass (whitelisting collateral assets, changing fee tables, linking
 * governance/oracle, moving insurance-fund balances).
 * Contract calls use the shared Stellar SDK RPC executor.
 */

import {
  callContract,
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
  tupleEnumToScVal,
} from "@/lib/stellar/soroban";
import type { MultiSigAdminAction, MultiSigProposal } from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID is not set. " +
      "Deploy the contract and add the ID to .env.local"
  );
}

// ─── Read functions ───────────────────────────────────────────────────────────

export async function getSigners(callerAddress: string): Promise<string[]> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_signers",
    args: [],
    callerAddress,
  });
  return result as string[];
}

export async function getThreshold(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_threshold",
    args: [],
    callerAddress,
  });
  return Number(result);
}

export async function isSigner(who: string, callerAddress: string): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "is_signer",
    args: [addressToScVal(who)],
    callerAddress,
  });
  return result as boolean;
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
): Promise<MultiSigProposal> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_proposal",
    args: [u32ToScVal(proposalId)],
    callerAddress,
  });
  return decodeProposal(raw);
}

export async function hasApproved(
  proposalId: number,
  signer: string,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "has_approved",
    args: [u32ToScVal(proposalId), addressToScVal(signer)],
    callerAddress,
  });
  return result as boolean;
}

// ─── Write functions (require a signer wallet) ────────────────────────────────

/**
 * Open a proposal for one of the protected admin actions. Proposing counts
 * as the proposer's own first approval.
 */
export async function propose(proposerAddress: string, action: MultiSigAdminAction) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "propose",
    args: [addressToScVal(proposerAddress), encodeAction(action)],
    callerAddress: proposerAddress,
  });
}

/** Record a distinct signer's approval of an active proposal. */
export async function approve(signerAddress: string, proposalId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "approve",
    args: [addressToScVal(signerAddress), u32ToScVal(proposalId)],
    callerAddress: signerAddress,
  });
}

/** Withdraw a previously recorded approval, before execution. */
export async function revokeApproval(signerAddress: string, proposalId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "revoke_approval",
    args: [addressToScVal(signerAddress), u32ToScVal(proposalId)],
    callerAddress: signerAddress,
  });
}

/** The original proposer cancels their own still-active proposal. */
export async function cancel(callerAddress: string, proposalId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "cancel",
    args: [addressToScVal(callerAddress), u32ToScVal(proposalId)],
    callerAddress,
  });
}

/** Enact a proposal once it has reached the approval threshold. Permissionless. */
export async function execute(callerAddress: string, proposalId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "execute",
    args: [u32ToScVal(proposalId)],
    callerAddress,
  });
}

// ─── Action encoding ──────────────────────────────────────────────────────────

function encodeAction(action: MultiSigAdminAction) {
  if ("WhitelistAsset" in action) {
    const [target, asset] = action.WhitelistAsset;
    return tupleEnumToScVal("WhitelistAsset", [addressToScVal(target), addressToScVal(asset)]);
  }
  if ("SetFlashLoanFeeBps" in action) {
    const [target, newFeeBps] = action.SetFlashLoanFeeBps;
    return tupleEnumToScVal("SetFlashLoanFeeBps", [addressToScVal(target), u32ToScVal(newFeeBps)]);
  }
  if ("SetGovernance" in action) {
    const [target, governance] = action.SetGovernance;
    return tupleEnumToScVal("SetGovernance", [addressToScVal(target), addressToScVal(governance)]);
  }
  if ("SetOracle" in action) {
    const [target, oracle] = action.SetOracle;
    return tupleEnumToScVal("SetOracle", [addressToScVal(target), addressToScVal(oracle)]);
  }
  if ("AddToInsurance" in action) {
    const [target, amount] = action.AddToInsurance;
    return tupleEnumToScVal("AddToInsurance", [addressToScVal(target), i128ToScVal(amount)]);
  }
  if ("TriggerInsurancePayout" in action) {
    const [target, loanId, lender, amount] = action.TriggerInsurancePayout;
    return tupleEnumToScVal("TriggerInsurancePayout", [
      addressToScVal(target),
      u32ToScVal(loanId),
      addressToScVal(lender),
      i128ToScVal(amount),
    ]);
  }
  if ("AddSigner" in action) {
    return tupleEnumToScVal("AddSigner", [addressToScVal(action.AddSigner[0])]);
  }
  if ("RemoveSigner" in action) {
    return tupleEnumToScVal("RemoveSigner", [addressToScVal(action.RemoveSigner[0])]);
  }
  // SetThreshold
  return tupleEnumToScVal("SetThreshold", [u32ToScVal(action.SetThreshold[0])]);
}

// ─── Decoders ─────────────────────────────────────────────────────────────────

function decodeProposal(raw: unknown): MultiSigProposal {
  const r = raw as Record<string, unknown>;
  return {
    id: Number(r.id),
    proposer: r.proposer as string,
    action: decodeAction(r.action),
    approvals: (r.approvals as string[]) ?? [],
    createdAt: BigInt(r.created_at as string | number),
    status: extractEnumVariant(r.status) as MultiSigProposal["status"],
  };
}

function decodeAction(raw: unknown): MultiSigAdminAction {
  const variant = extractEnumVariant(raw);
  const fields = (raw as Record<string, unknown[]>)[variant] ?? [];
  return { [variant]: fields } as unknown as MultiSigAdminAction;
}

function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") {
    return Object.keys(val as object)[0];
  }
  return String(val);
}
