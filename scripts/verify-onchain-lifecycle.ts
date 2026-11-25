#!/usr/bin/env tsx
/**
 * End-to-end check of the on-chain loan lifecycle against a live deployment.
 *
 *   ADMIN_SECRET_KEY=S... npx tsx scripts/verify-onchain-lifecycle.ts [--env-file=.env.local]
 *
 * Creates two throwaway testnet accounts (borrower, lender), then walks the
 * exact path the app takes, using the same server modules the API routes use:
 *
 *   1. borrower deposits collateral, then signs create_loan_request
 *                                               → verifyContractInvocation + get_loan
 *   2. lender pays the borrower (classic op)    → verifyPaymentTransaction
 *   3. lender signs approve_loan(id, 0)         → verifyContractInvocation
 *   4. server signs activate_loan               → status Active
 *   5. borrower repays the lender (classic op)  → verifyPaymentTransaction
 *   6. server signs record_payment (twice)      → Active, then Repaid
 *   7. server registers pool 1 + update_pool_state
 *
 * Exits non-zero on the first mismatch. Testnet only (uses friendbot).
 */

import fs from "node:fs";
import path from "node:path";
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

// ── Env loading (before importing app modules that read process.env) ─────────
const envArg = process.argv.find((a) => a.startsWith("--env-file="))?.split("=")[1] ?? ".env.local";
const envPath = path.resolve(process.cwd(), envArg);
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
process.env.NEXT_PUBLIC_ONCHAIN_LOAN_LIFECYCLE = "required";

const HORIZON = process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const RPC = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const FRIENDBOT = process.env.NEXT_PUBLIC_STELLAR_FRIENDBOT_URL ?? "https://friendbot.stellar.org";

