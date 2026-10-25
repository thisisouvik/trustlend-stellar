#!/usr/bin/env tsx
/**
 * TrustLend — one-command Soroban deployment CLI (Issue #270).
 *
 *   npm run deploy:testnet
 *
 * Builds every Soroban contract, deploys them to the Stellar Testnet,
 * initializes and wires them together, then writes the resulting contract IDs
 * straight into `.env.local` — no copy-paste step.
 *
 * This supersedes contracts/scripts/deploy.sh and deploy.ps1 (two scripts that
 * had to be kept in sync by hand) with one cross-platform entry point that also
 * handles the prerequisites those scripts told you to do yourself: creating the
 * admin key and funding it from friendbot.
 *
 * Run `npm run deploy:testnet -- --help` for the full flag list.
 */

import { spawnSync } from "node:child_process";
import { Asset } from "@stellar/stellar-sdk";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_KEYS,
  selectContracts,
  type ContractSpec,
} from "../lib/deployment/contracts-manifest";
import {
  formatEnvFile,
  parseEnvFile,
  upsertEnvVars,
} from "../lib/deployment/env-file";

// ─── Paths ────────────────────────────────────────────────────────────────────

// Resolved from this file rather than process.cwd(), so the CLI works when run
// from a subdirectory as well as through `npm run`.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const WASM_DIR = path.join(CONTRACTS_DIR, "target", "wasm32v1-none", "release");
const BINDINGS_DIR = path.join(REPO_ROOT, "lib", "contracts", "generated");
const STATE_DIR = path.join(CONTRACTS_DIR, ".deployments");

// ─── Console helpers ──────────────────────────────────────────────────────────

const RULE = "═".repeat(64);

const log = {
  step: (msg: string) => console.log(`\n▶ ${msg}`),
  ok: (msg: string) => console.log(`  ✔ ${msg}`),
  info: (msg: string) => console.log(`  ℹ ${msg}`),
  warn: (msg: string) => console.warn(`  ⚠ ${msg}`),
  fail: (msg: string) => console.error(`  ✖ ${msg}`),
};

function die(message: string, hint?: string): never {
  console.error(`\n✖ ${message}`);
  if (hint) console.error(`\n  ${hint}`);
  process.exit(1);
}

// ─── CLI options ──────────────────────────────────────────────────────────────

type Options = {
  network: string;
  adminKey: string;
  envFile: string;
  only?: string;
  skipBuild: boolean;
  skipBindings: boolean;
  skipInit: boolean;
  dryRun: boolean;
  resume: boolean;
};

const HELP = `
TrustLend — Soroban testnet deployment CLI

Usage:
  npm run deploy:testnet                    Deploy everything, write .env.local
  npm run deploy:testnet -- [options]

Options:
  --network <name>      Stellar network (default: testnet)
  --admin-key <name>    Stellar CLI identity to deploy with (default: trustlend-admin)
                        Created and funded automatically if it does not exist.
  --out-env <path>      Env file to update in place (default: .env.local)
                        (--env-file also works, but only as --env-file=<path>)
  --only <a,b,c>        Deploy only these contracts. Available:
                        ${CONTRACT_KEYS.join(", ")}
  --skip-build          Reuse the WASM already in contracts/target
  --skip-init           Deploy without running initialize/wiring
  --skip-bindings       Do not regenerate TypeScript bindings
  --resume              Reuse contract IDs from a previous run of this network
                        instead of redeploying them
  --dry-run             Print every command without executing it
  -h, --help            Show this help

Prerequisites (checked automatically):
  * Rust with the wasm32 target
  * Stellar CLI >= 22   cargo install --locked stellar-cli --features opt

Environment overrides:
  MULTISIG_SIGNERS            Comma-separated G... signers (default: admin only)
  MULTISIG_THRESHOLD          Approvals needed (default: 1)
  ORACLE_ADDRESS              Authorize a credit-score oracle during deploy
  TLEND_TOTAL_SUPPLY          Raw units minted to admin (default: 1000000000000)
  TLEND_AIRDROP_MERKLE_ROOT   64-char hex root; airdrop init is skipped without it
  USDC_TOKEN_ADDRESS          USDC SAC / token contract for the USDC pool (init skipped without it)
  INSURANCE_FUND_ADDRESS      Treasury insurance destination (default: default-management contract)
  DAO_TREASURY_ADDRESS        Treasury DAO destination (default: admin address)

After deploying, the app needs:
  NEXT_PUBLIC_ONCHAIN_LOAN_LIFECYCLE=required   (default when a lending id is set)
  ADMIN_SECRET_KEY=<secret of the admin identity>  so the server can sign
  activate_loan / record_payment / update_pool_state. Print it with:
    stellar keys show trustlend-admin
`;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    network: "testnet",
    adminKey: "trustlend-admin",
    envFile: ".env.local",
    skipBuild: false,
    skipBindings: false,
    skipInit: false,
    dryRun: false,
    resume: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) die(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--network":
        options.network = next();
        break;
      case "--admin-key":
        options.adminKey = next();
        break;
      case "--env-file":
      // Node itself consumes a bare "--env-file <path>" when the script runs
      // under tsx, so "--out-env" is the form that always reaches us.
      case "--out-env":
        options.envFile = next();
        break;
      case "--only":
        options.only = next();
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--skip-init":
        options.skipInit = true;
        break;
      case "--skip-bindings":
        options.skipBindings = true;
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        // Support --flag=value as well as --flag value.
        if (arg.startsWith("--") && arg.includes("=")) {
          const idx = arg.indexOf("=");
          argv.splice(i, 1, arg.slice(0, idx), arg.slice(idx + 1));
          i--;
          continue;
        }
        die(`Unknown option: ${arg}`, "Run with --help to see available options.");
    }
  }

  return options;
}

