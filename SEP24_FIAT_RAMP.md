# Cross-Border Fiat On/Off Ramp — Stellar Anchors (SEP-24)

> Implements issue **#21 — [Feature] Add cross-border fiat on/off ramp integrations via Stellar Anchors**
> and the README "Vision" item *Global Fiat On/Off Ramps*.

Borrowers in emerging markets receive loans on-chain but need **local fiat**. This
integration lets them **cash out directly to a bank account or mobile-money wallet**
through a Stellar Anchor using the standard **SEP-24 interactive** flow — no leaving
the TrustLend dashboard.

---

## 1. Why standard SEP-24 (not @stellar/wallet-sdk)

The issue allows either `@stellar/wallet-sdk` *or* standard SEP-24 flows. We chose
**standard flows on plain `fetch`** because:

- The rest of the codebase already talks to Stellar over raw `fetch` / JSON-RPC
  (see [lib/stellar/soroban.ts](lib/stellar/soroban.ts)) — this keeps the style
  consistent and the bundle small.
- `@stellar/wallet-sdk` is deprecated (superseded by `@stellar/typescript-wallet-sdk`);
  avoiding it removes a heavy, churning dependency.
- We reuse the existing multi-wallet signer ([lib/stellar/wallet.ts](lib/stellar/wallet.ts))
  so SEP-10 challenges are signed by **Freighter or Albedo**, matching the app.

## 2. The flow

```
Borrower clicks "Withdraw to Fiat"
        │
        ▼
1. SEP-1  discoverAnchor()   ── GET https://<home_domain>/.well-known/stellar.toml
        │                        → TRANSFER_SERVER_SEP0024, WEB_AUTH_ENDPOINT, asset issuer
        ▼
2. SEP-10 authenticate()     ── GET challenge → wallet signs → POST → JWT
        │
        ▼
3. SEP-24 startInteractiveWithdraw()
        │                     ── POST /transactions/withdraw/interactive (Bearer JWT)
        │                        → { id, url }
        ▼
4. Open `url` in a popup     ── user enters bank / mobile-money payout details
        │
        ▼
5. pollTransaction()         ── GET /transaction?id=... until a terminal status
                                (completed / refunded / expired / error …)
```

## 3. Files

| File | Purpose |
|---|---|
| [lib/stellar/sep24-config.ts](lib/stellar/sep24-config.ts) | Env-driven anchor config (home domain, asset code/issuer) with testnet defaults |
| [lib/stellar/sep24.ts](lib/stellar/sep24.ts) | SEP-1 toml discovery, SEP-10 auth, SEP-24 interactive deposit/withdraw, status polling + labels |
| [components/dashboard/WithdrawToFiatButton.tsx](components/dashboard/WithdrawToFiatButton.tsx) | "Withdraw to Fiat" button + modal that drives the whole flow and shows live status |
| [app/dashboard/borrower/page.tsx](app/dashboard/borrower/page.tsx) | Renders the button in the Borrower dashboard |

Public API of `lib/stellar/sep24.ts`:

- `discoverAnchor(config?)` → `{ transferServer, webAuthEndpoint, signingKey, assetIssuer }`
- `authenticate(endpoints, account, { provider, config })` → JWT string
- `startInteractiveWithdraw(endpoints, jwt, { account, assetCode, amount? })` → `{ id, url, type }`
- `startInteractiveDeposit(...)` → same shape (on-ramp; UI button is withdraw)
- `getTransaction(endpoints, jwt, id)` / `pollTransaction(endpoints, jwt, id, onUpdate, { signal })`
- `isTerminalStatus(status)`, `SEP24_STATUS_LABEL`

## 4. UX details handled

- **Multi-wallet:** SEP-10 challenge is signed via the user's selected provider
  (Freighter/Albedo) through the existing `signTransactionWithWallet`.
- **Interactive URL:** opened in a popup; if the browser blocks it, an inline
  "Reopen anchor window" link is shown.
- **Live status:** the modal polls and renders friendly labels for each SEP-24
  state (e.g. *"Processing with the banking / mobile-money provider"*).
- **Cleanup:** polling is aborted via `AbortController` when the modal closes or
  the component unmounts.
- **No wallet:** the card prompts the user to connect a wallet first.

## 5. Configuration

Defaults work on testnet against the SDF reference anchor. Override in `.env.local`:

```bash
NEXT_PUBLIC_SEP24_ANCHOR_HOME_DOMAIN=testanchor.stellar.org
NEXT_PUBLIC_SEP24_ASSET_CODE=SRT          # or USDC
NEXT_PUBLIC_SEP24_ASSET_ISSUER=           # optional; auto-resolved from stellar.toml
```

For production, point `NEXT_PUBLIC_SEP24_ANCHOR_HOME_DOMAIN` at a regulated anchor
serving the borrower's region (bank / mobile-money rails) and set the appropriate
`NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` for mainnet.

> **Trustlines:** to receive a non-native anchored asset, the borrower's account
> must hold a trustline to `assetCode:assetIssuer`. Many anchors guide the user
> through this inside the interactive window; some require it beforehand.

## 6. Future evolution

- Surface a matching **"Add Funds from Fiat"** (deposit / on-ramp) button using the
  already-implemented `startInteractiveDeposit`.
- Persist SEP-24 transaction ids to Supabase so withdrawals show in **History**.
- Multi-anchor selection by borrower region/currency.
- SEP-6 (programmatic, non-interactive) rails for power users.
