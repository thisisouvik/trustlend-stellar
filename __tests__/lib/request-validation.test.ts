import {
  isBoundedString,
  isUuid,
  isValidStellarAddress,
  parseBoundedInteger,
} from "@/lib/http/request-validation";
import { describe, expect, it } from "vitest";

describe("request validation helpers", () => {
  it("accepts valid Stellar public keys and rejects malformed values", () => {
    expect(isValidStellarAddress(`G${"A".repeat(55)}`)).toBe(true);
    expect(isValidStellarAddress("Gshort")).toBe(false);
    expect(isValidStellarAddress("S" + "A".repeat(55))).toBe(false);
  });

  it("validates UUIDs and bounded strings", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isBoundedString(" valid ", 10)).toBe(true);
    expect(isBoundedString("x".repeat(11), 10)).toBe(false);
  });

  it("parses safe bounded integer query parameters", () => {
    expect(parseBoundedInteger(null, 10, 0, 100)).toBe(10);
    expect(parseBoundedInteger("25", 10, 0, 100)).toBe(25);
    expect(parseBoundedInteger("-1", 10, 0, 100)).toBeNull();
    expect(parseBoundedInteger("101", 10, 0, 100)).toBeNull();
  });
});
