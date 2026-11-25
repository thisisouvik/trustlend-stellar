import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getWalletProviderLabel,
  isStellarWalletProvider,
  getWalletModuleId,
  STELLAR_WALLET_PROVIDERS,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet-providers";

describe("Borrower Varial Wallet Integration", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("includes Varial (formerly Freighter) in supported wallet providers for borrowers", () => {
    expect(STELLAR_WALLET_PROVIDERS).toContain("freighter");
    expect(isStellarWalletProvider("freighter")).toBe(true);
  });

  it("returns correct human-readable display label for Varial", () => {
    expect(getWalletProviderLabel("freighter")).toBe("Varial");
  });

  it("maps Varial to its correct wallet module ID for connection", () => {
    expect(getWalletModuleId("freighter")).toBe("freighter");
  });

  it("ensures Varial is the primary default wallet for signing borrowing transactions", () => {
    const fallbackProvider: StellarWalletProvider = "freighter";
    expect(getWalletProviderLabel(fallbackProvider)).toBe("Varial");
  });
});
