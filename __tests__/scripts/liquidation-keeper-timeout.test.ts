import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvokeReadOnly = vi.fn();
const mockInvokeSigned = vi.fn();
const mockGetAdminKeypair = vi.fn();

vi.mock("@/lib/stellar/server-contract", () => ({
  addr: (g: string) => ({ addr: g }),
  u32: (n: number) => ({ u32: n }),
  getAdminKeypair: () => mockGetAdminKeypair(),
  invokeReadOnly: (...args: unknown[]) => mockInvokeReadOnly(...args),
  invokeSigned: (...args: unknown[]) => mockInvokeSigned(...args),
}));

import {
  runLiquidationKeeper,
  type KeeperConfig,
} from "@/scripts/liquidation-keeper";

const BASE_CFG: KeeperConfig = {
  source: "chain",
  dryRun: true,
  intervalSecs: null,
  lendingContractId: "CLENDING",
  reputationContractId: "CREPUTATION",
  adminAddress: "GADMIN",
  xlmPriceUsd: 0.1,
  priceTable: {
    GCOLLATERAL: { symbol: "USDC", priceUsd: 1, decimals: 7 },
  },
  defaultAssetVolatilityBps: 2000,
};

function scValLoan(id: number) {
  return {
    id,
    borrower: "GBORROWER",
    status: { Active: {} },
    remaining_due: (100n * 10_000_000n).toString(),
    collateral_asset: "GCOLLATERAL",
    collateral_amount: (10n * 10_000_000n).toString(),
  };
}

describe("liquidation-keeper timeout and abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts evaluation batch when AbortSignal fires and preserves partial counts", async () => {
    // 3 candidate loans on chain
    mockInvokeReadOnly.mockImplementation((args: { method: string; args?: unknown[] }) => {
      if (args.method === "get_loan_count") return Promise.resolve(3);
      if (args.method === "get_loan") return Promise.resolve(scValLoan(1));
      if (args.method === "get_reputation_score") return Promise.resolve(500);
      if (args.method === "calculate_liquidation_threshold") return Promise.resolve(8000);
      if (args.method === "check_liquidation_eligibility") return Promise.resolve(true);
      return Promise.resolve(null);
    });

    const controller = new AbortController();

    const onProgress = vi.fn(async (summary) => {
      if (summary.liquidated > 0 || summary.healthy > 0 || summary.skipped > 0) {
        controller.abort("Simulated dead-man switch trigger");
      }
    });

    const summary = await runLiquidationKeeper(BASE_CFG, null, {
      signal: controller.signal,
      onProgress,
    });

    expect(summary.aborted).toBe(true);
    expect(summary.scanned).toBe(3);
    expect(summary.remaining).toBe(2);
    expect(summary.abortReason).toContain("Execution deadline reached");
  });
});