// ─── Command execution ────────────────────────────────────────────────────────

let DRY_RUN = false;

function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

/**
 * Run a command, streaming its output. Returns trimmed stdout when `capture`.
 *
 * `spawnSync` without a shell means arguments (contract ids, JSON action
 * payloads, signer lists) are passed through verbatim — no quoting or
 * injection concerns from values that came out of the CLI or the environment.
 */
function run(
  command: string,
  args: string[],
  { capture = false, cwd = REPO_ROOT, allowFailure = false } = {}
): string {
  if (DRY_RUN) {
    console.log(`  $ ${formatCommand(command, args)}`);
    return capture ? `<dry-run:${command}>` : "";
  }

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });

  if (result.error) {
    if (allowFailure) return "";
    die(
      `Failed to run \`${formatCommand(command, args)}\`: ${result.error.message}`,
      command === "stellar"
        ? "Install the Stellar CLI: cargo install --locked stellar-cli --features opt"
        : undefined
    );
  }

  if (result.status !== 0) {
    if (allowFailure) return "";
    die(`Command failed (exit ${result.status}): ${formatCommand(command, args)}`);
  }

  return capture ? String(result.stdout ?? "").trim() : "";
}

function commandExists(command: string): boolean {
  const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

// ─── Preflight ────────────────────────────────────────────────────────────────

function checkStellarCli(): void {
  if (DRY_RUN) {
    log.info("Dry run — skipping Stellar CLI check");
    return;
  }

  if (!commandExists("stellar")) {
    die(
      "The Stellar CLI is not installed (or not on PATH).",
      "Install it with:\n    cargo install --locked stellar-cli --features opt"
    );
  }

  const version = run("stellar", ["--version"], { capture: true });
  const major = Number(/(\d+)\./.exec(version)?.[1] ?? 0);

  if (major > 0 && major < 22) {
    die(
      `Stellar CLI v${major} is too old — v22 or newer is required.`,
      "Upgrade with: cargo install --locked stellar-cli --features opt"
    );
  }

  log.ok(`Stellar CLI detected (${version.split("\n")[0]})`);
}

/**
 * Return the admin address, creating and funding the identity when missing.
 *
 * deploy.sh required the developer to do this by hand before running it, which
 * is most of what stopped it being a single command.
 */
function ensureAdminIdentity(options: Options): string {
  const existing = run("stellar", ["keys", "address", options.adminKey], {
    capture: true,
    allowFailure: true,
  });

  if (existing && existing.startsWith("G")) {
    log.ok(`Using existing identity "${options.adminKey}" (${existing})`);
    return existing;
  }

  log.info(`Identity "${options.adminKey}" not found — generating it`);
  run("stellar", [
    "keys",
    "generate",
    options.adminKey,
    "--global",
    "--network",
    options.network,
  ]);

  const address = run("stellar", ["keys", "address", options.adminKey], {
    capture: true,
  });

  if (!DRY_RUN && !address.startsWith("G")) {
    die(`Could not resolve an address for identity "${options.adminKey}".`);
  }

  log.ok(`Generated identity "${options.adminKey}" (${address})`);
  return address;
}

/** Fund the admin account from friendbot if the network has not seen it yet. */
async function ensureFunded(address: string, network: string): Promise<void> {
  if (DRY_RUN) {
    log.info(`Dry run — would ensure ${address} is funded`);
    return;
  }

  if (network !== "testnet" && network !== "futurenet") {
    log.info(`Network "${network}" has no friendbot — assuming ${address} is funded`);
    return;
  }

  const horizon =
    process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

  try {
    const res = await fetch(`${horizon}/accounts/${address}`);

    if (res.ok) {
      log.ok("Admin account is funded");
      return;
    }

    if (res.status !== 404) {
      log.warn(`Horizon returned ${res.status} checking the admin account — continuing`);
      return;
    }
  } catch (error) {
    log.warn(
      `Could not reach Horizon to check funding (${(error as Error).message}) — continuing`
    );
    return;
  }

  const friendbot =
    process.env.NEXT_PUBLIC_STELLAR_FRIENDBOT_URL ?? "https://friendbot.stellar.org";

  log.info("Admin account not funded — requesting XLM from friendbot");
  const funded = await fetch(`${friendbot}?addr=${encodeURIComponent(address)}`);

  if (!funded.ok) {
    die(
      `Friendbot could not fund ${address} (HTTP ${funded.status}).`,
      `Fund it manually: curl "${friendbot}?addr=${address}"`
    );
  }

  log.ok("Admin account funded via friendbot");
}

// ─── Deployment state (for --resume) ──────────────────────────────────────────

type DeploymentState = {
  network: string;
  adminAddress: string;
  deployedAt: string;
  contracts: Record<string, string>;
};

function stateFile(network: string): string {
  return path.join(STATE_DIR, `${network}.json`);
}

function readState(network: string): DeploymentState | null {
  const file = stateFile(network);
  if (!fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentState;
  } catch {
    log.warn(`Ignoring unreadable deployment state at ${path.relative(REPO_ROOT, file)}`);
    return null;
  }
}

function writeState(state: DeploymentState): void {
  if (DRY_RUN) return;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile(state.network), JSON.stringify(state, null, 2) + "\n");
}

