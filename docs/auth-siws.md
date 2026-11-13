# Sign-In with Stellar (SIWS / SEP-0010)

> Implements issue **#69 — [Backend/Integration] Implement Web3 authentication via SIWS**

"Sign in with Stellar" is the only login method: users authenticate by
**signing a challenge with their wallet** (Varial, xBull, Albedo, or a
WalletConnect mobile wallet) instead of typing a password, and the backend turns
that proof into a signed session cookie.

---

## 1. Protocol (Task 1: SEP-0010 research → design)

[SEP-0010](https://stellar.org/protocol/sep-10) defines Web Authentication via a
challenge-response transaction — it's the same mechanism the SEP-24 fiat-ramp work
(#21) already uses to auth with an *anchor*. Here TrustLend is both the **server**
issuing the challenge and the **relying party** consuming the proof:

```
Client                          Backend (/api/auth/siws/*)          Postgres (Neon)
  │  connect wallet                     │                               │
  │────────────────────────────────────►│                               │
  │  POST /challenge { address }        │                               │
  │─────────────────────────────────────►  buildChallenge(address)      │
  │                                     │  WebAuth.buildChallengeTx()   │
  │  ◄──────────── { transaction, networkPassphrase }                  │
  │  sign challenge tx (wallet)          │                               │
  │  POST /verify { address, signedTxXdr, role? }                       │
  │─────────────────────────────────────►  verifyChallenge()            │
  │                                     │  WebAuth.readChallengeTx()    │
  │                                     │  WebAuth.verifyChallengeTxSigners()
  │                                     │  issueSessionForWallet() ────► upsert users + profiles
  │  ◄──── 200 { userId, role, isNewUser } + Set-Cookie: tl_session ◄──│
```

**Sessions** are stateless: `/verify` signs an HS256 JWT (`jose`) holding the
user id, wallet and role, and stores it in the HttpOnly `tl_session` cookie
(7 days). The edge proxy verifies the cookie locally for routing; pages and API
routes call `getSessionUser()` / `requireAuthenticatedUser()` in
[lib/auth/session.ts](../lib/auth/session.ts), which re-reads the `users` row so
a deleted or re-roled account is reflected immediately.
`POST /api/auth/signout` clears the cookie.

## 2. Backend: challenge endpoint (Task 2)

**`POST /api/auth/siws/challenge`** — [route](../app/api/auth/siws/challenge/route.ts)
```jsonc
// request
{ "address": "GABC...WALLET" }
// response 200
{ "transaction": "<base64 XDR>", "networkPassphrase": "Test SDF Network ; September 2015" }
```
Built with `WebAuth.buildChallengeTx` ([lib/auth/siws-server.ts](../lib/auth/siws-server.ts)),
signed by a dedicated **SEP-10 server key** (`SIWS_SERVER_SECRET`, distinct from
the platform admin key), valid for 5 minutes, bound to `NEXT_PUBLIC_SIWS_DOMAIN`.
Rate-limited via the existing `enforceRouteRateLimit`.

## 3. Client: pick a wallet, then sign (Task 3)

[lib/auth/siws-client.ts](../lib/auth/siws-client.ts) `signInWithStellar()` drives the
whole flow; [components/auth/StellarSignInButton.tsx](../components/auth/StellarSignInButton.tsx)
is the "Sign in with Stellar" button on the auth page — the only sign-in method
([components/auth/AuthPageClient.tsx](../components/auth/AuthPageClient.tsx)). It
reuses the existing multi-wallet signer
([lib/stellar/wallet.ts](../lib/stellar/wallet.ts)) so the challenge is signed exactly
like any other TrustLend wallet transaction.

Clicking the button opens the wallet picker
([components/ui/WalletSelectionModal.tsx](../components/ui/WalletSelectionModal.tsx),
shared with the dashboard's `WalletCard`), which offers **Varial**,
**WalletConnect**, **xBull** and **Albedo**. The chosen provider is passed into
`signInWithStellar(provider, role)`, so the login challenge is signed by whichever
wallet the user picked.

### Mobile wallets (WalletConnect v2)

Choosing **WalletConnect** opens a QR code the user scans with a mobile Stellar
wallet (LOBSTR, Varial Mobile, …); the sign request is then relayed to the
phone for approval, and the signed XDR comes back over the same session. A few
details matter for this to work end to end:

- **Module id.** The kit registers WalletConnect as `wallet_connect` (underscore).
  These ids live in [lib/stellar/wallet-providers.ts](../lib/stellar/wallet-providers.ts);
  `assertWalletModuleIds()` warns in development if the kit ever renames one.
- **Chain negotiation.** The session is opened with `allowedChains` derived from
  `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` (`stellar:pubnet` for mainnet, otherwise
  `stellar:testnet`). The kit defaults to pubnet only, which makes testnet signing
  fail with a chain mismatch after the wallet has already paired.
- **Connecting.** `connectWallet()` uses the kit's `fetchAddress()`, which calls into
  the module and opens the QR modal. `getAddress()` only reads the kit's in-memory
  address and throws when empty, so it never triggers a pairing.
- **Readiness.** The WalletConnect sign client boots asynchronously, so the module
  reports itself unavailable for a moment after init. `connectWallet()` polls
  `isAvailable()` before connecting instead of failing on a cold start.
- **Sessions.** The kit persists the address, selected module and WalletConnect
  session topics in `localStorage`, so a reload keeps signing. A cached address is
  only reused when it belongs to the wallet being requested — otherwise a previously
  connected Varial address would be handed to a WalletConnect request that has no
  matching session. Disconnecting calls `disconnectWallet()`, which closes the pairing.
- **CSP.** The relay and Reown AppKit origins are allowlisted in
  [next.config.ts](../next.config.ts); without them the browser blocks the relay socket.

## 4. Backend: signature validation → session (Task 4)

**`POST /api/auth/siws/verify`** — [route](../app/api/auth/siws/verify/route.ts)
```jsonc
// request
{ "address": "GABC...", "signedTxXdr": "<base64 XDR>" }
// response 200 (+ Set-Cookie: tl_session=<jwt>; HttpOnly; SameSite=Lax)
{ "userId": "uuid", "role": "borrower", "isNewUser": true }
```
`verifyChallenge()` performs three checks via the Stellar SDK's `WebAuth` module:
1. **Structure & expiry** — `WebAuth.readChallengeTx` (throws on a malformed or
   timed-out challenge).
2. **Address match** — the challenge's `clientAccountID` must equal the address
   the client claims to be signing in as.
3. **Signature** — `WebAuth.verifyChallengeTxSigners` confirms the wallet actually
   signed it.

On success, `issueSessionForWallet()` upserts the `users` row keyed by wallet
address (and a matching `profiles` row), the route sets the session cookie, and
role-based routing (`getDashboardPath`) takes over. The role chosen on the auth
page only applies to brand-new accounts; an existing account keeps its role.

## 5. Error states (Task 5)

Every failure is a typed `SiwsError` with a `code` + HTTP status
([lib/auth/siws-server.ts](../lib/auth/siws-server.ts)), mapped to a friendly message
client-side (`mapVerifyError` in [lib/auth/siws-client.ts](../lib/auth/siws-client.ts)):

| Code | HTTP | User sees |
|---|---|---|
| `invalid_address` | 400 | "That wallet address is not valid." |
| `invalid_challenge` | 400 | "The sign-in challenge was invalid. Please retry." |
| `expired_challenge` | 401 | "Your sign-in request expired. Please try again." |
| `invalid_signature` | 401 | "We couldn't verify your wallet signature. Please try again." |
| `address_mismatch` | 400 | "The signature didn't match the connected wallet. Reconnect and retry." |
| `not_configured` / `session_failed` | 503/500 | "Stellar sign-in is temporarily unavailable. Please try another method." |

The button also surfaces wallet-level errors (Varial not installed, wrong
network, user rejected) via the existing `signTransactionWithWallet` error paths.

## 6. Configuration

```bash
NEXT_PUBLIC_SIWS_DOMAIN=localhost:3000   # SEP-10 home/web-auth domain (both sides must match)
SIWS_SERVER_SECRET=                       # dedicated SEP-10 signing key (S...)
SESSION_SECRET=                           # >= 32 chars; signs the session cookie
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=     # Reown/WalletConnect Cloud project id (enables mobile wallets)
# reuses: DATABASE_URL, NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE
```

## 7. Tests

[__tests__/auth/siws.test.ts](../__tests__/auth/siws.test.ts) exercises the real
`WebAuth` roundtrip (build → sign → verify) with an in-memory test keypair —
happy path, wrong-signer, address mismatch, expired challenge, and malformed XDR —
without hitting the network or the database.

## 8. Notes

- The SEP-10 signing key is intentionally **separate** from the platform admin
  key used elsewhere (oracle, governance, default-management) — compromising one
  cannot forge the other.
- Rotating `SESSION_SECRET` signs every user out (their cookies stop
  verifying); the accounts themselves are unaffected.
- Admin access requires both an allowlist entry (`TRADE_VAULT_ADMIN_EMAILS`
  accepts wallet addresses or e-mails) and `profiles.role = 'admin'`.
