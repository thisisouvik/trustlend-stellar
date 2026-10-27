# Formal Verification for TrustLend Lending Protocol

## Why Formal Verification

Unit tests demonstrate the *absence* of bugs for specific inputs. A lending
protocol handling financial assets requires stronger guarantees: mathematical
proofs that core invariants hold for **all** inputs within defined ranges.

Formal verification was added to:
1. **Prove correctness** of interest calculations, fee formulas, and accounting logic.
2. **Detect edge cases** that manual test cases miss (integer overflow, negative debt, etc.).
3. **Provide CI-enforced guarantees** that regressions are caught immediately.

## Framework Selection

### Kani (Rust Model Checker) — Primary

**Why Kani:**
- Native Rust — no external DSL or K definitions required
- `#![no_std]` compatible — works with Soroban's constrained environment
- Enumerates all execution paths within bounded input ranges
- Produces concrete counterexamples on failure
- Integrates via `cargo kani` with minimal setup

**Alternatives considered:**
| Framework | Verdict |
|---|---|
| Certora | Solidity-only; incompatible with Rust/Soroban |
| K Framework | Requires writing K definitions from scratch; steep learning curve |
| Prusti | Limited support for Soroban macro-heavy code |
| MIRI | Detects undefined behavior only, not logical invariants |

### proptest (Property-Based Testing) — Complementary

**Why proptest:**
- Fuzz-tests mathematical functions with randomly generated inputs
- Stochastic exploration can discover edge cases missed by Kani's bounded enumeration
- Runs inside standard `cargo test` — no additional toolchain
- Excellent for arithmetic edge cases (overflow, division by zero, boundary values)

## Verified Invariants

### Accounting & Asset Conservation (13 invariants)

| ID | Invariant |
|---|---|
| INV-ACCT-1 | `remaining_due >= 0` after loan creation |
| INV-ACCT-2 | `remaining_due <= total_due` at creation |
| INV-ACCT-3 | `total_due >= principal` (interest is non-negative) |
| INV-ACCT-4 | `remaining_due` never goes negative after payment |
| INV-ACCT-5 | Payment reduces `remaining_due` by at most `payment_amount` |
| INV-ACCT-6 | `remaining_due == 0` implies `status == Repaid` |
| INV-ACCT-7 | Full payment zeroes `remaining_due` exactly |
| INV-ACCT-8 | Platform fees accumulate into `UncollectedFees` only as interest is settled |
| INV-ACCT-9 | Rate switch fee correctly increases both `remaining_due` and `total_due` |
| INV-ACCT-10 | Partial payments never mark loan as Repaid |
| INV-ACCT-11 | **Collateral Conservation:** $\text{balance}(\text{LendingContract}, A) \ge \sum_{\text{borrower}} \text{UserCollateral}(\text{borrower}, A)$ |
| INV-ACCT-12 | **Fee Backing:** $\text{balance}(\text{LendingContract}, T_{\text{fee}}) \ge \text{TotalCollateral}(T_{\text{fee}}) + \text{UncollectedFees}$ |
| INV-ACCT-13 | **Solvency Under Collection:** Executing `collect_fees` never reduces $\text{balance}(\text{LendingContract}, A)$ below $\text{TotalCollateral}(A)$ |

#### Collateral Conservation & Backed Fee Accrual Specifications

When the configured fee token $T_{\text{fee}}$ is also a whitelisted collateral asset (such as native XLM), `LendingContract` holds both depositor collateral (`UserCollateral`) and protocol fees (`UncollectedFees`) in a single contract token balance. To prevent fee accrual or collection from encroaching on depositor collateral, this change specifies three desired conservation laws. The added Kani harnesses and property tests verify standalone reference models; they do not invoke or establish enforcement by production `LendingContract`.

1. **Collateral Conservation Invariant (`INV-ACCT-11`):**
   For every whitelisted asset $A$:
   $$\text{balance}(\text{LendingContract}, A) \ge \text{TotalCollateral}(A) = \sum_{\text{borrower}} \text{UserCollateral}(\text{borrower}, A)$$

