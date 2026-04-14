import { STELLAR_TESTNET } from "@/lib/stellar/testnet";

const TX_HASH_MIN_LENGTH = 24;

export function isLikelyTxHash(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  return value.trim().length >= TX_HASH_MIN_LENGTH;
}

export function buildStellarTxVerificationUrl(txHash: string) {
  const encoded = encodeURIComponent(txHash.trim());
  return `https://stellar.expert/explorer/testnet/tx/${encoded}`;
}

export function extractPossibleTxHash(source: unknown): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const meta = source as Record<string, unknown>;
  const candidate =
    (meta.tx_hash as string | undefined)
    ?? (meta.txHash as string | undefined)
    ?? (meta.stellar_tx_hash as string | undefined)
    ?? (meta.transaction_hash as string | undefined)
    ?? (meta.hash as string | undefined);

  if (!candidate || !isLikelyTxHash(candidate)) {
    return null;
  }

  return candidate;
}

export const STELLAR_VERIFY_PORTAL = buildStellarTxVerificationUrl("demo").replace("/demo", "");
export const STELLAR_NETWORK_LABEL = STELLAR_TESTNET.networkName;