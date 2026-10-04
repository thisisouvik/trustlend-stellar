import { describe, it, expect } from "vitest";
import {
  DEFAULT_POOL_APR_BPS,
  LENDER_TIERS,
  MAX_DEPOSIT_XLM,
  MAX_DURATION_DAYS,
  MIN_DEPOSIT_XLM,
  MIN_DURATION_DAYS,
  PLATFORM_FEE_BPS,
  TIER_CONFIGS,
  clampDeposit,
  clampDuration,
  estimateLenderEarnings,
  isLenderTier,
  selectEstimatorAprBps,
  type LenderTier,
} from "@/lib/dashboard/lender-earnings";

const base = { depositXlm: 1000, durationDays: 365, poolAprBps: 1200, tier: "Bronze" as LenderTier };

describe("lender-earnings — tier configuration matches issue #322", () => {
  it("exposes exactly the four specified tiers in progression order", () => {
    expect(LENDER_TIERS).toEqual(["Bronze", "Silver", "Gold", "Platinum"]);
  });

  it.each([
    ["Bronze", 1.0, 0],
    ["Silver", 1.1, 0.05],
    ["Gold", 1.25, 0.1],
    ["Platinum", 1.5, 0.15],
  ] as [LenderTier, number, number][])(
    "%s carries a %sx multiplier and a %s rate adjustment",
    (tier, multiplier, rateAdjustment) => {
      expect(TIER_CONFIGS[tier].multiplier).toBe(multiplier);
      expect(TIER_CONFIGS[tier].rateAdjustment).toBe(rateAdjustment);
    },
  );

  it("recognises only the four supported tiers", () => {
    expect(isLenderTier("Gold")).toBe(true);
    expect(isLenderTier("Diamond")).toBe(false);
    expect(isLenderTier(undefined)).toBe(false);
  });
});

describe("lender-earnings — the specified formulas", () => {
  // Interest Yield = deposit × (APR/10000) × (days/365) × multiplier
  // 1000 × 0.12 × 1 × 1.0 = 120
  it("computes gross interest over a full year", () => {
    expect(estimateLenderEarnings(base).interestYield).toBe(120);
  });

  // Platform Fee = Interest Yield × 0.01
  it("takes a 1% platform fee out of the interest", () => {
    const result = estimateLenderEarnings(base);
    expect(result.platformFee).toBe(1.2);
    expect(result.platformFee / result.interestYield).toBeCloseTo(0.01, 10);
  });

  // Net Expected Rewards = Interest Yield − Platform Fee
  it("nets the rewards after the fee", () => {
    const result = estimateLenderEarnings(base);
    expect(result.netRewards).toBe(118.8);
    expect(result.netRewards).toBe(result.interestYield - result.platformFee);
  });

  it("returns principal plus net rewards as the maturity total", () => {
    expect(estimateLenderEarnings(base).totalPayout).toBe(1118.8);
  });

  // Reputation = deposit × 0.01 × (days/30) × multiplier
  it("computes reputation points from deposit, duration and tier", () => {
    // 1000 × 0.01 × (90/30) × 1.0 = 30
    expect(
      estimateLenderEarnings({ ...base, durationDays: 90 }).reputationPoints,
    ).toBe(30);
    // 1000 × 0.01 × (90/30) × 1.5 = 45
    expect(
      estimateLenderEarnings({ ...base, durationDays: 90, tier: "Platinum" }).reputationPoints,
    ).toBe(45);
  });

  it("prorates interest for a partial year", () => {
    // 1000 × 0.12 × (90/365) × 1.0
    const expected = Number((1000 * 0.12 * (90 / 365)).toFixed(7));
    expect(estimateLenderEarnings({ ...base, durationDays: 90 }).interestYield).toBe(expected);
  });

  it("scales linearly with the deposit", () => {
    const small = estimateLenderEarnings({ ...base, depositXlm: 1000 });
    const large = estimateLenderEarnings({ ...base, depositXlm: 10_000 });
    expect(large.netRewards).toBeCloseTo(small.netRewards * 10, 5);
  });

  it("honours a platform fee override", () => {
    const free = estimateLenderEarnings({ ...base, platformFeeBps: 0 });
    expect(free.platformFee).toBe(0);
    expect(free.netRewards).toBe(free.interestYield);
  });

  it("defaults the fee to the documented 1%", () => {
    expect(PLATFORM_FEE_BPS).toBe(100);
  });
});

