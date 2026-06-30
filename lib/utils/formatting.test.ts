import { describe, it, expect } from "vitest";
import { formatCurrency, formatTokenBalance } from "./formatting";

describe("formatting", () => {
  describe("formatCurrency", () => {
    it("formats a normal number as XLM with 2 decimal places", () => {
      expect(formatCurrency(1234.56)).toBe("1,234.56 XLM");
      expect(formatCurrency(100)).toBe("100.00 XLM");
      expect(formatCurrency(0)).toBe("0.00 XLM");
    });

    it("handles large numbers", () => {
      expect(formatCurrency(1234567.89)).toBe("1,234,567.89 XLM");
    });
  });

  describe("formatTokenBalance", () => {
    it("converts stroops to XLM using default 7 decimals", () => {
      expect(formatTokenBalance(10000000)).toBe("1.00 XLM"); // 1 XLM
      expect(formatTokenBalance(25000000)).toBe("2.50 XLM"); // 2.5 XLM
      expect(formatTokenBalance(123456789)).toBe("12.35 XLM"); // 12.3456789 rounded to 12.35
    });

    it("supports custom decimals if specified", () => {
      // e.g. 1e18 for ETH/other assets but here we just test the math
      expect(formatTokenBalance(1000, 2)).toBe("10.00 XLM"); // 1000 / 10^2 = 10
    });
  });
});