// ─── Build / deploy / initialize ──────────────────────────────────────────────

function buildContracts(): void {
  log.step("Building Soroban contracts…");
  run("stellar", ["contract", "build"], { cwd: CONTRACTS_DIR });
  log.ok("Build complete");
}

function deployContract(spec: ContractSpec, options: Options): string {
  const wasmPath = path.join(WASM_DIR, spec.wasm);

  if (!DRY_RUN && !fs.existsSync(wasmPath)) {
    die(
      `WASM not found for ${spec.label}: ${path.relative(REPO_ROOT, wasmPath)}`,
      options.skipBuild
        ? "You passed --skip-build; drop that flag to compile the contracts first."
        : "The build step ran but produced no artifact — check the build output above."
    );
  }

  const id = run(
    "stellar",
    [
      "contract",
      "deploy",
      "--wasm",
      wasmPath,
      "--network",
      options.network,
      "--source",
      options.adminKey,
    ],
    { capture: true, cwd: CONTRACTS_DIR }
  );

  // The CLI can emit progress lines before the id; the id is the last line.
  const contractId = id.split(/\r?\n/).filter(Boolean).pop() ?? "";

  if (!DRY_RUN && !/^C[A-Z0-9]{55}$/.test(contractId)) {
    die(`Unexpected contract id returned for ${spec.label}: ${contractId || "<empty>"}`);
  }

  return contractId;
}

