"use client";

/**
 * lib/stellar/wallet.ts
 *
 * Thin browser-side wrapper around StellarWalletsKit. Handles the desktop
 * extension wallets (Varial, xBull), the Albedo web flow, and — for mobile —
 * WalletConnect v2, where the user scans a QR code with LOBSTR / Varial
 * Mobile / any other Stellar WalletConnect wallet.
 *
 * All provider metadata lives in `./wallet-providers` (kit-free, unit tested);
 * this file is the only module that touches the kit itself.
 */

import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import {
  WalletConnectModule,
  type WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
// The kit types its own Networks enum, whose values are the standard passphrases.
import type { Networks as KitNetworks, ModuleInterface } from "@creit.tech/stellar-wallets-kit/types";

import {
  WALLET_CONNECT_NOT_CONFIGURED_MESSAGE,
  WALLET_MODULE_IDS,
  getNetworkPassphrase,
  getProviderFromModuleId,
  getWalletConnectChain,
  getWalletConnectProjectId,
  getWalletModuleId,
  getWalletProviderLabel,
  isStellarWalletProvider,
  isWalletConnectConfigured,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet-providers";

export {
  getWalletProviderLabel,
  isWalletConnectConfigured,
  isMobileBridgeProvider,
  STELLAR_WALLET_PROVIDERS,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet-providers";

export interface ConnectedWallet {
  provider: StellarWalletProvider;
  address: string;
}

export interface SignTransactionParams {
  xdr: string;
  networkPassphrase: string;
  address?: string;
  provider?: StellarWalletProvider;
}

const WALLET_PROVIDER_STORAGE_KEY = "wallet_provider";
const WALLET_ADDRESS_STORAGE_KEY = "wallet_address";

/**
 * WalletConnect's sign client is initialised asynchronously inside the module's
 * constructor, so `isAvailable()` is false for the first few hundred ms after
 * `ensureKit()`. Connecting before it settles throws "WalletConnect module has
 * not been started yet", so we poll instead.
 */
const MODULE_READY_TIMEOUT_MS = 12_000;
const MODULE_READY_POLL_MS = 150;

export function getStoredWalletProvider(): StellarWalletProvider | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY);
  return isStellarWalletProvider(stored) ? stored : null;
}

export function setStoredWalletProvider(provider: StellarWalletProvider | null) {
  if (typeof window === "undefined") return;
  if (!provider) {
    window.localStorage.removeItem(WALLET_PROVIDER_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, provider);
}

function setStoredWalletAddress(address: string | null) {
  if (typeof window === "undefined") return;
  if (!address) {
    window.localStorage.removeItem(WALLET_ADDRESS_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, address);
}

function getStoredWalletAddress(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY);
}

let kitInitialized = false;

/**
 * Guard against the kit renaming a module id underneath us — `setWallet()` only
 * fails at connect time, which is a confusing place to discover the mismatch.
 */
function assertWalletModuleIds(modules: ModuleInterface[]) {
  if (process.env.NODE_ENV === "production") return;
  const registered = new Set(modules.map((mod) => mod.productId));
  for (const [provider, moduleId] of Object.entries(WALLET_MODULE_IDS)) {
    // WalletConnect is only registered when a project id is configured.
    if (provider === "walletconnect" && !isWalletConnectConfigured()) continue;
    if (!registered.has(moduleId)) {
      console.error(
        `[wallet] Provider "${provider}" maps to module id "${moduleId}", which no registered ` +
          `StellarWalletsKit module reports. Registered ids: ${[...registered].join(", ")}.`,
      );
    }
  }
}

function ensureKit(): void {
  if (typeof window === "undefined") {
    throw new Error("StellarWalletsKit can only be initialized in the browser.");
  }
  if (kitInitialized) return;

  const networkPassphrase = getNetworkPassphrase();
  const modules: ModuleInterface[] = [
    new FreighterModule(),
    new AlbedoModule(),
    new xBullModule(),
  ];

  const projectId = getWalletConnectProjectId();
  if (projectId) {
    modules.push(
      new WalletConnectModule({
        projectId,
        metadata: {
          name: "TrustLend",
          description: "TrustLend — P2P lending on Stellar",
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.ico`],
        },
        // Without this the kit negotiates a pubnet-only session while signing
        // requests are sent on the app's network, and the wallet rejects them.
        allowedChains: [getWalletConnectChain(networkPassphrase) as WalletConnectTargetChain],
      }),
    );
  }

  assertWalletModuleIds(modules);

  StellarWalletsKit.init({
    network: networkPassphrase as KitNetworks,
    modules,
    // WalletConnect reports itself unavailable until its sign client boots, so
    // keep unsupported wallets visible in the kit's own modal rather than
    // silently dropping the only mobile option.
    authModal: { hideUnsupportedWallets: false },
  });
  kitInitialized = true;
}

/** Resolve once the selected module can actually service a connection. */
async function waitForSelectedModuleReady(provider: StellarWalletProvider): Promise<void> {
  const deadline = Date.now() + MODULE_READY_TIMEOUT_MS;
  let lastError: unknown = null;

  for (;;) {
    try {
      if (await StellarWalletsKit.selectedModule.isAvailable()) return;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      const label = getWalletProviderLabel(provider);
      if (provider === "walletconnect") {
        throw new Error(
          `${label} could not be started. Check your connection and that NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is a valid WalletConnect Cloud project id.`,
          lastError instanceof Error ? { cause: lastError } : undefined,
        );
      }
      throw new Error(
        `${label} is not available. Install or unlock the ${label} extension, or connect a mobile wallet with WalletConnect instead.`,
        lastError instanceof Error ? { cause: lastError } : undefined,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, MODULE_READY_POLL_MS));
  }
}

function selectWallet(provider: StellarWalletProvider): void {
  if (provider === "walletconnect" && !isWalletConnectConfigured()) {
    throw new Error(WALLET_CONNECT_NOT_CONFIGURED_MESSAGE);
  }
  StellarWalletsKit.setWallet(getWalletModuleId(provider));
}

/**
 * The provider whose session the kit currently holds, or `null` if none. Must be
 * read *before* `selectWallet()`, which overwrites the kit's selected module.
 */
function getActiveKitProvider(): StellarWalletProvider | null {
  try {
    return getProviderFromModuleId(StellarWalletsKit.selectedModule?.productId);
  } catch {
    // `selectedModule` throws when no wallet has been selected yet.
    return null;
  }
}

/** The address the kit currently holds, or `null` when nothing is connected. */
async function readKitAddress(): Promise<string | null> {
  try {
    const { address } = await StellarWalletsKit.getAddress();
    return address || null;
  } catch {
    // `getAddress()` throws when the kit has no address in memory.
    return null;
  }
}

function rememberConnection(wallet: ConnectedWallet): ConnectedWallet {
  setStoredWalletProvider(wallet.provider);
  setStoredWalletAddress(wallet.address);
  return wallet;
}

/**
 * Connect a wallet. With no `provider` the kit's own picker is shown; with one,
 * we go straight to that wallet — for WalletConnect that opens the QR modal.
 */
export async function connectWallet(
  provider?: StellarWalletProvider | null,
): Promise<ConnectedWallet> {
  ensureKit();

  if (!provider) {
    const result = await StellarWalletsKit.authModal();
    if (!result?.address) {
      throw new Error("Wallet connection was cancelled or failed.");
    }
    // The kit sets the chosen module before resolving. Fall back to whatever we
    // had stored if the user picked a wallet TrustLend does not model.
    return rememberConnection({
      provider: getActiveKitProvider() ?? getStoredWalletProvider() ?? "freighter",
      address: result.address,
    });
  }

  selectWallet(provider);
  await waitForSelectedModuleReady(provider);

  // `fetchAddress()` (not `getAddress()`) is what actually prompts the wallet:
  // it calls into the module, which is what opens the WalletConnect QR modal.
  // `getAddress()` only reads the kit's in-memory address and throws when empty.
  const { address } = await StellarWalletsKit.fetchAddress();
  if (!address) {
    throw new Error(`Failed to get an address from ${getWalletProviderLabel(provider)}.`);
  }

  return rememberConnection({ provider, address });
}

/**
 * Resolve the active wallet, reconnecting only when necessary.
 *
 * The kit persists its own session (address, selected module and — importantly
 * for WalletConnect — the session topics), so a page reload keeps working. We
 * trust the kit's address over our mirrored copy because that is the session
 * that will actually sign.
 */
export async function getConnectedWallet(
  provider?: StellarWalletProvider,
): Promise<ConnectedWallet> {
  const selectedProvider = provider ?? getStoredWalletProvider();
  if (!selectedProvider) {
    return connectWallet(null);
  }

  ensureKit();

  // Read before `selectWallet()` clobbers it: the kit keeps a single active
  // address, so a cached one only belongs to the wallet that produced it.
  // Reusing a Varial address for a WalletConnect request would skip the QR
  // modal and then fail at signing with no matching session.
  const activeProvider = getActiveKitProvider();

  try {
    selectWallet(selectedProvider);
  } catch (error) {
    // Configured provider is unusable (e.g. WalletConnect without a project id).
    if (provider) throw error;
    return connectWallet(null);
  }

  if (activeProvider === selectedProvider) {
    const kitAddress = await readKitAddress();
    if (kitAddress) {
      return rememberConnection({ provider: selectedProvider, address: kitAddress });
    }
  }

  // No live session for this wallet — connect so that signing has one, rather
  // than failing later at the signature step.
  return connectWallet(selectedProvider);
}

export async function signTransactionWithWallet({
  xdr,
  networkPassphrase,
  address,
  provider,
}: SignTransactionParams): Promise<{
  signedTxXdr: string;
  signerAddress?: string;
  provider: StellarWalletProvider;
}> {
  ensureKit();

  const selectedProvider = provider ?? getStoredWalletProvider() ?? "freighter";
  selectWallet(selectedProvider);

  // WalletConnect matches the request to a session by address, so always give it
  // one — the caller's, or the address the wallet is currently connected with.
  const signerHint = address ?? (await readKitAddress()) ?? getStoredWalletAddress() ?? undefined;

  const { signedTxXdr, signerAddress } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase,
    address: signerHint,
  });

  return {
    signedTxXdr,
    // WalletConnect does not echo the signer back; fall back to the address we
    // asked to sign with so callers keep a usable value.
    signerAddress: signerAddress ?? signerHint,
    provider: selectedProvider,
  };
}

/**
 * Drop the wallet session. For WalletConnect this also closes the pairing with
 * the mobile wallet, so a stale session cannot linger after the user signs out.
 */
export async function disconnectWallet(): Promise<void> {
  setStoredWalletProvider(null);
  setStoredWalletAddress(null);

  if (typeof window === "undefined" || !kitInitialized) return;
  try {
    await StellarWalletsKit.disconnect();
  } catch (error) {
    console.warn("[wallet] Failed to cleanly disconnect the wallet session", error);
  }
}
