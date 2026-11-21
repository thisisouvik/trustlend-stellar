/**
 * lib/scheduler/default-management.ts
 *
 * Automated Default-Management run (issue #23).
 *
 * Iterates over active loans, checks the *ledger* time, and for loans past the
 * grace period:
 *   1. lending.mark_defaulted(admin, loanId)         — flips the on-chain loan to Defaulted
 *   2. default.record_default(admin, loanId, …)      — records the default phase
 * and, once a loan reaches the insurance threshold (Reported phase):
 *   3. multisig.propose(admin, TriggerInsurancePayout(default, loanId, lender, amount))
 *
 * Step 3 does NOT move funds directly — `trigger_insurance_payout` is
 * multisig-gated (issue #73), since paying out the insurance fund is exactly
 * the kind of rare, high-impact operation that needs N-of-M human approval.
 * The automation's own key must be a REGISTERED SIGNER on the MultiSigAdmin
 * contract so it can propose; a human still has to approve + execute before
 * any funds actually move. See `docs/contracts/multisig-admin.md`.
 *
 * Every step is idempotent (guarded by database state) and individually
 * error-handled so one bad loan never aborts the whole run.
 */

import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getActiveCronSignal } from "@/lib/auth/cron";
import { getDb, type Db } from "@/lib/db/client";
import { ledgerTransactions, loans, profiles } from "@/lib/db/schema";
import {
  addr,
  getAdminKeypair,
  getLedgerTimeSecs,
  i128,
  invokeSigned,
  tupleEnumToScVal,
  u32,
  u64,
  xlmToStroops,
} from "@/lib/stellar/server-contract";
import type { Keypair } from "@stellar/stellar-sdk";

const SECONDS_PER_DAY = 86_400;

/** Days overdue before a loan is marked defaulted (Friendly window = days 1-7). */
const GRACE_PERIOD_DAYS = Number(process.env.DEFAULT_GRACE_PERIOD_DAYS ?? 7);
/** Days overdue before the insurance fund reimburses the lender (Reported phase). */
const INSURANCE_PAYOUT_DAYS = Number(process.env.DEFAULT_INSURANCE_PAYOUT_DAYS ?? 60);

const LENDING_ID = process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID;
const DEFAULT_ID = process.env.NEXT_PUBLIC_DEFAULT_CONTRACT_ID;
const ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS;
const MULTISIG_ADMIN_ID = process.env.NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoanRow {
  id: string;
  borrower_id: string;
  status: string;
  principal_amount: number;
  repaid_amount: number;
  due_at: string | null;
  defaulted_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface LoanOutcome {
  loanId: string;
  onchainLoanId: number | null;
  daysOverdue: number;
  actions: string[];
  skipped?: string;
  error?: string;
}

export interface DefaultRunResult {
  ledgerTime: string;
  scanned: number;
  defaulted: number;
  payoutsProposed: number;
  failed: number;
  outcomes: LoanOutcome[];
  timedOut?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Whole days a loan is overdue at `ledgerTimeSecs` (0 if not overdue). */
export function computeDaysOverdue(dueAtIso: string, ledgerTimeSecs: number): number {
  const dueSecs = Math.floor(new Date(dueAtIso).getTime() / 1000);
  if (ledgerTimeSecs <= dueSecs) return 0;
  return Math.floor((ledgerTimeSecs - dueSecs) / SECONDS_PER_DAY);
}

function outstandingXlm(loan: LoanRow): number {
  const remaining = Number(loan.principal_amount) - Number(loan.repaid_amount ?? 0);
  return remaining > 0 ? remaining : Number(loan.principal_amount);
}

/** Resolve the borrower's Stellar wallet from the profiles table. */
async function getWallet(db: Db, profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ walletAddress: profiles.walletAddress })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .limit(1);
  const w = row?.walletAddress;
  return typeof w === "string" && w.startsWith("G") ? w : null;
}

/** Lender wallet + on-chain loan id are recorded at funding time in the ledger. */
async function getFundingInfo(
  db: Db,
  loanId: string,
  loanMeta: Record<string, unknown> | null
): Promise<{ lenderAddress: string | null; onchainLoanId: number | null }> {
  // Prefer the on-chain id if the loan row carries it.
  let onchainLoanId =
    toOnchainId(loanMeta?.onchain_loan_id) ?? toOnchainId(loanMeta?.onchainLoanId);
  let lenderAddress: string | null = null;

  // A loan can be filled by several lenders (Issue #269), so this may match
  // many rows. Take the largest contributor as the payout designee — the
  // MultiSigAdmin insurance proposal names a single lender, so splitting an
  // insurance payout across lenders is a separate piece of work.
  const [data] = await db
    .select({ metadata: ledgerTransactions.metadata, amount: ledgerTransactions.amount })
    .from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.refType, "loan_fund"), eq(ledgerTransactions.refId, loanId)))
    .orderBy(desc(ledgerTransactions.amount))
    .limit(1);

  const raw = data?.metadata;
  const meta: Record<string, unknown> | null =
    typeof raw === "string" ? safeJson(raw) : (raw as Record<string, unknown> | null);

  if (meta) {
    const l = meta.lenderAddress;
    if (typeof l === "string" && l.startsWith("G")) lenderAddress = l;
    onchainLoanId =
      onchainLoanId ?? toOnchainId(meta.onchainLoanId) ?? toOnchainId(meta.onchain_loan_id);
  }
  return { lenderAddress, onchainLoanId };
}

