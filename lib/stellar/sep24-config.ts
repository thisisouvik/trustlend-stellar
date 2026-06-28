/**
 * lib/stellar/sep24-config.ts
 *
 * Configuration for SEP-24 (interactive deposit/withdraw) fiat on/off ramps via
 * Stellar Anchors. Defaults target the SDF reference test anchor on testnet so
 * the flow works out-of-the-box; override via env for a production anchor.
 *
 * SEP-24 spec: https://stellar.org/protocol/sep-24
 * SDF test anchor: https://testanchor.stellar.org/.well-known/stellar.toml
 */

export interface Sep24AnchorConfig {
  /** Anchor home domain hosting /.well-known/stellar.toml (no protocol). */
  homeDomain: string;
  /** Asset code the borrower cashes out to fiat, e.g. "USDC" or "SRT". */
  assetCode: string;
  /**
   * Optional asset issuer (G...). If omitted it is resolved from the anchor's
   * stellar.toml CURRENCIES list by matching `assetCode`.
   */
  assetIssuer?: string;
  /** Network passphrase used when signing the SEP-10 challenge. */
  networkPassphrase: string;
}

const DEFAULT_HOME_DOMAIN = "testanchor.stellar.org";
const DEFAULT_ASSET_CODE = "SRT"; // SDF test anchor's reference asset

export function getSep24Config(): Sep24AnchorConfig {
  return {
    homeDomain:
      process.env.NEXT_PUBLIC_SEP24_ANCHOR_HOME_DOMAIN ?? DEFAULT_HOME_DOMAIN,
    assetCode: process.env.NEXT_PUBLIC_SEP24_ASSET_CODE ?? DEFAULT_ASSET_CODE,
    assetIssuer: process.env.NEXT_PUBLIC_SEP24_ASSET_ISSUER || undefined,
    networkPassphrase:
      process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
      "Test SDF Network ; September 2015",
  };
}
