/**
 * lib/stellar/sep24.ts
 *
 * Standard SEP-24 client for cross-border fiat on/off ramps via Stellar Anchors.
 * Implements the full flow with plain `fetch` + the project's existing wallet
 * signer (Freighter / Albedo), so no extra heavy SDK dependency is required:
 *
 *   1. discoverAnchor()        — read /.well-known/stellar.toml (SEP-1)
 *   2. authenticate()          — SEP-10 challenge → wallet-signed JWT
 *   3. startInteractiveWithdraw / startInteractiveDeposit — SEP-24 POST
 *   4. pollTransaction()       — SEP-24 transaction status polling
 *
 * Specs: SEP-1 (toml), SEP-10 (auth), SEP-24 (interactive deposit/withdraw).
 */

"use client";

import { signTransactionWithWallet, type StellarWalletProvider } from "@/lib/stellar/wallet";
import { getSep24Config, type Sep24AnchorConfig } from "@/lib/stellar/sep24-config";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface AnchorEndpoints {
  /** TRANSFER_SERVER_SEP0024 base URL */
  transferServer: string;
  /** WEB_AUTH_ENDPOINT (SEP-10) URL */
  webAuthEndpoint: string;
  /** Anchor SEP-10 server signing key (G...) */
  signingKey: string;
  /** Resolved issuer for the configured asset code */
  assetIssuer: string;
}

export interface InteractiveSession {
  /** SEP-24 transaction id, used to poll status */
  id: string;
  /** Interactive URL to present to the user (popup / iframe) */
  url: string;
  type: string;
}

export type Sep24TxStatus =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_user_transfer_complete"
  | "pending_external"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_trust"
  | "pending_user"
  | "completed"
  | "refunded"
  | "expired"
  | "error"
  | "no_market"
  | "too_small"
  | "too_large";

export interface Sep24Transaction {
  id: string;
  kind: "deposit" | "withdrawal";
  status: Sep24TxStatus;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  more_info_url?: string;
  stellar_transaction_id?: string;
  message?: string;
}

// ─── Minimal stellar.toml parser ──────────────────────────────────────────────────
// We only need a handful of top-level string keys plus the CURRENCIES list, so a
// tiny line-based parser avoids pulling in a full TOML dependency.

function parseToml(toml: string): {
  top: Record<string, string>;
  currencies: Array<Record<string, string>>;
} {
  const top: Record<string, string> = {};
  const currencies: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let inCurrency = false;

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    if (line === "[[CURRENCIES]]") {
      current = {};
      currencies.push(current);
      inCurrency = true;
      continue;
    }
    // Any other table header ends the CURRENCIES context.
    if (line.startsWith("[")) {
      inCurrency = false;
      current = null;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    if (inCurrency && current) {
      current[key] = value;
    } else {
      top[key] = value;
    }
  }

  return { top, currencies };
}

// ─── 1. Anchor discovery (SEP-1) ──────────────────────────────────────────────────

export async function discoverAnchor(
  config: Sep24AnchorConfig = getSep24Config()
): Promise<AnchorEndpoints> {
  const tomlUrl = `https://${config.homeDomain}/.well-known/stellar.toml`;
  const res = await fetch(tomlUrl, { headers: { Accept: "text/plain" } });
  if (!res.ok) {
    throw new Error(
      `Could not load anchor stellar.toml from ${tomlUrl} (${res.status}).`
    );
  }
  const { top, currencies } = parseToml(await res.text());

  const transferServer = top.TRANSFER_SERVER_SEP0024 || top.TRANSFER_SERVER;
  const webAuthEndpoint = top.WEB_AUTH_ENDPOINT;
  const signingKey = top.SIGNING_KEY;

  if (!transferServer) {
    throw new Error("Anchor does not advertise TRANSFER_SERVER_SEP0024 — SEP-24 unsupported.");
  }
  if (!webAuthEndpoint || !signingKey) {
    throw new Error("Anchor is missing WEB_AUTH_ENDPOINT / SIGNING_KEY for SEP-10 auth.");
  }

  const assetIssuer =
    config.assetIssuer ||
    currencies.find((c) => c.code === config.assetCode)?.issuer ||
    "";
  if (!assetIssuer && config.assetCode !== "native") {
    throw new Error(
      `Asset "${config.assetCode}" not found in the anchor's CURRENCIES. ` +
        `Set NEXT_PUBLIC_SEP24_ASSET_ISSUER or NEXT_PUBLIC_SEP24_ASSET_CODE.`
    );
  }

  return {
    transferServer: transferServer.replace(/\/$/, ""),
    webAuthEndpoint: webAuthEndpoint.replace(/\/$/, ""),
    signingKey,
    assetIssuer,
  };
}

// ─── 2. SEP-10 authentication → JWT ───────────────────────────────────────────────