2. **Fee Backing Invariant (`INV-ACCT-12`):**
   For the configured fee token $T_{\text{fee}}$:
   $$\text{balance}(\text{LendingContract}, T_{\text{fee}}) \ge \text{TotalCollateral}(T_{\text{fee}}) + \text{UncollectedFees}$$

3. **Solvency Under Collection (`INV-ACCT-13`):**
   The proposed reference-model `collect_fees` guard requires $\text{balance}(\text{LendingContract}, T_{\text{fee}}) - \text{TotalCollateral}(T_{\text{fee}}) \ge \text{UncollectedFees}$ and must never reduce $\text{balance}(\text{LendingContract}, A)$ below $\text{TotalCollateral}(A)$ for any asset.

**Coverage boundary:** `ConservationVault` delays fee accrual until modeled settlement, credits the corresponding tokens, and applies a collateral-aware collection guard. Production `create_loan_request` currently accrues `UncollectedFees` without the matching inflow, `record_payment` updates loan/payment records, and `collect_fees` checks the fee-token balance rather than subtracting collateral. These tests do not prove production solvency or implement that separate accounting change. INV-ACCT-11 through INV-ACCT-13 remain specifications for production until real-contract integration tests and the corresponding implementation are added.

The new negative controls independently vary token inflow and fee liability and remove collateral tokens to ensure the reference-model checks detect underfunding. Kani settlement also receives an independent inflow and rejects unbacked accrual rather than assuming matching funds.

### State Machine (10 invariants)

| ID | Invariant |
|---|---|
| INV-SM-1 | Pending can only transition to Approved or Cancelled |
| INV-SM-2 | Approved can only transition to Active or Pending (revoke) |
| INV-SM-3 | Active can only transition to Active, Repaid, or Defaulted |
| INV-SM-4 | Repaid is a terminal state |
| INV-SM-5 | Defaulted is a terminal state |
| INV-SM-6 | Cancelled is a terminal state |
| INV-SM-7 | Paused contracts block Approve, Activate, Default, SwitchRate |
| INV-SM-8 | RecordPayment is NOT blocked when paused |
| INV-SM-9 | No transitions from terminal states |
| INV-SM-10 | State machine has exactly 6 states |

### Flash Loans (10 invariants)

| ID | Invariant |
|---|---|
| INV-FL-1 | Flash loan fee is non-negative |
| INV-FL-2 | Flash loan fee does not exceed borrowed amount |
| INV-FL-3 | Successful flash loan increases pool by at least the fee |
| INV-FL-4 | Failed flash loan leaves pool unchanged (rollback) |
| INV-FL-5 | Zero amount is rejected |
| INV-FL-6 | Negative amount is rejected |
| INV-FL-7 | Insufficient pool liquidity is rejected |
| INV-FL-8 | Fee formula: `fee == amount * fee_bps / 10_000` |
| INV-FL-9 | Fee is monotonically non-decreasing in amount |
| INV-FL-10 | Fee is monotonically non-decreasing in fee_bps |

### Fees (13 invariants)

| ID | Invariant |
|---|---|
| INV-FEE-1 | Platform fee cannot exceed MAX_PLATFORM_FEE_BPS (1000) |
| INV-FEE-2 | Flash loan fee cannot exceed MAX_FLASH_LOAN_FEE_BPS (500) |
| INV-FEE-3 | Platform fee at exactly MAX is accepted |
| INV-FEE-4 | Flash loan fee at exactly MAX is accepted |
| INV-FEE-5 | Platform fee at MAX + 1 is rejected |
| INV-FEE-6 | Flash loan fee at MAX + 1 is rejected |
| INV-FEE-7 | Default platform fee is 100 bps |
| INV-FEE-8 | Default flash loan fee is 9 bps |
| INV-FEE-9 | Rate switch fee formula is correct |
| INV-FEE-10 | Rate switch fee is at most 0.5% of remaining_due |
| INV-FEE-11 | Platform fee does not exceed interest |
| INV-FEE-12 | Fee validation is deterministic |
| INV-FEE-13 | Zero fee is accepted |

