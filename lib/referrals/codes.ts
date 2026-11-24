/**
 * Referral code generation and validation (Issue #266).
 *
 * Pure, dependency-free so it can run on the server, in the browser, and in
 * tests without a database or a wallet.
 *
 * Codes are what appear in a user's unique invite link
 * (`/auth?ref=TL7F3KQ2`), so they need to be:
 *   • short enough to read aloud and retype,
 *   • unambiguous — no 0/O or 1/I/L confusion,
 *   • case-insensitive on input, canonical uppercase on storage,
 *   • unguessable enough that nobody can enumerate other people's codes.
 */

/**
 * Crockford-style alphabet: digits and uppercase letters with the visually
 * ambiguous characters (0, O, 1, I, L, U) removed. U is dropped as well to
 * avoid accidentally generating profanity.
 */
export const REFERRAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Every generated code carries this prefix so it is recognisably TrustLend. */
export const REFERRAL_PREFIX = "TL";

/** Number of random characters after the prefix. */
export const REFERRAL_RANDOM_LENGTH = 6;

/** Total code length, including the prefix. */
export const REFERRAL_CODE_LENGTH = REFERRAL_PREFIX.length + REFERRAL_RANDOM_LENGTH;

/** Session-scoped handoff between an invite visit and authenticated claiming. */
export const REFERRAL_CLAIM_STORAGE_KEY = "trustlend.referralCode";

/**
 * With a 30-character alphabet and 6 random slots the space is 30^6 ≈ 729M.
 * Enumeration is impractical at any sane request rate, and collisions are
 * handled by a unique index plus retry at the call site.
 */
export const REFERRAL_CODE_SPACE = Math.pow(
  REFERRAL_ALPHABET.length,
  REFERRAL_RANDOM_LENGTH,
);

/**
 * Source of randomness. Uses Web Crypto, which exists in both the browser and
 * Node 18+. We reject a missing crypto implementation rather than silently
 * falling back to Math.random(), which would make codes predictable.
 */
function randomBytes(length: number): Uint8Array {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error(
      "Secure randomness unavailable: globalThis.crypto.getRandomValues is required to generate referral codes.",
    );
  }
  return cryptoObj.getRandomValues(new Uint8Array(length));
}

/**
 * Generate a new referral code, e.g. "TL7F3KQ2".
 *
 * Rejection sampling keeps the distribution uniform: a plain `byte % 30` would
 * make the first 16 characters of the alphabet slightly likelier than the rest.
 */
export function generateReferralCode(): string {
  const alphabetLength = REFERRAL_ALPHABET.length;
  // Largest multiple of the alphabet length that fits in a byte; values at or
  // above it are discarded rather than folded, which is what causes bias.
  const limit = Math.floor(256 / alphabetLength) * alphabetLength;

  let out = "";
  while (out.length < REFERRAL_RANDOM_LENGTH) {
    // Over-fetch a little so the common case needs one syscall, not six.
    const bytes = randomBytes(REFERRAL_RANDOM_LENGTH * 2);
    for (const byte of bytes) {
      if (out.length >= REFERRAL_RANDOM_LENGTH) break;
      if (byte >= limit) continue; // biased tail — resample
      out += REFERRAL_ALPHABET[byte % alphabetLength];
    }
  }

  return REFERRAL_PREFIX + out;
}

/**
 * Normalise user-supplied input into canonical form.
 *
 * Accepts lowercase, surrounding whitespace, and the separators people
 * naturally type ("tl-7f3-kq2"). Returns null when the result is not a
 * structurally valid code, so callers never have to trust raw query strings.
 */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== "string") return null;

  const cleaned = input
    .trim()
    .toUpperCase()
    // Strip the separators users add themselves; anything else is a real
    // character and must not be silently deleted.
    .replace(/[\s\-_]/g, "");

  return isValidReferralCode(cleaned) ? cleaned : null;
}

/** Whether a string is a structurally valid, already-canonical code. */
export function isValidReferralCode(code: unknown): code is string {
  if (typeof code !== "string") return false;
  if (code.length !== REFERRAL_CODE_LENGTH) return false;
  if (!code.startsWith(REFERRAL_PREFIX)) return false;

  const body = code.slice(REFERRAL_PREFIX.length);
  for (const char of body) {
    if (!REFERRAL_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * Build the shareable invite URL for a code.
 *
 * `baseUrl` should be an absolute origin. A trailing slash is tolerated so
 * callers can pass `NEXT_PUBLIC_SITE_URL` without normalising it first.
 */
export function buildReferralLink(code: string, baseUrl: string): string {
  const normalized = normalizeReferralCode(code);
  if (!normalized) {
    throw new Error(`Cannot build a referral link for invalid code: ${code}`);
  }
  const origin = baseUrl.replace(/\/+$/, "");
  return `${origin}/auth?ref=${normalized}`;
}

/**
 * Extract a referral code from a URL or a raw query string.
 * Returns null when absent or malformed — callers treat that as "no referral".
 */
export function extractReferralCode(urlOrQuery: string): string | null {
  if (typeof urlOrQuery !== "string" || urlOrQuery === "") return null;

  // Try a full URL first, then fall back to a bare query string.
  let params: URLSearchParams;
  try {
    params = new URL(urlOrQuery).searchParams;
  } catch {
    const queryPart = urlOrQuery.startsWith("?")
      ? urlOrQuery.slice(1)
      : urlOrQuery;
    params = new URLSearchParams(queryPart);
  }

  return normalizeReferralCode(params.get("ref"));
}
