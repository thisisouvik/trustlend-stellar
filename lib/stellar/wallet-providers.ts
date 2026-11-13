/**
 * lib/stellar/wallet-providers.ts
 *
 * Pure (kit-free) helpers describing the Stellar wallets TrustLend supports.
 *
 * This module deliberately has **no** `@creit.tech/stellar-wallets-kit` import so
 * it can be unit tested in a plain Node environment — the kit pulls in Preact,
 * Reown AppKit and the WalletConnect sign client, none of which load outside a
 * browser. `lib/stellar/wallet.ts` is the only place that talks to the kit.
 */

export type StellarWalletProvider = "freighter" | "albedo" | "walletconnect" | "xbull";

export const STELLAR_WALLET_PROVIDERS: readonly StellarWalletProvider[] = [
  "freighter",
  "albedo",
  "walletconnect",
  "xbull",
] as const;

/**
 * Map of our provider keys to the `productId` each kit module reports.
 *
 * These are the kit's public module ids (`FREIGHTER_ID`, `WALLET_CONNECT_ID`, …).
 * Note that WalletConnect's is `wallet_connect` with an underscore — using
 * "walletconnect" makes `StellarWalletsKit.setWallet()` throw.
 * `assertWalletModuleIds()` re-checks these against the live modules at init.
 */
export const WALLET_MODULE_IDS: Record<StellarWalletProvider, string> = {
  freighter: "freighter",
  albedo: "albedo",
  walletconnect: "wallet_connect",
  xbull: "xbull",
};

const WALLET_PROVIDER_LABELS: Record<StellarWalletProvider, string> = {
  freighter: "Varial",
  albedo: "Albedo",
  walletconnect: "WalletConnect",
  xbull: "xBull",
};

/** Providers that reach the user's wallet off-device (QR code / deep link). */
const MOBILE_BRIDGE_PROVIDERS: readonly StellarWalletProvider[] = ["walletconnect"];

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** WalletConnect CAIP-2 chain ids for Stellar (`WalletConnectTargetChain`). */
export const WALLET_CONNECT_CHAINS = {
  PUBLIC: "stellar:pubnet",
  TESTNET: "stellar:testnet",
} as const;

export type WalletConnectChain =
  (typeof WALLET_CONNECT_CHAINS)[keyof typeof WALLET_CONNECT_CHAINS];

export function isStellarWalletProvider(value: unknown): value is StellarWalletProvider {
  return (
    typeof value === "string" &&
    STELLAR_WALLET_PROVIDERS.includes(value as StellarWalletProvider)
  );
}

export function getWalletProviderLabel(provider: StellarWalletProvider): string {
  return WALLET_PROVIDER_LABELS[provider] ?? WALLET_PROVIDER_LABELS.freighter;
}

export function isMobileBridgeProvider(provider: StellarWalletProvider): boolean {
  return MOBILE_BRIDGE_PROVIDERS.includes(provider);
}

/** Kit module id for a provider (e.g. `"walletconnect"` → `"wallet_connect"`). */
export function getWalletModuleId(provider: StellarWalletProvider): string {
  return WALLET_MODULE_IDS[provider];
}

/**
 * Reverse of {@link getWalletModuleId}. Returns `null` for kit modules TrustLend
 * does not register (Lobstr, Ledger, …) so callers can fall back sensibly rather
 * than blind-casting an unknown id into `StellarWalletProvider`.
 */
export function getProviderFromModuleId(
  moduleId: string | null | undefined,
): StellarWalletProvider | null {
  if (!moduleId) return null;
  const match = STELLAR_WALLET_PROVIDERS.find(
    (provider) => WALLET_MODULE_IDS[provider] === moduleId,
  );
  return match ?? null;
}

/** The network passphrase the browser bundle is configured for. */
export function getNetworkPassphrase(): string {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? TESTNET_PASSPHRASE;
}

/**
 * WalletConnect only speaks pubnet and testnet. Anything that is not mainnet
 * (futurenet, standalone, local sandbox) is negotiated as testnet, which is what
 * mobile wallets expose for non-production networks.
 */
export function getWalletConnectChain(
  networkPassphrase: string = getNetworkPassphrase(),
): WalletConnectChain {
  return networkPassphrase === PUBLIC_PASSPHRASE
    ? WALLET_CONNECT_CHAINS.PUBLIC
    : WALLET_CONNECT_CHAINS.TESTNET;
}

/** WalletConnect Cloud / Reown project id. Required for the QR flow to work. */
export function getWalletConnectProjectId(): string | null {
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
  return projectId ? projectId : null;
}

export function isWalletConnectConfigured(): boolean {
  return getWalletConnectProjectId() !== null;
}

export const WALLET_CONNECT_NOT_CONFIGURED_MESSAGE =
  "WalletConnect is not configured for this deployment. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable mobile wallet connections.";
