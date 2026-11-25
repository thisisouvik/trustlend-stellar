import { describe, expect, it } from "vitest";
import {
  generateReferralCode,
  normalizeReferralCode,
  isValidReferralCode,
  buildReferralLink,
  extractReferralCode,
  REFERRAL_ALPHABET,
  REFERRAL_PREFIX,
  REFERRAL_CODE_LENGTH,
  REFERRAL_RANDOM_LENGTH,
  REFERRAL_CODE_SPACE,
  REFERRAL_CLAIM_STORAGE_KEY,
} from "@/lib/referrals/codes";

it("uses one documented session key for deferred referral claims", () => {
  expect(REFERRAL_CLAIM_STORAGE_KEY).toBe("trustlend.referralCode");
});

describe("generateReferralCode", () => {
  it("produces a structurally valid code", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateReferralCode();
      expect(isValidReferralCode(code), code).toBe(true);
      expect(code.length).toBe(REFERRAL_CODE_LENGTH);
      expect(code.startsWith(REFERRAL_PREFIX)).toBe(true);
    }
  });

  it("only ever uses the unambiguous alphabet", () => {
    // 0/O, 1/I/L and U must never appear — they cause transcription errors
    // when someone reads a link aloud or retypes it.
    for (let i = 0; i < 500; i++) {
      const body = generateReferralCode().slice(REFERRAL_PREFIX.length);
      for (const char of body) {
        expect(REFERRAL_ALPHABET.includes(char), `char ${char}`).toBe(true);
      }
      expect(body).not.toMatch(/[01OILU]/);
    }
  });

  it("does not repeat itself over many draws", () => {
    // Not a statistical proof, but a stuck RNG or a constant would fail here.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateReferralCode());
    expect(seen.size).toBeGreaterThan(990);
  });

  it("uses the whole alphabet rather than a biased subset", () => {
    // Rejection sampling should reach every character given enough draws.
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      for (const char of generateReferralCode().slice(REFERRAL_PREFIX.length)) {
        seen.add(char);
      }
    }
    expect(seen.size).toBe(REFERRAL_ALPHABET.length);
  });

  it("documents a code space large enough to resist enumeration", () => {
    expect(REFERRAL_CODE_SPACE).toBe(
      Math.pow(REFERRAL_ALPHABET.length, REFERRAL_RANDOM_LENGTH),
    );
    expect(REFERRAL_CODE_SPACE).toBeGreaterThan(100_000_000);
  });
});

describe("isValidReferralCode", () => {
  it("accepts a canonical code", () => {
    expect(isValidReferralCode("TL23456789".slice(0, REFERRAL_CODE_LENGTH))).toBe(true);
  });

  it("rejects wrong length, wrong prefix and bad characters", () => {
    expect(isValidReferralCode("TL2345")).toBe(false); // too short
    expect(isValidReferralCode("TL23456789ABC")).toBe(false); // too long
    expect(isValidReferralCode("XX234567")).toBe(false); // wrong prefix
    expect(isValidReferralCode("TL2345O7")).toBe(false); // O is excluded
    expect(isValidReferralCode("TL23456l")).toBe(false); // lowercase, not canonical
  });

  it("rejects non-strings without throwing", () => {
    expect(isValidReferralCode(null)).toBe(false);
    expect(isValidReferralCode(undefined)).toBe(false);
    expect(isValidReferralCode(12345678)).toBe(false);
    expect(isValidReferralCode({})).toBe(false);
  });
});

describe("normalizeReferralCode", () => {
  const canonical = generateReferralCode();

  it("is a no-op on an already-canonical code", () => {
    expect(normalizeReferralCode(canonical)).toBe(canonical);
  });

  it("uppercases lowercase input", () => {
    expect(normalizeReferralCode(canonical.toLowerCase())).toBe(canonical);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeReferralCode(`  ${canonical}\n`)).toBe(canonical);
  });

  it("strips the separators people type by hand", () => {
    const spaced = `${canonical.slice(0, 2)}-${canonical.slice(2, 5)}-${canonical.slice(5)}`;
    expect(normalizeReferralCode(spaced)).toBe(canonical);
  });

  it("returns null for structurally invalid input", () => {
    expect(normalizeReferralCode("not a code")).toBeNull();
    expect(normalizeReferralCode("")).toBeNull();
    expect(normalizeReferralCode("TL0OIL12")).toBeNull();
  });

  it("returns null rather than throwing on non-strings", () => {
    expect(normalizeReferralCode(null)).toBeNull();
    expect(normalizeReferralCode(undefined)).toBeNull();
    expect(normalizeReferralCode(42)).toBeNull();
  });

  it("does not silently delete meaningful characters", () => {
    // A stray letter is a different code, not a separator to strip.
    expect(normalizeReferralCode(`${generateReferralCode()}Z`)).toBeNull();
  });
});

describe("buildReferralLink", () => {
  const code = generateReferralCode();

  it("builds an absolute invite URL", () => {
    expect(buildReferralLink(code, "https://trustlend.app")).toBe(
      `https://trustlend.app/auth?ref=${code}`,
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(buildReferralLink(code, "https://trustlend.app/")).toBe(
      `https://trustlend.app/auth?ref=${code}`,
    );
  });

  it("normalizes the code before embedding it", () => {
    expect(buildReferralLink(code.toLowerCase(), "https://trustlend.app")).toBe(
      `https://trustlend.app/auth?ref=${code}`,
    );
  });

  it("throws on an invalid code rather than emitting a broken link", () => {
    expect(() => buildReferralLink("nope", "https://trustlend.app")).toThrow();
  });
});

describe("extractReferralCode", () => {
  const code = generateReferralCode();

  it("reads the code from a full URL", () => {
    expect(extractReferralCode(`https://trustlend.app/auth?ref=${code}`)).toBe(code);
  });

  it("reads the code from a bare query string, with or without the '?'", () => {
    expect(extractReferralCode(`?ref=${code}`)).toBe(code);
    expect(extractReferralCode(`ref=${code}`)).toBe(code);
  });

  it("normalizes what it finds", () => {
    expect(extractReferralCode(`?ref=${code.toLowerCase()}`)).toBe(code);
  });

  it("survives extra query parameters", () => {
    expect(extractReferralCode(`https://x.app/auth?mode=signup&ref=${code}&t=1`)).toBe(code);
  });

  it("returns null when there is no usable code", () => {
    expect(extractReferralCode("https://trustlend.app/auth")).toBeNull();
    expect(extractReferralCode("?ref=garbage")).toBeNull();
    expect(extractReferralCode("?ref=")).toBeNull();
    expect(extractReferralCode("")).toBeNull();
  });

  it("round-trips with buildReferralLink", () => {
    const link = buildReferralLink(code, "https://trustlend.app");
    expect(extractReferralCode(link)).toBe(code);
  });
});
