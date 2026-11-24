import { describe, expect, it } from "vitest";
import {
  readReferralClaim,
  referralClaimErrorStatus,
  referralClaimStatement,
} from "@/lib/referrals/claim";

describe("referral claim helpers", () => {
  it("builds the statement and returns the established referral", () => {
    expect(referralClaimStatement("referee-1", "TLABC234")).toBeDefined();
    const result = readReferralClaim([
      { referral_id: "edge-1", referrer_id: "referrer-1", status: "pending" },
    ]);
    expect(result).toEqual({ referralId: "edge-1", referrerId: "referrer-1", status: "pending" });
  });

  it.each([
    [new Error("Unknown referral code"), 404],
    [new Error("Cannot refer yourself"), 409],
    [new Error("database offline"), null],
  ])("maps guarded errors", (error, expected) => {
    expect(referralClaimErrorStatus(error)).toBe(expected);
  });
});
