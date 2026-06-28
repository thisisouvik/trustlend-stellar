#!/usr/bin/env node
// =============================================================================
// TrustLend — Decentralized Credit Score Oracle (off-chain poster)
// =============================================================================
// An AUTHORIZED Node service that:
//   1. Takes verified Web2 / off-chain signals for a borrower (utility-bill
//      history, mobile-money / telecom payments, banking history, …).
//   2. Normalises them into a single credit score (0..1000) using a transparent
//      weighted model.
//   3. Posts the score on-chain by invoking `submit_credit_score` on the
//      BorrowerReputationContract, signed with the oracle's secret key.
//
// The contract verifies that the caller is the registered oracle (set via
// `set_oracle`) before accepting the data, then boosts the borrower's max loan.
//
// ── Trust model ──────────────────────────────────────────────────────────────
// This script holds ORACLE_SECRET_KEY — it IS the trusted oracle. Run it in a
// trusted backend / cron job only. Never expose the secret to the browser.
// The Web2 data verification (OAuth into the provider, signature checks, etc.)
// is expected to happen BEFORE this script is called; here we only show a
// pluggable `computeCreditScore` aggregation step.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node scripts/oracle-post-credit-score.mjs \
//     --borrower GB... \
//     --utility 0.92 --telecom 0.80 --banking 0.75 \
//     --provider mobile-money
//
//   # or feed a verified-data JSON file:
//   node scripts/oracle-post-credit-score.mjs --borrower GB... --data ./verified.json
//
//   # simulate only (no signing / no submit), prints projected max loan:
//   node scripts/oracle-post-credit-score.mjs --borrower GB... --utility 0.9 --dry-run
//
// ── Required env (.env.local or process env) ─────────────────────────────────
//   ORACLE_SECRET_KEY                     S... secret key of the authorized oracle
//   NEXT_PUBLIC_REPUTATION_CONTRACT_ID    C... reputation contract id
//   NEXT_PUBLIC_SOROBAN_RPC_URL           (default: https://soroban-testnet.stellar.org)
//   NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE(default: Test SDF Network ; September 2015)
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  Keypair,
  Contract,
  Address,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";

// ─── Minimal .env loader (mirrors scripts/e2e-seed-and-run.mjs) ───────────────

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.resolve(process.cwd(), ".env.local"));
loadEnv(path.resolve(process.cwd(), ".env.contracts"));

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true; // boolean flag
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// ─── Credit-score model ───────────────────────────────────────────────────────
// Transparent, weighted aggregation of normalised (0..1) Web2 signals.
// Adjust weights to taste; they must sum to 1. The contract independently
// derives the loan boost from the resulting score, so this stays auditable.

const SIGNAL_WEIGHTS = {
  utility: 0.35, // utility-bill payment punctuality
  telecom: 0.25, // mobile-money / telecom top-up & bill history
  banking: 0.3, // bank-statement / cash-flow health
  rental: 0.1, // rent payment history
};

const MAX_SCORE = 1000;

function computeCreditScore(signals) {
  let weighted = 0;
  let usedWeight = 0;
  let sources = 0;

  for (const [name, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    const raw = signals[name];
    if (raw === undefined || raw === null) continue;
    const v = Number(raw);
    if (Number.isNaN(v) || v < 0 || v > 1) {
      throw new Error(`Signal "${name}" must be a number in [0, 1], got: ${raw}`);
    }
    weighted += v * weight;
    usedWeight += weight;
    sources += 1;
  }

  if (sources === 0) {
    throw new Error(
      "No valid Web2 signals provided. Pass at least one of: " +
        Object.keys(SIGNAL_WEIGHTS).map((s) => `--${s} <0..1>`).join(", ")
    );
  }

  // Re-normalise by the weight actually used so partial data isn't penalised.
  const normalised = weighted / usedWeight;
  const score = Math.round(normalised * MAX_SCORE);
  return { score: Math.max(0, Math.min(MAX_SCORE, score)), dataSources: sources };
}

function collectSignals(args) {
  if (args.data) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args.data), "utf8"));
    return raw.signals ?? raw;
  }
  const signals = {};
  for (const name of Object.keys(SIGNAL_WEIGHTS)) {
    if (args[name] !== undefined) signals[name] = args[name];
  }
  return signals;
}

// ─── On-chain invocation ──────────────────────────────────────────────────────

