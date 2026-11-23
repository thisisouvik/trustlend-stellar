/**
 * lib/contracts/liquidation-auction.ts
 *
 * TypeScript client for the LiquidationAuctionContract. Read functions run as
 * simulations; writes are signed by the connected wallet.
 * Both paths use the shared Stellar SDK RPC executor.
 */

import {
  invokeContract,
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";

export const CONTRACT_ID = process.env.NEXT_PUBLIC_LIQUIDATION_AUCTION_CONTRACT_ID ?? "";

export function isConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

function requireContract(): string {
  if (!CONTRACT_ID) throw new Error("NEXT_PUBLIC_LIQUIDATION_AUCTION_CONTRACT_ID is not configured");
  return CONTRACT_ID;
}

const read = async (method: string, args: Parameters<typeof simulateContractCall>[0]["args"], callerAddress: string) =>
  simulateContractCall({ contractId: requireContract(), method, args, callerAddress });

const write = async (method: string, args: Parameters<typeof invokeContract>[0]["args"], callerAddress: string) =>
  invokeContract({ contractId: requireContract(), method, args, callerAddress });

const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

export interface AuctionRecord {
  loanId: number;
  borrower: string;
  collateralAsset: string;
  /** Token bids are paid in (Issue #418). */
  paymentToken: string;
  /** Pool / treasury that receives the winning bid or unsold collateral. */
  proceedsRecipient: string;
  collateralAmount: bigint;
  debtAmount: bigint;
  startPrice: bigint;
  floorPrice: bigint;
  startedAt: bigint;
  endsAt: bigint;
  status: string;
}

function variant(v: unknown): string {
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export async function getAuction(loanId: number, caller: string): Promise<AuctionRecord> {
  const r = (await read("get_auction", [u32ToScVal(loanId)], caller)) as Record<string, unknown>;
  return {
    loanId: Number(r.loan_id ?? loanId),
    borrower: String(r.borrower ?? ""),
    collateralAsset: String(r.collateral_asset ?? r.collateral_token ?? ""),
    paymentToken: String(r.payment_token ?? ""),
    proceedsRecipient: String(r.proceeds_recipient ?? ""),
    collateralAmount: toBig(r.collateral_amount),
    debtAmount: toBig(r.debt_amount ?? r.debt),
    startPrice: toBig(r.start_price),
    floorPrice: toBig(r.floor_price ?? r.min_price),
    startedAt: toBig(r.started_at ?? r.start_time),
    endsAt: toBig(r.expires_at ?? r.ends_at ?? r.end_time),
    status: variant(r.status),
  };
}

/** Current Dutch-auction price for the collateral of `loanId`. */
export async function currentPrice(loanId: number, caller: string): Promise<bigint> {
  return toBig(await read("current_price", [u32ToScVal(loanId)], caller));
}

/**
 * Buy the auctioned collateral. The contract transfers `bidAmountStroops` of
 * the auction's payment token from the bidder to the proceeds recipient and
 * the collateral to the bidder in the same transaction (Issue #418), so the
 * bidder must hold at least the bid amount or the call reverts.
 */
export async function placeBid(bidderAddress: string, loanId: number, bidAmountStroops: bigint) {
  const { returnValue, hash } = await write(
    "place_bid",
    [addressToScVal(bidderAddress), u32ToScVal(loanId), i128ToScVal(bidAmountStroops)],
    bidderAddress,
  );
  return { settlement: returnValue, txHash: hash };
}
