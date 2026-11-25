import { afterEach, describe, expect, it } from "vitest";

import {
  PUBLIC_PASSPHRASE,
  STELLAR_WALLET_PROVIDERS,
  TESTNET_PASSPHRASE,
  WALLET_CONNECT_CHAINS,
  WALLET_MODULE_IDS,
  getNetworkPassphrase,
  getProviderFromModuleId,
  getWalletConnectChain,
  getWalletConnectProjectId,
  getWalletModuleId,
  getWalletProviderLabel,
  isMobileBridgeProvider,
  isStellarWalletProvider,
  isWalletConnectConfigured,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet-providers";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("wallet module ids", () => {
  it("maps WalletConnect to the kit's underscored module id", () => {
    // The kit exports this as WALLET_CONNECT_ID; "walletconnect" makes
    // StellarWalletsKit.setWallet() throw "is not an existing module".
    expect(getWalletModuleId("walletconnect")).toBe("wallet_connect");
  });

  it("maps every supported provider to a module id", () => {
    for (const provider of STELLAR_WALLET_PROVIDERS) {
      expect(getWalletModuleId(provider)).toBeTruthy();
    }
  });

  it("uses a distinct module id per provider", () => {
    const ids = Object.values(WALLET_MODULE_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("round-trips provider → module id → provider", () => {
    for (const provider of STELLAR_WALLET_PROVIDERS) {
      expect(getProviderFromModuleId(getWalletModuleId(provider))).toBe(provider);
    }
  });

  it("returns null for kit modules TrustLend does not register", () => {
    expect(getProviderFromModuleId("lobstr")).toBeNull();
    expect(getProviderFromModuleId("LEDGER")).toBeNull();
    expect(getProviderFromModuleId(undefined)).toBeNull();
    expect(getProviderFromModuleId("")).toBeNull();
  });
});

describe("provider guards and labels", () => {
  it("accepts known providers and rejects anything else", () => {
    expect(isStellarWalletProvider("walletconnect")).toBe(true);
    expect(isStellarWalletProvider("wallet_connect")).toBe(false);
    expect(isStellarWalletProvider("lobstr")).toBe(false);
    expect(isStellarWalletProvider(null)).toBe(false);
  });

  it("labels each provider for display", () => {
    expect(getWalletProviderLabel("walletconnect")).toBe("WalletConnect");
    expect(getWalletProviderLabel("xbull")).toBe("xBull");
    expect(getWalletProviderLabel("freighter")).toBe("Varial");
    expect(getWalletProviderLabel("albedo")).toBe("Albedo");
  });

  it("falls back to Varial's label for an unknown provider", () => {
    expect(getWalletProviderLabel("nope" as StellarWalletProvider)).toBe("Varial");
  });

  it("flags only WalletConnect as the mobile bridge flow", () => {
    expect(isMobileBridgeProvider("walletconnect")).toBe(true);
    expect(isMobileBridgeProvider("freighter")).toBe(false);
    expect(isMobileBridgeProvider("albedo")).toBe(false);
  });
});

describe("network resolution", () => {
  it("defaults to testnet when no passphrase is configured", () => {
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE;
    expect(getNetworkPassphrase()).toBe(TESTNET_PASSPHRASE);
  });

  it("uses the configured passphrase", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = PUBLIC_PASSPHRASE;
    expect(getNetworkPassphrase()).toBe(PUBLIC_PASSPHRASE);
  });
});

describe("WalletConnect chain negotiation", () => {
  it("uses pubnet only for mainnet", () => {
    expect(getWalletConnectChain(PUBLIC_PASSPHRASE)).toBe(WALLET_CONNECT_CHAINS.PUBLIC);
  });

  it("uses testnet for the testnet passphrase", () => {
    expect(getWalletConnectChain(TESTNET_PASSPHRASE)).toBe(WALLET_CONNECT_CHAINS.TESTNET);
  });

  it("falls back to testnet for networks WalletConnect cannot express", () => {
    expect(getWalletConnectChain("Test SDF Future Network ; October 2022")).toBe(
      WALLET_CONNECT_CHAINS.TESTNET,
    );
    expect(getWalletConnectChain("Standalone Network ; February 2017")).toBe(
      WALLET_CONNECT_CHAINS.TESTNET,
    );
  });

  it("follows the configured network when called with no argument", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = PUBLIC_PASSPHRASE;
    expect(getWalletConnectChain()).toBe(WALLET_CONNECT_CHAINS.PUBLIC);

    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = TESTNET_PASSPHRASE;
    expect(getWalletConnectChain()).toBe(WALLET_CONNECT_CHAINS.TESTNET);
  });
});

describe("WalletConnect configuration", () => {
  it("reports unconfigured when the project id is missing or blank", () => {
    delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    expect(getWalletConnectProjectId()).toBeNull();
    expect(isWalletConnectConfigured()).toBe(false);

    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "   ";
    expect(getWalletConnectProjectId()).toBeNull();
    expect(isWalletConnectConfigured()).toBe(false);
  });

  it("trims and returns a configured project id", () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "  abc123  ";
    expect(getWalletConnectProjectId()).toBe("abc123");
    expect(isWalletConnectConfigured()).toBe(true);
  });
});