function toOnchainId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function setLoanMetadataFlag(
  db: Db,
  loanId: string,
  patch: Record<string, unknown>,
  extraCols: { status?: "defaulted"; defaulted_at?: string } = {}
): Promise<void> {
  await db
    .update(loans)
    .set({
      // Atomic jsonb merge so concurrent runs cannot clobber each other's flags.
      metadata: sql`coalesce(${loans.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      ...(extraCols.status ? { status: extraCols.status } : {}),
      ...(extraCols.defaulted_at ? { defaultedAt: new Date(extraCols.defaulted_at) } : {}),
    })
    .where(eq(loans.id, loanId));
}

// ─── Core run ─────────────────────────────────────────────────────────────────

/**
 * Query loans that are live (active/funded) and already past their due date.
 */
async function queryOverdueLoans(db: Db, nowIso: string): Promise<LoanRow[]> {
  const rows = await db
    .select({
      id: loans.id,
      borrowerId: loans.borrowerId,
      status: loans.status,
      principalAmount: loans.principalAmount,
      repaidAmount: loans.repaidAmount,
      dueAt: loans.dueAt,
      defaultedAt: loans.defaultedAt,
      metadata: loans.metadata,
    })
    .from(loans)
    .where(and(inArray(loans.status, ["active", "funded"]), isNotNull(loans.dueAt), lt(loans.dueAt, new Date(nowIso))));

  return rows.map((r) => ({
    id: r.id,
    borrower_id: r.borrowerId,
    status: r.status,
    principal_amount: Number(r.principalAmount),
    repaid_amount: Number(r.repaidAmount),
    due_at: r.dueAt ? r.dueAt.toISOString() : null,
    defaulted_at: r.defaultedAt ? r.defaultedAt.toISOString() : null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  }));
}

export async function runDefaultManagement(options?: {
  signal?: AbortSignal;
}): Promise<DefaultRunResult> {
  const signal = options?.signal ?? getActiveCronSignal();
  const db = getDb();
  if (!db) throw new Error("Database unavailable (check DATABASE_URL)");

  const ledgerTimeSecs = await getLedgerTimeSecs();
  const ledgerIso = new Date(ledgerTimeSecs * 1000).toISOString();

  const signer = getAdminKeypair();
  const onchainReady = Boolean(signer && LENDING_ID && DEFAULT_ID && ADMIN_ADDRESS);
  if (!onchainReady) {
    console.warn(
      "[default-mgmt] On-chain signing not configured " +
        "(ADMIN_SECRET_KEY / contract IDs missing) — DB state will update, contract calls skipped."
    );
  }

  const loans = await queryOverdueLoans(db, ledgerIso);

  const result: DefaultRunResult = {
    ledgerTime: ledgerIso,
    scanned: loans.length,
    defaulted: 0,
    payoutsProposed: 0,
    failed: 0,
    outcomes: [],
  };

  for (const loan of loans) {
    if (signal?.aborted) {
      result.timedOut = true;
      console.warn(`[default-mgmt] Execution deadline reached before loan ${loan.id}; halting batch.`);
      return result;
    }

    const outcome: LoanOutcome = {
      loanId: loan.id,
      onchainLoanId: null,
      daysOverdue: 0,
      actions: [],
    };

    try {
      const daysOverdue = loan.due_at
        ? computeDaysOverdue(loan.due_at, ledgerTimeSecs)
        : 0;
      outcome.daysOverdue = daysOverdue;

      if (daysOverdue <= GRACE_PERIOD_DAYS) {
        outcome.skipped = `within grace period (${daysOverdue}/${GRACE_PERIOD_DAYS} days)`;
        result.outcomes.push(outcome);
        continue;
      }

      const meta = loan.metadata ?? {};
      const alreadyDefaulted = Boolean(loan.defaulted_at) || Boolean(meta.defaulted_onchain_at);
      const alreadyProposedPayout = Boolean(meta.insurance_payout_proposed_at);

      const { lenderAddress, onchainLoanId } = await getFundingInfo(db, loan.id, meta);
      outcome.onchainLoanId = onchainLoanId;
      const borrowerWallet = await getWallet(db, loan.borrower_id);
      const amountStroops = xlmToStroops(outstandingXlm(loan));

      // ── 1 + 2: mark defaulted & record the phase ─────────────────────────────
      if (!alreadyDefaulted) {
        if (onchainReady && onchainLoanId && borrowerWallet) {
          await markDefaultedOnChain(
            signer!,
            onchainLoanId,
            borrowerWallet,
            amountStroops,
            daysOverdue
          );
          outcome.actions.push("mark_defaulted", "record_default");
        } else if (onchainReady) {
          outcome.actions.push("skipped on-chain default (missing onchain id / wallet)");
        }
        await setLoanMetadataFlag(
          db,
          loan.id,
          { defaulted_onchain_at: ledgerIso, days_overdue: daysOverdue },
          { status: "defaulted", defaulted_at: ledgerIso }
        );
        outcome.actions.push("db:status=defaulted");
        result.defaulted++;
      }

      // ── 3: propose an insurance payout once past the insurance threshold ─────
      // Multisig-gated (issue #73) — this only PROPOSES the payout; a human
      // must still approve + execute on the MultiSigAdmin contract before any
      // funds move. See the module doc comment above.
      if (daysOverdue >= INSURANCE_PAYOUT_DAYS && !alreadyProposedPayout) {
        if (onchainReady && MULTISIG_ADMIN_ID && onchainLoanId && lenderAddress) {
          const proposalId = await proposeInsurancePayout(
            signer!,
            onchainLoanId,
            lenderAddress,
            amountStroops
          );
          outcome.actions.push("propose:trigger_insurance_payout");
          await setLoanMetadataFlag(db, loan.id, {
            insurance_payout_proposed_at: ledgerIso,
            insurance_payout_proposal_id: proposalId,
            insurance_amount_stroops: amountStroops.toString(),
            insurance_lender: lenderAddress,
          });
          outcome.actions.push("db:insurance_payout_proposed");
          result.payoutsProposed++;
        } else {
          outcome.actions.push(
            `payout proposal deferred (${
              onchainReady
                ? MULTISIG_ADMIN_ID
                  ? "missing lender/onchain id"
                  : "NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID not configured"
                : "on-chain not configured"
            })`
          );
        }
      }

      result.outcomes.push(outcome);
      console.log(`[default-mgmt] loan ${loan.id} (${daysOverdue}d): ${outcome.actions.join(", ")}`);
    } catch (err) {
      result.failed++;
      outcome.error = err instanceof Error ? err.message : String(err);
      result.outcomes.push(outcome);
      console.error(`[default-mgmt] loan ${loan.id} failed:`, outcome.error);
    }
  }

  return result;
}

// ─── On-chain actions ───────────────────────────────────────────────────────────

async function markDefaultedOnChain(
  signer: Keypair,
  onchainLoanId: number,
  borrowerWallet: string,
  amountStroops: bigint,
  daysOverdue: number
): Promise<void> {
  // 1. Flip the loan to Defaulted on the lending contract.
  await invokeSigned({
    contractId: LENDING_ID!,
    method: "mark_defaulted",
    args: [addr(ADMIN_ADDRESS!), u32(onchainLoanId)],
    signer,
  });
  // 2. Record the default phase on the default-management contract.
  await invokeSigned({
    contractId: DEFAULT_ID!,
    method: "record_default",
    args: [
      addr(ADMIN_ADDRESS!),
      u32(onchainLoanId),
      addr(borrowerWallet),
      i128(amountStroops),
      u64(daysOverdue),
    ],
    signer,
  });
}

/**
 * Propose (NOT execute) an insurance payout on the MultiSigAdmin contract.
 * `trigger_insurance_payout` only accepts calls from the registered multisig
 * — this automation's key must itself be one of that multisig's signers, so
 * proposing here counts as its own first approval. A human still has to
 * gather the remaining approvals and call `execute` before funds move.
 */
async function proposeInsurancePayout(
  signer: Keypair,
  onchainLoanId: number,
  lenderWallet: string,
  amountStroops: bigint
): Promise<number> {
  const action = tupleEnumToScVal("TriggerInsurancePayout", [
    addr(DEFAULT_ID!),
    u32(onchainLoanId),
    addr(lenderWallet),
    i128(amountStroops),
  ]);
  const result = await invokeSigned({
    contractId: MULTISIG_ADMIN_ID!,
    method: "propose",
    args: [addr(ADMIN_ADDRESS!), action],
    signer,
  });
  return Number(result.returnValue);
}
