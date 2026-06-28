"use client";

import { Networks } from "@stellar/stellar-sdk";

export type StellarWalletProvider = "freighter" | "albedo";

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

export function getWalletProviderLabel(
  provider: StellarWalletProvider,
): string {
  return provider === "albedo" ? "Albedo" : "Freighter";
}

export function getStoredWalletProvider(): StellarWalletProvider {
  if (typeof window === "undefined") {
    return "freighter";
  }

  const stored = window.localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY);
  return stored === "albedo" ? "albedo" : "freighter";
}

export function setStoredWalletProvider(
  provider: StellarWalletProvider | null,
) {
  if (typeof window === "undefined") {
    return;
  }

  if (!provider) {
    window.localStorage.removeItem(WALLET_PROVIDER_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, provider);
}

function resolveAlbedoNetwork(networkPassphrase: string): "testnet" | "public" {
  return networkPassphrase === Networks.PUBLIC ? "public" : "testnet";
}

async function connectFreighter(): Promise<ConnectedWallet> {
  const { getAddress, getNetworkDetails, isConnected, requestAccess } =
    await import("@stellar/freighter-api");

  const connectionStatus = await isConnected();
  if (connectionStatus.error) {
    throw new Error("Freighter wallet was not detected in this browser.");
  }

  const networkDetails = await getNetworkDetails();
  if (networkDetails.error) {
    throw new Error(
      networkDetails.error.message ??
        "Unable to read Freighter network details.",
    );
  }

  if (networkDetails.networkPassphrase !== Networks.TESTNET) {
    throw new Error("Switch Freighter to Stellar Testnet and try again.");
  }

  const access = await requestAccess();
  if (access.error) {
    throw new Error(
      access.error.message ?? "Wallet access request was declined.",
    );
  }

  const connectedAddress = access.address || (await getAddress()).address;
  if (!connectedAddress) {
    throw new Error("Freighter did not return a public address.");
  }

  return { provider: "freighter", address: connectedAddress };
}

async function connectAlbedo(): Promise<ConnectedWallet> {
  const albedoPackage = await import("@albedo-link/intent");
  const albedo = albedoPackage.default;
  const result = await albedo.publicKey({ token: `trustlend:${Date.now()}` });

  if (!result.pubkey) {
    throw new Error("Albedo did not return a public address.");
  }

  return { provider: "albedo", address: result.pubkey };
}

export async function connectWallet(
  provider: StellarWalletProvider,
): Promise<ConnectedWallet> {
  const wallet =
    provider === "albedo" ? await connectAlbedo() : await connectFreighter();
  setStoredWalletProvider(wallet.provider);
  return wallet;
}

export async function getConnectedWallet(
  provider?: StellarWalletProvider,
): Promise<ConnectedWallet> {
  const selectedProvider = provider ?? getStoredWalletProvider();

  if (selectedProvider === "albedo") {
    if (typeof window !== "undefined") {
      const storedAddress = window.localStorage.getItem(
        WALLET_ADDRESS_STORAGE_KEY,
      );
      if (storedAddress) {
        return { provider: "albedo", address: storedAddress };
      }
    }

    return connectAlbedo();
  }

  const { getAddress, isConnected } = await import("@stellar/freighter-api");
  const connectionStatus = await isConnected();
  if (!connectionStatus.isConnected) {
    throw new Error(
      "Freighter is not connected. Open Freighter and try again.",
    );
  }

  const addressResult = await getAddress();
  if (addressResult.error || !addressResult.address) {
    throw new Error("Could not get wallet address from Freighter.");
  }

  setStoredWalletProvider("freighter");
  return { provider: "freighter", address: addressResult.address };
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
  const selectedProvider = provider ?? getStoredWalletProvider();

  if (selectedProvider === "albedo") {
    const albedoPackage = await import("@albedo-link/intent");
    const albedo = albedoPackage.default;
    const result = await albedo.tx({
      xdr,
      pubkey: address,
      network: resolveAlbedoNetwork(networkPassphrase),
      submit: false,
    });

    if (!result.signed_envelope_xdr) {
      throw new Error("Transaction rejected in Albedo.");
    }

    return {
      signedTxXdr: result.signed_envelope_xdr,
      signerAddress: address,
      provider: "albedo",
    };
  }

  const { signTransaction } = await import("@stellar/freighter-api");
  const result = await signTransaction(xdr, { networkPassphrase, address });
  if (result.error || !result.signedTxXdr) {
    throw new Error(
      result.error?.message ?? "Transaction rejected in Freighter.",
    );
  }

  return {
    signedTxXdr: result.signedTxXdr,
    signerAddress: result.signerAddress,
    provider: "freighter",
  };
}