/** `stellar contract invoke --id <id> ... -- <fn> [args]` */
function invoke(
  contractId: string,
  fn: string,
  args: string[],
  options: Options,
  { capture = false } = {}
): string {
  return run(
    "stellar",
    [
      "contract",
      "invoke",
      "--id",
      contractId,
      "--source",
      options.adminKey,
      "--network",
      options.network,
      "--",
      fn,
      ...args,
    ],
    { capture, cwd: CONTRACTS_DIR }
  );
}

function initializeContracts(
  ids: Record<string, string>,
  adminAddress: string,
  options: Options
): void {
  const has = (key: string) => Boolean(ids[key]);

  log.step("Initializing contracts…");

  if (has("reputation")) {
    invoke(ids.reputation, "initialize", ["--admin", adminAddress], options);
    log.ok("BorrowerReputationContract initialized");
  }

  if (has("escrow")) {
    invoke(ids.escrow, "initialize", ["--admin", adminAddress], options);
    log.ok("EscrowContract initialized");
  }

  if (has("lending")) {
    invoke(ids.lending, "initialize", ["--admin", adminAddress], options);
    log.ok("LendingContract initialized");

    // Loan requests read each borrower's tier and credit limit from the
    // reputation contract (Issue #335) and are rejected until it is linked.
    if (has("reputation")) {
      invoke(
        ids.lending,
        "set_reputation_contract",
        ["--admin", adminAddress, "--reputation", ids.reputation],
        options
      );
      log.ok("LendingContract linked to BorrowerReputationContract");
    } else {
      log.warn("No reputation contract id — loan requests will be rejected until set_reputation_contract is called");
    }
  }

  if (has("default_management")) {
    invoke(
      ids.default_management,
      "initialize",
      ["--admin", adminAddress, "--initial_insurance_balance", "0"],
      options
    );
    log.ok("DefaultManagementContract initialized (insurance balance 0)");
  }

  if (has("pooled_lending")) {
    // Pool 0 with the interest-rate curve the app's defaults assume:
    // 2% base, 10% slope to an 80% kink, 100% jump above it, 10% reserve factor.
    const poolConfig = JSON.stringify({
      base_rate_bps: 200,
      multiplier_per_slope_bps: 1000,
      jump_multiplier_bps: 10000,
      kink_bps: 8000,
      reserve_factor_bps: 1000,
    });

    invoke(
      ids.pooled_lending,
      "initialize",
      ["--admin", adminAddress, "--pool_id", "0", "--config", poolConfig],
      options
    );
    log.ok("PooledLendingContract initialized (pool 0)");
  }

  if (has("governance")) {
    if (!has("lending") || !has("reputation")) {
      die(
        "GovernanceContract needs the lending and reputation contracts.",
        "Deploy them in the same run, or re-run with --resume so their ids are reused."
      );
    }

    // 3-day voting window, quorum 500, min proposer power 150 (Silver tier),
    // fee cap 1000 bps (10%). Voting power = reputation score.
    invoke(
      ids.governance,
      "initialize",
      [
        "--admin", adminAddress,
        "--lending", ids.lending,
        "--reputation", ids.reputation,
        "--voting_period_secs", "259200",
        "--quorum_votes", "500",
        "--min_proposer_power", "150",
        "--max_fee_bps", "1000",
      ],
      options
    );
    log.ok("GovernanceContract initialized");
  }

  if (has("multisig_admin")) {
    initializeMultisig(ids, adminAddress, options);
  }

  if (has("tlend_token")) {
    initializeTlend(ids, adminAddress, options);
  }

  initializeSatellites(ids, adminAddress, options);
}

