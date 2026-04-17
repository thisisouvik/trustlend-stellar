import { STELLAR_TESTNET } from "@/lib/stellar/testnet";

const TX_HASH_MIN_LENGTH = 10;
const TX_HASH_64_HEX_REGEX = /\b[a-fA-F0-9]{64}\b/;

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractHashFromText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const fromRegex = trimmed.match(TX_HASH_64_HEX_REGEX)?.[0] ?? null;
  if (fromRegex) {
    return fromRegex;
  }

  const decoded = (() => {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  })();

  const fromDecodedRegex = decoded.match(TX_HASH_64_HEX_REGEX)?.[0] ?? null;
  if (fromDecodedRegex) {
    return fromDecodedRegex;
  }

  if (isLikelyTxHash(decoded)) {
    return decoded;
  }

  return null;
}

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
  if (!source) {
    return null;
  }

  if (typeof source === "string") {
    const parsed = parseJsonString(source);
    if (parsed && parsed !== source) {
      const extractedFromParsed = extractPossibleTxHash(parsed);
      if (extractedFromParsed) {
        return extractedFromParsed;
      }
    }

    return extractHashFromText(source);
  }

  if (typeof source !== "object") {
    return null;
  }

  const meta = source as Record<string, unknown>;
  const candidate =
    meta.tx_hash
    ?? meta.txHash
    ?? meta.stellar_tx_hash
    ?? meta.transaction_hash
    ?? meta.hash
    ?? meta.tx_ref
    ?? meta.txRef;

  const extractedCandidate = extractPossibleTxHash(candidate);
  if (extractedCandidate) {
    return extractedCandidate;
  }

  for (const value of Object.values(meta)) {
    const extracted = extractPossibleTxHash(value);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

export const STELLAR_VERIFY_PORTAL = buildStellarTxVerificationUrl("demo").replace("/demo", "");
export const STELLAR_NETWORK_LABEL = STELLAR_TESTNET.networkName;