describe("lender-earnings — tier multipliers applied to yield", () => {
  it.each(LENDER_TIERS)("annualizes %s to the pool rate times its multiplier", (tier) => {
    const result = estimateLenderEarnings({ ...base, tier });
    expect(result.dynamicAprBps).toBe(Math.round(1200 * TIER_CONFIGS[tier].multiplier));
  });

  it("reports Platinum as 18% against a 12% pool", () => {
    expect(estimateLenderEarnings({ ...base, tier: "Platinum" }).dynamicAprPct).toBe(18);
  });

  it("increases net rewards strictly with tier", () => {
    const nets = LENDER_TIERS.map(
      (tier) => estimateLenderEarnings({ ...base, depositXlm: 5000, tier }).netRewards,
    );
    for (let i = 1; i < nets.length; i += 1) {
      expect(nets[i]).toBeGreaterThan(nets[i - 1]);
    }
  });

  it("never lets the displayed APR drift from the reward figure", () => {
    for (const tier of LENDER_TIERS) {
      const r = estimateLenderEarnings({ depositXlm: 7500, durationDays: 200, poolAprBps: 950, tier });
      const reconstructed = r.depositXlm * (r.dynamicAprBps / 10_000) * (r.durationDays / 365);
      expect(reconstructed).toBeCloseTo(r.interestYield, 0);
    }
  });

  it("falls back to Bronze economics for an unrecognised tier", () => {
    const result = estimateLenderEarnings({
      ...base,
      tier: "Diamond" as unknown as LenderTier,
    });
    expect(result.tier).toBe("Bronze");
    expect(result.tierConfig.multiplier).toBe(1);
  });
});

describe("lender-earnings — input clamping", () => {
  it("clamps the deposit to the slider range", () => {
    expect(clampDeposit(1)).toBe(MIN_DEPOSIT_XLM);
    expect(clampDeposit(10_000_000)).toBe(MAX_DEPOSIT_XLM);
    expect(clampDeposit(2_500)).toBe(2_500);
  });

  it("clamps and rounds the duration to whole days", () => {
    expect(clampDuration(1)).toBe(MIN_DURATION_DAYS);
    expect(clampDuration(10_000)).toBe(MAX_DURATION_DAYS);
    expect(clampDuration(90.7)).toBe(91);
  });

  it("treats a non-finite deposit as the minimum", () => {
    expect(clampDeposit(Number.NaN)).toBe(MIN_DEPOSIT_XLM);
    expect(estimateLenderEarnings({ ...base, depositXlm: Number.NaN }).depositXlm).toBe(
      MIN_DEPOSIT_XLM,
    );
  });

  it("reports the clamped inputs it actually used", () => {
    const result = estimateLenderEarnings({ ...base, depositXlm: 1, durationDays: 5000 });
    expect(result.depositXlm).toBe(MIN_DEPOSIT_XLM);
    expect(result.durationDays).toBe(MAX_DURATION_DAYS);
  });
});

describe("lender-earnings — degenerate pool rates", () => {
  it.each([0, -500, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the default APR for a pool rate of %s",
    (poolAprBps) => {
      const result = estimateLenderEarnings({ ...base, poolAprBps });
      expect(result.dynamicAprBps).toBe(DEFAULT_POOL_APR_BPS);
      expect(result.netRewards).toBeGreaterThan(0);
    },
  );

  it("never produces a negative or non-finite figure across the input range", () => {
    for (let deposit = MIN_DEPOSIT_XLM; deposit <= MAX_DEPOSIT_XLM; deposit += 4_973) {
      for (const durationDays of [30, 90, 180, 365]) {
        for (const tier of LENDER_TIERS) {
          const r = estimateLenderEarnings({ depositXlm: deposit, durationDays, poolAprBps: 1200, tier });
          for (const value of [
            r.interestYield,
            r.platformFee,
            r.netRewards,
            r.totalPayout,
            r.dynamicAprBps,
            r.reputationPoints,
            r.periodReturnPct,
          ]) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe("lender-earnings — selectEstimatorAprBps", () => {
  it("picks the best rate among active pools", () => {
    expect(
      selectEstimatorAprBps([
        { status: "active", apr_bps: 800 },
        { status: "active", apr_bps: 1450 },
        { status: "active", apr_bps: 1100 },
      ]),
    ).toBe(1450);
  });

  it("ignores pools that are not active", () => {
    expect(
      selectEstimatorAprBps([
        { status: "paused", apr_bps: 9000 },
        { status: "closed", apr_bps: 8000 },
        { status: "active", apr_bps: 1200 },
      ]),
    ).toBe(1200);
  });

  it("falls back to the default when there are no usable pools", () => {
    expect(selectEstimatorAprBps([])).toBe(DEFAULT_POOL_APR_BPS);
    expect(selectEstimatorAprBps([{ status: "paused", apr_bps: 1200 }])).toBe(
      DEFAULT_POOL_APR_BPS,
    );
    expect(selectEstimatorAprBps([{ status: "active", apr_bps: 0 }])).toBe(DEFAULT_POOL_APR_BPS);
  });

  it("tolerates missing or malformed fields", () => {
    expect(
      selectEstimatorAprBps([{}, { status: "active" }, { status: "active", apr_bps: "nonsense" }]),
    ).toBe(DEFAULT_POOL_APR_BPS);
  });

  it("accepts apr_bps arriving as a numeric string", () => {
    expect(selectEstimatorAprBps([{ status: "active", apr_bps: "1350" }])).toBe(1350);
  });
});
