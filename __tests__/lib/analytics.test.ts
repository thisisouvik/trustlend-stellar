import { describe, expect, it } from "vitest";
import { aggregatePlatformAnalytics } from "@/lib/analytics";

describe("aggregatePlatformAnalytics", () => {
  it("aggregates TVL, repayments, yields, active users, and volume", () => {
    const now = new Date("2026-06-29T12:00:00.000Z").getTime();
    const currentTime = new Date(now).toISOString();
    const oldTime = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();

    const metrics = aggregatePlatformAnalytics(
      {
        loans: [
          { principal_amount: 1000, status: "funded" },
          { principal_amount: 2000, status: "active" },
          { principal_amount: 5000, status: "requested" },
        ],
        poolPositions: [
          { principal_amount: 4000, earned_interest: 120, status: "active" },
          { principal_amount: 500, earned_interest: 40, status: "closed" },
        ],
        loanRepayments: [
          { amount: 250 },
          { amount: 750 },
        ],
        ledgerTransactions: [
          { amount: 1200, user_id: "u1", status: "confirmed", created_at: currentTime },
          { amount: 800, user_id: "u2", status: "confirmed", created_at: currentTime },
          { amount: 300, user_id: "u3", status: "pending", created_at: currentTime },
          { amount: 999, user_id: "u4", status: "confirmed", created_at: oldTime },
        ],
      },
      30 * 24 * 60 * 60 * 1000,
    );

    expect(metrics).toEqual({
      tvl: 7000,
      totalRepaid: 1000,
      platformYields: 160,
      activeUsers: 2,
      cumulativeTransactionVolume: 2999,
    });
  });
});