export async function authenticate(
  endpoints: AnchorEndpoints,
  account: string,
  options: { provider?: StellarWalletProvider; config?: Sep24AnchorConfig } = {}
): Promise<string> {
  const config = options.config ?? getSep24Config();

  // 2a. Request the challenge transaction.
  const challengeRes = await fetch(
    `${endpoints.webAuthEndpoint}?account=${encodeURIComponent(account)}&home_domain=${encodeURIComponent(config.homeDomain)}`
  );
  if (!challengeRes.ok) {
    throw new Error(`SEP-10 challenge request failed (${challengeRes.status}).`);
  }
  const challenge = (await challengeRes.json()) as {
    transaction?: string;
    network_passphrase?: string;
    error?: string;
  };
  if (challenge.error || !challenge.transaction) {
    throw new Error(`SEP-10 challenge error: ${challenge.error ?? "no transaction returned"}`);
  }

  // 2b. Sign the challenge with the user's wallet.
  const signed = await signTransactionWithWallet({
    xdr: challenge.transaction,
    networkPassphrase: challenge.network_passphrase ?? config.networkPassphrase,
    address: account,
    provider: options.provider,
  });

  // 2c. Exchange the signed challenge for a JWT.
  const tokenRes = await fetch(endpoints.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signed.signedTxXdr }),
  });
  if (!tokenRes.ok) {
    throw new Error(`SEP-10 token request failed (${tokenRes.status}).`);
  }
  const tokenJson = (await tokenRes.json()) as { token?: string; error?: string };
  if (tokenJson.error || !tokenJson.token) {
    throw new Error(`SEP-10 token error: ${tokenJson.error ?? "no token returned"}`);
  }
  return tokenJson.token;
}

// ─── 3. Interactive deposit / withdraw (SEP-24) ───────────────────────────────────

async function startInteractive(
  kind: "withdraw" | "deposit",
  endpoints: AnchorEndpoints,
  jwt: string,
  params: { account: string; assetCode: string; amount?: string; extra?: Record<string, string> }
): Promise<InteractiveSession> {
  const body: Record<string, string> = {
    asset_code: params.assetCode,
    account: params.account,
    ...(params.amount ? { amount: params.amount } : {}),
    ...(params.extra ?? {}),
  };
  if (endpoints.assetIssuer) body.asset_issuer = endpoints.assetIssuer;

  const res = await fetch(`${endpoints.transferServer}/transactions/${kind}/interactive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as {
    type?: string;
    url?: string;
    id?: string;
    error?: string;
  };
  if (!res.ok || json.error || !json.url || !json.id) {
    throw new Error(
      `SEP-24 ${kind} init failed: ${json.error ?? res.statusText} (${res.status}).`
    );
  }
  return { id: json.id, url: json.url, type: json.type ?? "interactive_customer_info_needed" };
}

/** Off-ramp: cash out the on-chain asset to a bank / mobile-money account. */
export function startInteractiveWithdraw(
  endpoints: AnchorEndpoints,
  jwt: string,
  params: { account: string; assetCode: string; amount?: string }
): Promise<InteractiveSession> {
  return startInteractive("withdraw", endpoints, jwt, params);
}

/** On-ramp: fund the wallet from fiat. */
export function startInteractiveDeposit(
  endpoints: AnchorEndpoints,
  jwt: string,
  params: { account: string; assetCode: string; amount?: string }
): Promise<InteractiveSession> {
  return startInteractive("deposit", endpoints, jwt, params);
}

// ─── 4. Transaction status polling (SEP-24) ───────────────────────────────────────

export async function getTransaction(
  endpoints: AnchorEndpoints,
  jwt: string,
  id: string
): Promise<Sep24Transaction> {
  const res = await fetch(
    `${endpoints.transferServer}/transaction?id=${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  if (!res.ok) {
    throw new Error(`SEP-24 status request failed (${res.status}).`);
  }
  const json = (await res.json()) as { transaction?: Sep24Transaction; error?: string };
  if (json.error || !json.transaction) {
    throw new Error(`SEP-24 status error: ${json.error ?? "no transaction returned"}`);
  }
  return json.transaction;
}

/** Terminal statuses where polling should stop. */
const TERMINAL_STATUSES: Sep24TxStatus[] = [
  "completed",
  "refunded",
  "expired",
  "error",
  "no_market",
  "too_small",
  "too_large",
];

export function isTerminalStatus(status: Sep24TxStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Poll a SEP-24 transaction until it reaches a terminal state (or the caller
 * aborts via the AbortSignal). `onUpdate` fires on every status change.
 */
export async function pollTransaction(
  endpoints: AnchorEndpoints,
  jwt: string,
  id: string,
  onUpdate: (tx: Sep24Transaction) => void,
  options: { intervalMs?: number; signal?: AbortSignal } = {}
): Promise<Sep24Transaction> {
  const intervalMs = options.intervalMs ?? 5000;
  let lastStatus: string | null = null;

  for (;;) {
    if (options.signal?.aborted) {
      throw new DOMException("Polling aborted", "AbortError");
    }
    const tx = await getTransaction(endpoints, jwt, id);
    if (tx.status !== lastStatus) {
      lastStatus = tx.status;
      onUpdate(tx);
    }
    if (isTerminalStatus(tx.status)) {
      return tx;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─── Human-readable status labels ─────────────────────────────────────────────────

export const SEP24_STATUS_LABEL: Record<Sep24TxStatus, string> = {
  incomplete: "Waiting for your details…",
  pending_user_transfer_start: "Send your funds to the anchor to continue",
  pending_user_transfer_complete: "Funds received — finishing up",
  pending_external: "Processing with the banking / mobile-money provider",
  pending_anchor: "Anchor is processing your withdrawal",
  pending_stellar: "Settling on the Stellar network",
  pending_trust: "Waiting for a trustline",
  pending_user: "Action required in the anchor window",
  completed: "Completed — fiat is on its way 🎉",
  refunded: "Refunded",
  expired: "Session expired — please retry",
  error: "Something went wrong at the anchor",
  no_market: "No market for this asset",
  too_small: "Amount below the anchor's minimum",
  too_large: "Amount above the anchor's maximum",
};