async function main() {
  const lifecycle = await import("../lib/stellar/onchain-lifecycle");
  const { verifyPaymentTransaction, PAYMENT_MEMO } = await import("../lib/stellar/verify-payment");
  const { encodeLoanRequestInput } = await import("../lib/contracts/lending");
  const { addr, i128 } = await import("../lib/stellar/server-contract");
  const { nativeAssetContractId } = await import("../lib/stellar/native-asset");

  const lendingId = lifecycle.lendingContractId();
  const admin = lifecycle.requireAdminSigner();
  const horizon = new Horizon.Server(HORIZON);
  const soroban = new rpc.Server(RPC);

  const step = (msg: string) => console.log(`\n▶ ${msg}`);
  const ok = (msg: string) => console.log(`  ✔ ${msg}`);
  const fail = (msg: string): never => {
    console.error(`  ✖ ${msg}`);
    process.exit(1);
  };

  step("Funding throwaway borrower and lender accounts");
  const borrower = Keypair.random();
  const lender = Keypair.random();
  for (const kp of [borrower, lender]) {
    const res = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
    if (!res.ok) fail(`friendbot failed for ${kp.publicKey()} (${res.status})`);
  }
  ok(`borrower ${borrower.publicKey()}\n    lender   ${lender.publicKey()}`);

  async function invoke(
    signer: Keypair,
    method: string,
    args: Parameters<Contract["call"]>[1][],
    contractId: string = lendingId,
  ) {
    const account = await soroban.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await soroban.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) fail(`${method} simulation: ${sim.error}`);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(signer);
    const sent = await soroban.sendTransaction(prepared);
    if (sent.status === "ERROR") fail(`${method} submit: ${JSON.stringify(sent.errorResult)}`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await soroban.getTransaction(sent.hash);
      if (res.status === "SUCCESS") return { hash: sent.hash, returnValue: res.returnValue };
      if (res.status === "FAILED") fail(`${method} failed on-chain: ${sent.hash}`);
    }
    return fail(`${method} timed out`);
  }

  async function pay(from: Keypair, to: string, amount: string, memo: string) {
    const account = await horizon.loadAccount(from.publicKey());
    const tx = new TransactionBuilder(new Account(from.publicKey(), account.sequenceNumber()), {
      fee: "10000",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount }))
      .addMemo(Memo.text(memo))
      .setTimeout(120)
      .build();
    tx.sign(from);
    const res = await horizon.submitTransaction(tx);
    return res.hash;
  }

  // ── 0. reputation profile ─────────────────────────────────────────────────
  // The lending contract reads the borrower's credit limit and tier from the
  // reputation contract (Issue #335), so the borrower needs a profile first.
  step("Borrower signs init_borrower on the reputation contract");
  const reputationId =
    process.env.NEXT_PUBLIC_REPUTATION_CONTRACT_ID || fail("NEXT_PUBLIC_REPUTATION_CONTRACT_ID is not set");
  await invoke(borrower, "init_borrower", [addr(borrower.publicKey())], reputationId);
  ok("reputation profile created (tier None, 1 000 XLM limit)");

  // ── 1. deposit_collateral + create_loan_request ───────────────────────────
  // Borrowing power is read from the borrower's on-chain vault, so the
  // declared collateral must be deposited first (Issue #415).
  step("Borrower signs deposit_collateral (200 XLM native)");
  const collateralAsset = nativeAssetContractId(PASSPHRASE);
  const collateralAmount = lifecycle.xlmToStroops(200);
  await invoke(borrower, "deposit_collateral", [
    addr(borrower.publicKey()),
    addr(collateralAsset),
    i128(collateralAmount),
  ]);
  ok("200 XLM deposited into the lending vault");

  step("Borrower signs create_loan_request (100 XLM, 30 days, 200 XLM native collateral)");
  const amount = lifecycle.xlmToStroops(100);
  const request = encodeLoanRequestInput({
    borrowerAddress: borrower.publicKey(),
    amountStroops: amount,
    durationDays: 30,
    interestRateBps: 1500,
    maxLoanAmountStroops: lifecycle.xlmToStroops(500),
    collateralEntries: [{ asset: collateralAsset, amount: collateralAmount }],
    rateModel: "Fixed",
    reputationTier: "None",
  });
  const created = await invoke(borrower, "create_loan_request", [addr(borrower.publicKey()), request]);
  const createdCheck = await lifecycle.verifyContractInvocation({
    txHash: created.hash,
    contractId: lendingId,
    method: "create_loan_request",
    expectedInvoker: borrower.publicKey(),
  });
  if (!createdCheck.ok) throw new Error(`verifyContractInvocation(create): ${createdCheck.reason}`);
  const loanId = Number(createdCheck.returnValue);
  const pending = await lifecycle.readOnchainLoan(loanId);
  if (pending.status !== "Pending" || pending.borrower !== borrower.publicKey() || pending.amountStroops !== amount) {
    fail(`unexpected on-chain loan: ${JSON.stringify(pending, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  ok(`loan #${loanId} Pending, verified via RPC (tx ${created.hash.slice(0, 8)}…)`);

  // ── 2. funding payment ────────────────────────────────────────────────────
  step("Lender pays the borrower 100 XLM with the TL-FUND memo");
  const fakeLoanRowId = "11111111-2222-4333-8444-555555555555";
  const fundHash = await pay(lender, borrower.publicKey(), "100.0000000", PAYMENT_MEMO.fund(fakeLoanRowId));
  const fundCheck = await verifyPaymentTransaction({
    txHash: fundHash,
    expectedSource: lender.publicKey(),
    expectedMemo: PAYMENT_MEMO.fund(fakeLoanRowId),
    expectedPayments: [{ destination: borrower.publicKey(), minAmount: 100 }],
  });
  if (!fundCheck.ok) throw new Error(`verifyPaymentTransaction(fund): ${fundCheck.reason}`);
  const wrongMemo = await verifyPaymentTransaction({
    txHash: fundHash,
    expectedSource: lender.publicKey(),
    expectedMemo: PAYMENT_MEMO.fund("99999999-0000-0000-0000-000000000000"),
    expectedPayments: [{ destination: borrower.publicKey(), minAmount: 100 }],
  });
  if (wrongMemo.ok) fail("a payment with another loan's memo was accepted");
  const overClaim = await verifyPaymentTransaction({
    txHash: fundHash,
    expectedSource: lender.publicKey(),
    expectedMemo: PAYMENT_MEMO.fund(fakeLoanRowId),
    expectedPayments: [{ destination: borrower.publicKey(), minAmount: 100.5 }],
  });
  if (overClaim.ok) fail("an over-claimed amount was accepted");
  ok(`payment verified (${fundCheck.totalNative} XLM); wrong memo and over-claim rejected`);

  // ── 3 + 4. approve + activate ─────────────────────────────────────────────
  step("Lender signs approve_loan, server signs activate_loan");
  const { addr: a, u32 } = await import("../lib/stellar/server-contract");
  const approved = await invoke(lender, "approve_loan", [a(lender.publicKey()), u32(loanId), u32(0)]);
  const approveCheck = await lifecycle.verifyContractInvocation({
    txHash: approved.hash,
    contractId: lendingId,
    method: "approve_loan",
    expectedInvoker: lender.publicKey(),
  });
  if (!approveCheck.ok) fail(`verifyContractInvocation(approve): ${approveCheck.reason}`);
  const { hash: activateHash } = await lifecycle.activateLoanOnchain(loanId);
  const active = await lifecycle.readOnchainLoan(loanId);
  if (active.status !== "Active" || active.lender !== lender.publicKey()) fail(`expected Active by lender, got ${active.status}`);
  ok(`loan #${loanId} Active (activate tx ${activateHash.slice(0, 8)}…)`);

  // ── 5 + 6. repay ──────────────────────────────────────────────────────────
  step("Borrower repays 40 XLM then the remainder; server records both");
  const repayHash = await pay(borrower, lender.publicKey(), "40.0000000", PAYMENT_MEMO.repay(fakeLoanRowId));
  const repayCheck = await verifyPaymentTransaction({
    txHash: repayHash,
    expectedSource: borrower.publicKey(),
    expectedMemo: PAYMENT_MEMO.repay(fakeLoanRowId),
    expectedPayments: [{ destination: lender.publicKey(), minAmount: 0 }],
  });
  if (!repayCheck.ok || repayCheck.totalNative < 40) fail(`verifyPaymentTransaction(repay): ${JSON.stringify(repayCheck)}`);
  const first = await lifecycle.recordPaymentOnchain(loanId, lifecycle.xlmToStroops(40));
  if (first.status !== "Active") fail(`after partial repayment expected Active, got ${first.status}`);
  const remaining = (await lifecycle.readOnchainLoan(loanId)).remainingDueStroops;
  const second = await lifecycle.recordPaymentOnchain(loanId, remaining);
  if (second.status !== "Repaid") fail(`after full repayment expected Repaid, got ${second.status}`);
  ok(`loan #${loanId} Repaid (remaining was ${lifecycle.stroopsToXlm(remaining)} XLM)`);

  // ── 7. pools ──────────────────────────────────────────────────────────────
  if (lifecycle.pooledLendingContractId()) {
    step("Registering pool 1 and mirroring its state on the PooledLendingContract");
    await lifecycle.setPoolConfigOnchain(1, {
      baseRateBps: 200,
      multiplierPerSlopeBps: 1000,
      jumpMultiplierBps: 10000,
      kinkBps: 8000,
      reserveFactorBps: 1000,
    });
    const synced = await lifecycle.syncPoolStateOnchain({
      onchainPoolId: 1,
      totalSupplyStroops: lifecycle.xlmToStroops(1000),
      totalBorrowsStroops: lifecycle.xlmToStroops(250),
    });
    ok(`pool 1 configured and synced (tx ${synced?.hash.slice(0, 8)}…)`);
  }

  console.log(`\nAll lifecycle checks passed against ${lendingId} (admin ${admin.publicKey()}).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