async function pollTransaction(server, hash) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") return res;
    if (res.status === "FAILED") {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(res)}`);
    }
    // NOT_FOUND → keep polling
  }
  throw new Error(`Transaction ${hash} timed out after 30s`);
}

async function invoke({ server, networkPassphrase, oracle, contractId, method, args, submit }) {
  const account = await server.getAccount(oracle.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  // Simulate (also yields the read-only return value for view calls).
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  if (!submit) {
    return sim.result?.retval ? scValToNative(sim.result.retval) : null;
  }

  // Assemble (attaches Soroban data + auth + resource fee), sign, send.
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(oracle);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Submission error: ${JSON.stringify(sent.errorResult)}`);
  }
  const final = await pollTransaction(server, sent.hash);
  return { hash: sent.hash, returnValue: final.returnValue ?? null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 42).join("\n"));
    return;
  }

  const borrower = args.borrower;
  if (!borrower) throw new Error("Missing required --borrower <G... address>");

  const provider = typeof args.provider === "string" ? args.provider : "trustlend-oracle";
  const dryRun = Boolean(args["dry-run"]);

  const contractId = process.env.NEXT_PUBLIC_REPUTATION_CONTRACT_ID;
  if (!contractId) throw new Error("Missing env NEXT_PUBLIC_REPUTATION_CONTRACT_ID");

  const rpcUrl =
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const networkPassphrase =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
    "Test SDF Network ; September 2015";

  const secret = process.env.ORACLE_SECRET_KEY;
  if (!secret && !dryRun) {
    throw new Error("Missing env ORACLE_SECRET_KEY (required to sign the on-chain post)");
  }

  // 1. Aggregate verified Web2 signals → credit score.
  const signals = collectSignals(args);
  const { score, dataSources } = computeCreditScore(signals);

  console.log("─────────────────────────────────────────────");
  console.log("  TrustLend Credit Oracle");
  console.log("─────────────────────────────────────────────");
  console.log(`  Borrower     : ${borrower}`);
  console.log(`  Signals      : ${JSON.stringify(signals)}`);
  console.log(`  Data sources : ${dataSources}`);
  console.log(`  Credit score : ${score} / ${MAX_SCORE}`);
  console.log(`  Provider     : ${provider}`);
  console.log(`  Contract     : ${contractId}`);
  console.log(`  Network      : ${rpcUrl}`);
  console.log("");

  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

  // For dry-run with no secret, use a throwaway keypair just to simulate
  // (simulation does not require the real signer to exist on-chain for views,
  //  but submit_credit_score auths the oracle, so dry-run uses the read path).
  const oracle = secret ? Keypair.fromSecret(secret) : Keypair.random();

  const callArgs = [
    new Address(secret ? oracle.publicKey() : (process.env.NEXT_PUBLIC_ORACLE_ADDRESS ?? oracle.publicKey())).toScVal(), // oracle
    new Address(borrower).toScVal(),                       // borrower
    nativeToScVal(score, { type: "u32" }),                 // credit_score
    nativeToScVal(dataSources, { type: "u32" }),           // data_sources
    nativeToScVal(provider, { type: "string" }),           // provider
  ];

  if (dryRun) {
    console.log("▶ DRY RUN — simulating submit_credit_score (not submitted)…");
    await invoke({
      server, networkPassphrase, oracle, contractId,
      method: "submit_credit_score", args: callArgs, submit: false,
    });
    // Project the resulting max loan via a read call.
    const projected = await invoke({
      server, networkPassphrase, oracle, contractId,
      method: "calculate_max_loan",
      args: [new Address(borrower).toScVal()],
      submit: false,
    });
    console.log(`  ✔ Simulation OK. (current) max loan = ${projected} stroops`);
    console.log("    Re-run without --dry-run to post on-chain.");
    return;
  }

  // 2. Post on-chain.
  console.log("▶ Submitting credit score on-chain…");
  const result = await invoke({
    server, networkPassphrase, oracle, contractId,
    method: "submit_credit_score", args: callArgs, submit: true,
  });
  console.log(`  ✔ Posted. tx hash = ${result.hash}`);

  // 3. Read back the updated max loan.
  const maxLoan = await invoke({
    server, networkPassphrase, oracle, contractId,
    method: "calculate_max_loan",
    args: [new Address(borrower).toScVal()],
    submit: false,
  });
  console.log(`  ✔ New max loan for borrower = ${maxLoan} stroops`);
  console.log("─────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("✖ Oracle post failed:", err.message);
  process.exit(1);
});