/** Native XLM's Stellar Asset Contract id on the target network. */
function nativeAssetContractId(network: string): string {
  const passphrase =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
    (network === "futurenet"
      ? "Test SDF Future Network ; October 2022"
      : network === "mainnet" || network === "public"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015");
  return Asset.native().contractId(passphrase);
}

/**
 * Contracts the lending contract calls into, plus the standalone protocol
 * modules. Everything here is optional — a missing id is skipped — but when
 * present the contracts are initialised and linked so the app can use them
 * without any manual invoke calls (Phase 2.2).
 */
function initializeSatellites(
  ids: Record<string, string>,
  adminAddress: string,
  options: Options
): void {
  const has = (key: string) => Boolean(ids[key]);
  const xlm = nativeAssetContractId(options.network);
  const rewardToken = ids.tlend_token || xlm;

  if (has("lending") && has("multisig_admin")) {
    // Loan requests need at least one whitelisted collateral asset; native
    // XLM is the default the borrower form uses. whitelist_asset is
    // multisig-gated, so it goes through propose + execute.
    proposeAndExecute(
      ids.multisig_admin,
      adminAddress,
      JSON.stringify({ WhitelistAsset: [ids.lending, xlm] }),
      options,
      "WhitelistAsset (native XLM)"
    );
  }

  if (has("referral_rewards") && has("lending")) {
    // 10 XLM bonus at a 100 XLM reference loan, capped at 3x, min 10 XLM loans.
    const config = JSON.stringify({
      base_bonus: "100000000",
      reference_loan_amount: "1000000000",
      max_size_multiplier_bps: 30000,
      min_qualifying_loan: "100000000",
      max_referrals_per_referrer: 0,
    });
    invoke(
      ids.referral_rewards,
      "initialize",
      [
        "--admin", adminAddress,
        "--reward_token", rewardToken,
        "--lending_contract", ids.lending,
        "--config", config,
      ],
      options
    );
    invoke(
      ids.lending,
      "set_referral_contract",
      ["--admin", adminAddress, "--referral", ids.referral_rewards],
      options
    );
    log.ok("ReferralRewardsContract initialized and linked to Lending");
    log.info("Fund it with reward tokens before the first referral pays out");
  }

  if (has("borrower_loyalty") && has("lending")) {
    // 5 XLM base reward at a 100 XLM reference loan; tier multipliers 1x-2x.
    const config = JSON.stringify({
      base_amount: "50000000",
      reference_loan_amount: "1000000000",
      max_duration_multiplier_bps: 20000,
      tier_none_multiplier_bps: 10000,
      tier_beginner_multiplier_bps: 11000,
      tier_silver_multiplier_bps: 12500,
      tier_gold_multiplier_bps: 15000,
      tier_platinum_multiplier_bps: 20000,
    });
    invoke(
      ids.borrower_loyalty,
      "initialize",
      [
        "--admin", adminAddress,
        "--reward_token", rewardToken,
        "--lending_contract", ids.lending,
        "--config", config,
      ],
      options
    );
    invoke(
      ids.lending,
      "set_loyalty_contract",
      ["--admin", adminAddress, "--loyalty", ids.borrower_loyalty],
      options
    );
    log.ok("BorrowerLoyaltyContract initialized and linked to Lending");
  }

  if (has("treasury")) {
    const insuranceFund = process.env.INSURANCE_FUND_ADDRESS ?? ids.default_management ?? adminAddress;
    const daoTreasury = process.env.DAO_TREASURY_ADDRESS ?? adminAddress;
    invoke(
      ids.treasury,
      "initialize",
      [
        "--admin", adminAddress,
        "--insurance_fund", insuranceFund,
        "--dao_treasury", daoTreasury,
        "--insurance_share_bps", "5000",
        "--dao_share_bps", "5000",
      ],
      options
    );
    log.ok("TreasuryContract initialized (50/50 insurance / DAO split)");

    if (has("lending")) {
      // Platform fees are paid in XLM and can only be collected into this
      // treasury, which only accepts them from this lending contract.
      invoke(ids.lending, "set_treasury", ["--admin", adminAddress, "--treasury", ids.treasury], options);
      invoke(ids.lending, "set_fee_token", ["--admin", adminAddress, "--fee_token", xlm], options);
      invoke(
        ids.treasury,
        "set_lending_contract",
        ["--caller", adminAddress, "--lending_contract", ids.lending],
        options
      );
      log.ok("Lending ↔ Treasury linked for protocol fee collection (XLM)");
    }
  }

  if (has("auto_compound_vault") && has("lending")) {
    invoke(
      ids.auto_compound_vault,
      "initialize",
      [
        "--admin", adminAddress,
        "--asset_token", xlm,
        "--lending_contract", ids.lending,
        "--harvest_fee_bps", "100",
      ],
      options
    );
    log.ok("AutoCompoundVaultContract initialized (1% harvest fee)");
  }

  if (has("liquidation_auction")) {
    invoke(
      ids.liquidation_auction,
      "initialize",
      [
        "--admin", adminAddress,
        "--payment_token", xlm,
        "--collateral_token", xlm,
        "--treasury", has("treasury") ? ids.treasury : adminAddress,
      ],
      options
    );
    log.ok("LiquidationAuctionContract initialized");
  }

  if (has("zk_credit_verifier")) {
    invoke(ids.zk_credit_verifier, "initialize", ["--admin", adminAddress], options);
    log.ok("ZkCreditVerifierContract initialized");
  }

  if (has("usdc_lending_pool")) {
    const usdc = process.env.USDC_TOKEN_ADDRESS;
    if (usdc) {
      invoke(
        ids.usdc_lending_pool,
        "initialize",
        ["--admin", adminAddress, "--usdc_token", usdc, "--annual_yield_bps", "800"],
        options
      );
      log.ok("UsdcLendingPoolContract initialized (up to 8% APY)");
      log.info("Depositors earn yield only once USDC is paid in via fund_yield");
    } else {
      log.info("Skipping USDC pool initialization — set USDC_TOKEN_ADDRESS to enable it");
    }
  }
}

function initializeMultisig(
  ids: Record<string, string>,
  adminAddress: string,
  options: Options
): void {
  const signers = (process.env.MULTISIG_SIGNERS ?? adminAddress)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const threshold = process.env.MULTISIG_THRESHOLD ?? "1";

  if (Number(threshold) < 1 || Number(threshold) > signers.length) {
    die(
      `MULTISIG_THRESHOLD=${threshold} is invalid for ${signers.length} signer(s).`,
      "It must be between 1 and the number of entries in MULTISIG_SIGNERS."
    );
  }

  invoke(
    ids.multisig_admin,
    "initialize",
    ["--signers", JSON.stringify(signers), "--threshold", threshold],
    options
  );
  log.ok(`MultiSigAdminContract initialized (${threshold}-of-${signers.length})`);

  // Hand the gated admin operations over to the multisig.
  for (const key of ["lending", "default_management", "reputation"]) {
    if (!ids[key]) continue;

    invoke(
      ids[key],
      "set_multisig_admin",
      ["--admin", adminAddress, "--multisig", ids.multisig_admin],
      options
    );
  }

  log.ok("Linked MultiSigAdmin → Lending, Default Management, Reputation");
  log.info(
    "whitelist_asset / set_flash_loan_fee_bps / set_governance / set_oracle / " +
      "add_to_insurance / trigger_insurance_payout are now multisig-gated"
  );

  // set_governance is itself multisig-gated, so linking governance has to go
  // through propose + execute. At the default 1-of-1 threshold a proposal is
  // immediately executable.
  if (ids.governance && ids.lending) {
    proposeAndExecute(
      ids.multisig_admin,
      adminAddress,
      JSON.stringify({ SetGovernance: [ids.lending, ids.governance] }),
      options,
      "SetGovernance (Lending ← Governance)"
    );

    if (Number(threshold) > 1) {
      log.warn(
        `Threshold is ${threshold}: the proposal above needs ${Number(threshold) - 1} ` +
          "more approve() call(s) before execute() succeeds."
      );
    }
  }

  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (oracleAddress && ids.reputation) {
    proposeAndExecute(
      ids.multisig_admin,
      adminAddress,
      JSON.stringify({ SetOracle: [ids.reputation, oracleAddress] }),
      options,
      `SetOracle (${oracleAddress})`
    );
  } else if (ids.reputation) {
    log.info("Skipping oracle registration — set ORACLE_ADDRESS to enable it");
  }
}

function proposeAndExecute(
  multisigId: string,
  adminAddress: string,
  action: string,
  options: Options,
  label: string
): void {
  const proposalId = invoke(
    multisigId,
    "propose",
    ["--proposer", adminAddress, "--action", action],
    options,
    { capture: true }
  );

  const id = proposalId.split(/\r?\n/).filter(Boolean).pop() ?? "";

  if (!DRY_RUN && !id) {
    log.warn(`Could not read a proposal id for ${label} — execute it manually`);
    return;
  }

  invoke(multisigId, "execute", ["--proposal_id", id], options);
  log.ok(`${label} proposed and executed via multisig`);
}

function initializeTlend(
  ids: Record<string, string>,
  adminAddress: string,
  options: Options
): void {
  const totalSupply = process.env.TLEND_TOTAL_SUPPLY ?? "1000000000000";

  invoke(
    ids.tlend_token,
    "initialize",
    [
      "--admin", adminAddress,
      "--decimals", "7",
      "--name", "TrustLend",
      "--symbol", "TLEND",
    ],
    options
  );
  invoke(
    ids.tlend_token,
    "mint",
    ["--to", adminAddress, "--amount", totalSupply],
    options
  );
  log.ok(`TlendTokenContract initialized (minted ${totalSupply} raw units)`);

  if (ids.tlend_vesting) {
    invoke(
      ids.tlend_vesting,
      "initialize",
      ["--admin", adminAddress, "--token", ids.tlend_token],
      options
    );
    log.ok("TlendVestingContract initialized");
    log.info("Create schedules later with create_vesting_schedule");
  }

  if (ids.tlend_airdrop) {
    const merkleRoot = process.env.TLEND_AIRDROP_MERKLE_ROOT;

    if (merkleRoot) {
      invoke(
        ids.tlend_airdrop,
        "initialize",
        [
          "--admin", adminAddress,
          "--token", ids.tlend_token,
          "--merkle_root", merkleRoot,
        ],
        options
      );
      log.ok("TlendAirdropContract initialized — fund the pool before claims open");
    } else {
      log.info(
        "Skipping airdrop initialization — set TLEND_AIRDROP_MERKLE_ROOT to enable it"
      );
    }
  }
}

function generateBindings(
  selected: ContractSpec[],
  ids: Record<string, string>,
  options: Options
): void {
  log.step("Generating TypeScript bindings…");

  if (!DRY_RUN) fs.mkdirSync(BINDINGS_DIR, { recursive: true });

  for (const spec of selected) {
    const id = ids[spec.key];
    if (!id) continue;

    run(
      "stellar",
      [
        "contract",
        "bindings",
        "typescript",
        "--network",
        options.network,
        "--id",
        id,
        "--output-dir",
        path.join(BINDINGS_DIR, spec.key),
      ],
      { cwd: CONTRACTS_DIR, allowFailure: true }
    );
  }

  log.ok(`Bindings written to ${path.relative(REPO_ROOT, BINDINGS_DIR)}/`);
}

// ─── Env output ───────────────────────────────────────────────────────────────

/**
 * Write the contract IDs into the developer's env file, in place.
 *
 * This is the half the old script left to the developer: it wrote
 * `.env.contracts` and printed "now cat this into .env.local".
 */
function writeEnvFiles(
  envVars: Record<string, string>,
  options: Options
): { envFilePath: string; created: boolean } {
  const envFilePath = path.isAbsolute(options.envFile)
    ? options.envFile
    : path.join(REPO_ROOT, options.envFile);

  const existed = fs.existsSync(envFilePath);
  const current = existed ? fs.readFileSync(envFilePath, "utf8") : "";

  const header =
    `# ── Soroban Contract IDs (${options.network}, written by ` +
    `npm run deploy:testnet on ${new Date().toISOString()}) ──`;

  const merged = upsertEnvVars(current, envVars, { sectionHeader: header });

  // Reference copy, matching what deploy.sh used to emit.
  const contractsFile = path.join(REPO_ROOT, ".env.contracts");

  if (DRY_RUN) {
    console.log(`\n  Would write ${path.relative(REPO_ROOT, envFilePath)}:`);
    for (const [key, value] of Object.entries(envVars)) {
      console.log(`    ${key}=${value}`);
    }
    return { envFilePath, created: !existed };
  }

  // Back up before rewriting a file that already had content, so a bad merge
  // can never cost someone their database credentials.
  if (existed && current.trim() !== "") {
    fs.writeFileSync(`${envFilePath}.bak`, current);
  }

  fs.writeFileSync(envFilePath, merged);
  fs.writeFileSync(contractsFile, formatEnvFile(envVars, header));

  return { envFilePath, created: !existed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  DRY_RUN = options.dryRun;

  const { selected, unknown } = selectContracts(options.only);

  if (unknown.length > 0) {
    die(
      `Unknown contract(s): ${unknown.join(", ")}`,
      `Available: ${CONTRACT_KEYS.join(", ")}`
    );
  }

  if (selected.length === 0) {
    die("No contracts selected.", `Available: ${CONTRACT_KEYS.join(", ")}`);
  }

  console.log(RULE);
  console.log("  TrustLend — Soroban Deployment");
  console.log(`  Network : ${options.network}`);
  console.log(`  Contracts: ${selected.length}`);
  if (DRY_RUN) console.log("  Mode    : DRY RUN (nothing will be executed)");
  console.log(RULE);

  // ── Preflight ──────────────────────────────────────────────────────────────
  log.step("Checking prerequisites…");
  checkStellarCli();
  const adminAddress = ensureAdminIdentity(options);
  await ensureFunded(adminAddress, options.network);

  // ── Resume ─────────────────────────────────────────────────────────────────
  const ids: Record<string, string> = {};
  const previous = options.resume ? readState(options.network) : null;

  if (previous) {
    log.info(
      `Resuming from ${path.relative(REPO_ROOT, stateFile(options.network))} ` +
        `(deployed ${previous.deployedAt})`
    );
    Object.assign(ids, previous.contracts);
  }

  // ── Build ──────────────────────────────────────────────────────────────────
  const toDeploy = selected.filter((spec) => !ids[spec.key]);

  if (toDeploy.length === 0) {
    log.info("Every selected contract already has an id — nothing to deploy");
  } else if (options.skipBuild) {
    log.info("Skipping build (--skip-build)");
  } else {
    buildContracts();
  }

  // ── Deploy ─────────────────────────────────────────────────────────────────
  if (toDeploy.length > 0) {
    log.step(`Deploying ${toDeploy.length} contract(s) to ${options.network}…`);

    for (const spec of toDeploy) {
      const id = deployContract(spec, options);
      ids[spec.key] = id;
      log.ok(`${spec.label} → ${id}`);

      // Persist after every deploy so a later failure never strands a contract
      // that was paid for but not recorded. --resume picks it back up.
      writeState({
        network: options.network,
        adminAddress,
        deployedAt: new Date().toISOString(),
        contracts: ids,
      });
    }
  }

  // ── Initialize ─────────────────────────────────────────────────────────────
  if (options.skipInit) {
    log.info("Skipping initialization (--skip-init)");
  } else if (toDeploy.length > 0) {
    initializeContracts(ids, adminAddress, options);
  } else {
    log.info("Skipping initialization — no newly deployed contracts");
  }

  // ── Bindings ───────────────────────────────────────────────────────────────
  if (options.skipBindings) {
    log.info("Skipping TypeScript bindings (--skip-bindings)");
  } else {
    generateBindings(selected, ids, options);
  }

  // ── Env output ─────────────────────────────────────────────────────────────
  log.step("Writing contract IDs to the env file…");

  const envVars: Record<string, string> = {};
  for (const spec of selected) {
    if (ids[spec.key]) envVars[spec.envVar] = ids[spec.key];
  }
  envVars.NEXT_PUBLIC_ADMIN_ADDRESS = adminAddress;
  if (process.env.ORACLE_ADDRESS) {
    envVars.NEXT_PUBLIC_ORACLE_ADDRESS = process.env.ORACLE_ADDRESS;
  }

  const { envFilePath, created } = writeEnvFiles(envVars, options);
  const relativeEnv = path.relative(REPO_ROOT, envFilePath);

  if (!DRY_RUN) {
    log.ok(`${created ? "Created" : "Updated"} ${relativeEnv}`);
    log.ok("Reference copy written to .env.contracts");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${RULE}`);
  console.log("  Deployment complete");
  console.log(`  Admin: ${adminAddress}\n`);

  for (const spec of selected) {
    if (!ids[spec.key]) continue;
    console.log(`  ${spec.label.padEnd(28)} ${ids[spec.key]}`);
  }

  const missing = selected.filter((spec) => spec.required && !ids[spec.key]);
  if (missing.length > 0) {
    console.log(
      `\n  ⚠ Required contracts missing: ${missing.map((s) => s.key).join(", ")}`
    );
  }

  console.log(`\n  Contract IDs are live in ${relativeEnv} — restart \`npm run dev\`.`);
  console.log(RULE);
}

main().catch((error) => {
  console.error("\n✖ Deployment failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
