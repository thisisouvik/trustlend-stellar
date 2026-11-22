import { describe, expect, it, vi } from "vitest";
import {
  createDryRunPublisher,
  createInitialState,
  runOracleCycle,
  type OracleKeeperConfig,
} from "@/scripts/price-oracle-keeper";
import type { PriceSource } from "@/lib/oracle/sources";

const CFG: OracleKeeperConfig = {
  intervalMs: 5000,
  once: true,
  dryRun: true,
  maxStalenessMs: 120_000,
  assetAddresses: { XLM: "CXLM...", BTC: "CBTC..." },
  lendingContractId: "CLENDING...",
  adminAddress: "GADMIN...",
};

const fakeSources: PriceSource[] = [
  {
    name: "mock-source",
    fetchPrices: async (symbols) =>
      symbols.map((s) => ({
        symbol: s,
        priceUsd: 1.0,
        source: "mock-source",
        observedAt: Date.now(),
      })),
  },
];

describe("price-oracle keeper timeout and abort", () => {
  it("aborts cycle gracefully when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("Deadline reached before cycle");

    const publisher = createDryRunPublisher();
    const state = createInitialState();

    const summary = await runOracleCycle(
      CFG,
      fakeSources,
      publisher,
      state,
      Date.now(),
      { signal: controller.signal },
    );

    expect(summary.aborted).toBe(true);
    expect(summary.abortReason).toContain("Execution deadline reached");
    expect(summary.published).toBe(0);
  });

  it("aborts symbol processing loop when signal is triggered mid-cycle", async () => {
    const controller = new AbortController();
    const publisher = createDryRunPublisher();
    const state = createInitialState();

    const onProgress = vi.fn(async () => {
      controller.abort("Deadline mid-symbols");
    });

    const summary = await runOracleCycle(
      CFG,
      fakeSources,
      publisher,
      state,
      Date.now(),
      { signal: controller.signal, onProgress },
    );

    expect(summary.aborted).toBe(true);
    expect(summary.abortReason).toContain("Execution deadline reached");
  });
});