### Math (12 invariants)

| ID | Invariant |
|---|---|
| INV-MATH-1 | Interest formula does not overflow for bounded inputs |
| INV-MATH-2 | Interest is non-negative for positive inputs |
| INV-MATH-3 | Interest is strictly positive for inputs with `principal × rate_bps × days >= 3_650_000` |
| INV-MATH-4 | Interest is monotonically non-decreasing in principal |
| INV-MATH-5 | Interest is monotonically non-decreasing in rate |
| INV-MATH-6 | Interest is monotonically non-decreasing in days |
| INV-MATH-7 | Liquidation threshold is always in [5000, 9000] |
| INV-MATH-8 | Platform fee does not exceed interest |
| INV-MATH-9 | Flash loan fee does not exceed amount |
| INV-MATH-10 | Rate switch fee calculation is correct |
| INV-MATH-11 | Interest for 1 day at minimum rate is the smallest positive interest |
| INV-MATH-12 | 365-day interest equals `principal * rate_bps / 10_000` |

## Known Limitations

### Soroban Host Functions Cannot Be Model-Checked

Kani operates at the Rust MIR level and cannot verify Soroban host functions
(`env.storage()`, `env.events()`, token transfers). Proofs focus on the
**computation and state transition logic** that can be expressed in pure Rust.

### Cross-Contract Behavior Is Outside Scope

The lending contract interacts with EscrowContract, GovernanceContract,
BorrowerReputationContract, and TreasuryContract. These cross-contract calls
cannot be verified in isolation. They require system-level verification tools
(not yet available for Soroban).

### Bounded Input Ranges

All proofs operate over bounded input ranges:
- Principal: 0 to 100,000 XLM (100_000_000_000 stroops)
- Rate: 1 to 1500 bps (0.01% to 15%)
- Duration: 1 to 365 days
- Fees: 0 to 1000 bps (platform), 0 to 500 bps (flash loan)

Values outside these ranges are not verified but represent the protocol's
operational bounds.

### Integer Division Truncation

The interest formula uses integer division (`/ (10_000 * 365)`), which loses
precision. Proofs verify the exact integer arithmetic, not ideal mathematical
equality. This means verified invariants hold for the *actual* contract behavior.

### proptest Is Stochastic

Property-based tests use randomised input generation. They explore the input
space statistically but cannot provide the same exhaustiveness guarantees as
Kani. Running more test iterations increases confidence.

## Running Verification

### Property-Based Tests (proptest)

```bash
cd contracts
cargo test -p lending --test proptest_tests -- --test-threads=1
```

### Kani Verification

Requires [Kani](https://model-checking.github.io/kani/) installed:

```bash
cd contracts/lending
kani kani_proofs/math.rs
kani kani_proofs/accounting.rs
kani kani_proofs/state_machine.rs
kani kani_proofs/flash_loan.rs
kani kani_proofs/fees.rs
```

### CI Integration

Verification runs automatically in CI via `.github/workflows/formal-verification.yml`:
- Triggers on PRs and pushes to main/dev that change `contracts/lending/**`
- Runs property-based tests
- Runs Kani model checking (when Kani is available in the CI environment)
- Failures block the merge pipeline

## File Structure

```
contracts/lending/
  kani_proofs/
    mod.rs              # Module root with documentation
    accounting.rs       # 13 accounting & conservation invariants
    state_machine.rs    # 10 state machine invariants
    flash_loan.rs       # 10 flash loan invariants
    fees.rs             # 13 fee invariants
    math.rs             # 12 math invariants
  tests/
    proptest_tests.rs   # Property-based tests (~300 lines)
  src/
    lib.rs              # Lending contract (unchanged)
    test.rs             # Existing unit tests (unchanged)
  Cargo.toml            # Added proptest dev-dependency
.github/workflows/
  formal-verification.yml   # CI workflow
docs/formal-verification.md  # This file
```
