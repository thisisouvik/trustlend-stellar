# Flash Loans — TrustLend Liquidity Pools

> Implements issue **#70 — [Smart Contracts] Implement flash loan capabilities for TrustLend liquidity pools**

> Flash-loan contract transactions use the centralized Stellar SDK RPC transport for simulation and transaction assembly.

Adds uncollateralized, single-transaction flash loans against the Lending
contract's own token balance, so external protocols can borrow, act, and repay
— plus a small protocol fee — atomically within one Soroban transaction, for
arbitrage or re-leveraging.

---

## 1. `flash_loan` (Task 1)

Added to [`contracts/lending/src/lib.rs`](../../contracts/lending/src/lib.rs):

```rust
pub fn flash_loan(env: Env, receiver: Address, token: Address, amount: i128, params: Bytes)
```

- `token` — any SEP-41 token address; the "liquidity pool" is simply whatever
  balance of that token the LendingContract's own address holds (funded by
  liquidity providers transferring the token directly to the contract, exactly
  like an AMM pool).
- `receiver` — a deployed contract implementing the callback interface (below).
- `amount` — how much to borrow, in the token's smallest unit.
- `params` — opaque bytes forwarded to the receiver's callback (its own
  operation parameters — e.g. which DEX pair to arbitrage).

## 2. Callback interface (Task 2)

```rust
#[contractclient(name = "FlashLoanReceiverClient")]
pub trait FlashLoanReceiver {
    fn execute_operation(
        env: Env,
        token: Address,
        amount: i128,
        fee: i128,
        initiator: Address,   // the LendingContract's own address — repay here
        params: Bytes,
    );
}
```

Any contract wanting to consume a TrustLend flash loan must export a function
with exactly this signature (`execute_operation`). There is no shared Rust
dependency needed — Soroban contracts are called by symbol name, the same way
this codebase already calls the SAC token contract without importing its
source. `contracts/lending/src/test.rs` includes four reference
implementations (see §5).

## 3. Atomicity: borrow → callback → enforce repayment (Tasks 3 & 4)

```
1. balance_before = token.balance(pool)
2. require balance_before >= amount                    (else panic — insufficient liquidity)
3. fee = amount * flash_loan_fee_bps / 10_000           (default 9 bps = 0.09%)
4. token.transfer(pool → receiver, amount)              ← funds leave the pool
5. receiver.execute_operation(token, amount, fee, pool, params)
      ↳ receiver's logic runs; it MUST token.transfer(receiver → pool, amount + fee)
6. balance_after = token.balance(pool)
7. require balance_after >= balance_before + fee        (else PANIC)
```

**Why this rolls back correctly (Task 4):** a Soroban contract invocation that
panics aborts the *entire* top-level transaction — every storage write and
every token transfer performed anywhere in the call tree during that
transaction, including step 4's initial disbursement, is undone. There is no
code path where the pool ends up short: either the callback repays in full
(step 7 passes) and every effect is kept, or it panics (ours or the
receiver's own) and *nothing* happened at all, atomically.

The check is `>=`, not `==`, so a receiver that repays more than required
still succeeds — the surplus simply accrues to the pool.

### Fee configuration

- `get_flash_loan_fee_bps()` — default **9 bps (0.09%)**, in line with common
  DeFi flash-loan pricing.
- `set_flash_loan_fee_bps(admin, bps)` — admin-only, hard-capped at
  **500 bps (5%)** (`MAX_FLASH_LOAN_FEE_BPS`) regardless of who calls it.

### Safety properties

- **Reentrancy is not a hazard here** the way it is on EVM: Soroban's
  authorization + storage model and the single-writer-per-invocation semantics
  mean a receiver calling back into `flash_loan` mid-callback still has its
  net effect checked against the *same* `balance_before` snapshot at the end
  — it cannot walk away with more than it repays without tripping the same
  final balance check.
- **No admin/backend intervention required** — everything happens on-chain,
  synchronously, in the caller's transaction.
- **Overflow-safe** — fee and required-balance arithmetic use `checked_mul` /
  `checked_add`, matching the rest of the contract's arithmetic style.

## 4. Unit tests (Task 5)

12 new tests in [`contracts/lending/src/test.rs`](../../contracts/lending/src/test.rs),
using a real SEP-41 test token (`env.register_stellar_asset_contract_v2`):

| Test | Proves |
|---|---|
| `test_flash_loan_success_full_repayment` | Happy path: pool gains exactly the fee, receiver ends at zero |
| `test_flash_loan_accepts_overpayment` | `>=` check allows (and keeps) a surplus repayment |
| `test_flash_loan_emits_correct_fee_for_custom_bps` | Admin-adjusted fee is applied correctly |
| `test_flash_loan_reverts_when_receiver_repays_nothing` | Full non-repayment panics with `"Flash loan not repaid"` |
| `test_flash_loan_reverts_on_partial_repayment` | Repaying principal but not fee still panics |
| `test_failed_flash_loan_rolls_back_pool_balance` | **Empirically proves atomic rollback**: catches the panic and asserts the pool's balance is exactly what it was before the call — the disbursed `amount` came back |
| `test_pool_usable_again_immediately_after_a_failed_flash_loan` | A failed attempt never leaves the pool short for the next borrower |
| `test_flash_loan_rejects_amount_over_pool_liquidity` | Can't borrow more than the pool holds |
| `test_flash_loan_rejects_zero_amount` / `_negative_amount` | Input validation |
| `test_only_admin_can_change_flash_loan_fee` | Non-admin fee changes are rejected |
| `test_flash_loan_fee_capped` | Fee can never exceed `MAX_FLASH_LOAN_FEE_BPS` |

```bash
cd contracts && cargo test -p lending
```

All 30 lending tests pass (18 pre-existing + 12 new); full workspace: **62/62**.

## 5. Reference receiver implementations (for the tests / integrators)

- `GoodReceiver` — repays `amount + fee` exactly.
- `GenerousReceiver` — repays more than required (tests the `>=` tolerance).
- `PartialReceiver` — repays only `amount`, not the fee (must fail).
- `StingyReceiver` — repays nothing (must fail).

Each lives in its own Rust module in the test file — `#[contractimpl] impl
FlashLoanReceiver for X` generates module-scoped symbols keyed by method name,
which collide if two implementations of the same trait share a module.

## 6. Frontend integration

- [`lib/contracts/lending.ts`](../../lib/contracts/lending.ts) — `flashLoan()`,
  `getFlashLoanFeeBps()`, `setFlashLoanFeeBps()`.
- [`lib/stellar/soroban.ts`](../../lib/stellar/soroban.ts) — new `bytesToScVal()`
  helper for encoding the callback `params`.

## 7. Future evolution

- `add_liquidity` / `remove_liquidity` methods for LPs, with pro-rata fee
  accrual tracking (out of scope here — the pool is funded by direct token
  transfers today, which is sufficient for the flash-loan mechanism itself).
- Route flash-loan fee income into the insurance fund (`default_management`)
  the same way platform fees do.
- Per-token fee overrides if the pool supports multiple assets.
