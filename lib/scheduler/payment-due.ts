import { and, eq, gt, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { getActiveCronSignal } from "@/lib/auth/cron";
import { getDb } from "@/lib/db/client";
import { loans } from "@/lib/db/schema";
import {
  isResendConfigured,
  sendPaymentOverdueEmail,
} from "@/lib/email/resend";

const WEBHOOK_TIMEOUT_MS = 10_000;
const LOOKAHEAD_HOURS = 48;

export interface DueLoan {
  id: string;
  borrower_id: string;
  due_at: string;
  principal_amount: number;
  repaid_amount: number;
  metadata: Record<string, unknown>;
}

export type OverdueLoan = DueLoan;

export interface WebhookPayload {
  borrowerId: string;
  loanId: string;
  dueDate: string;
  paymentAmount: number;
}

/**
 * Query active loans with a due date within the next LOOKAHEAD_HOURS that
 * have not already had a payment-due notification sent.
 */
export async function queryDueLoans(): Promise<DueLoan[]> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable");

  const now = new Date();
  const cutoff = new Date(now.getTime() + LOOKAHEAD_HOURS * 60 * 60 * 1000);

  const rows = await db
    .select(DUE_LOAN_COLUMNS)
    .from(loans)
    .where(
      and(
        inArray(loans.status, ["active", "funded"]),
        isNotNull(loans.dueAt),
        gt(loans.dueAt, now),
        lte(loans.dueAt, cutoff),
      ),
    );

  // Filter out already-notified loans in JS (avoids complex jsonb query)
  return rows.map(toDueLoan).filter((loan) => !loan.metadata?.payment_due_notified_at);
}

/**
 * Query active loans that are already overdue and have not had an overdue email sent.
 */
export async function queryOverdueEmailLoans(): Promise<OverdueLoan[]> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable");

  const rows = await db
    .select(DUE_LOAN_COLUMNS)
    .from(loans)
    .where(
      and(inArray(loans.status, ["active", "funded"]), isNotNull(loans.dueAt), lt(loans.dueAt, new Date())),
    );

  return rows.map(toDueLoan).filter((loan) => !loan.metadata?.payment_overdue_emailed_at);
}

const DUE_LOAN_COLUMNS = {
  id: loans.id,
  borrowerId: loans.borrowerId,
  dueAt: loans.dueAt,
  principalAmount: loans.principalAmount,
  repaidAmount: loans.repaidAmount,
  metadata: loans.metadata,
};

function toDueLoan(row: {
  id: string;
  borrowerId: string;
  dueAt: Date | null;
  principalAmount: string;
  repaidAmount: string;
  metadata: unknown;
}): DueLoan {
  return {
    id: row.id,
    borrower_id: row.borrowerId,
    due_at: row.dueAt ? row.dueAt.toISOString() : "",
    principal_amount: Number(row.principalAmount),
    repaid_amount: Number(row.repaidAmount),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/** Atomically merge one key into loans.metadata. */
async function setLoanMetadataKey(loanId: string, key: string, value: string): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable");
  await db
    .update(loans)
    .set({ metadata: sql`coalesce(${loans.metadata}, '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::text)` })
    .where(eq(loans.id, loanId));
}

/**
 * Send a single webhook notification for a loan.
 */
export async function sendWebhookNotification(
  loan: DueLoan,
  webhookUrl: string
): Promise<void> {
  const outstandingAmount = loan.principal_amount - loan.repaid_amount;
  const payload: WebhookPayload = {
    borrowerId: loan.borrower_id,
    loanId: loan.id,
    dueDate: loan.due_at,
    paymentAmount: outstandingAmount > 0 ? outstandingAmount : loan.principal_amount,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Webhook responded with HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mark a loan as notified by writing a timestamp into its metadata.
 */
export async function markLoanNotified(loanId: string): Promise<void> {
  await setLoanMetadataKey(loanId, "payment_due_notified_at", new Date().toISOString());
}

export async function markLoanOverdueEmailed(loanId: string): Promise<void> {
  await setLoanMetadataKey(loanId, "payment_overdue_emailed_at", new Date().toISOString());
}

export interface RunResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
  timedOut?: boolean;
}

/**
 * Main scheduler entrypoint. Queries due loans and delivers webhook notifications.
 */
export async function runPaymentDueScheduler(options?: {
  signal?: AbortSignal;
}): Promise<RunResult> {
  const signal = options?.signal ?? getActiveCronSignal();
  const webhookUrl = process.env.WEBHOOK_NOTIFICATION_URL;
  const emailEnabled = isResendConfigured();
  if (!webhookUrl && !emailEnabled) {
    throw new Error("WEBHOOK_NOTIFICATION_URL or Resend email configuration is required");
  }

  const dueLoans = webhookUrl ? await queryDueLoans() : [];
  const overdueLoans = emailEnabled ? await queryOverdueEmailLoans() : [];
  const result: RunResult = {
    processed: dueLoans.length + overdueLoans.length,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  for (const loan of dueLoans) {
    if (signal?.aborted) {
      result.timedOut = true;
      console.warn(`[payment-due] Execution deadline reached before loan ${loan.id}; halting batch.`);
      return result;
    }
    try {
      await sendWebhookNotification(loan, webhookUrl!);
      await markLoanNotified(loan.id);
      result.succeeded++;
      console.log(`[payment-due] Notified loan ${loan.id}`);
    } catch (err) {
      result.failed++;
      // Log error without exposing secrets; just include loan ID and message
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`loan ${loan.id}: ${msg}`);
      console.error(`[payment-due] Failed to notify loan ${loan.id}:`, msg);
    }
  }

  for (const loan of overdueLoans) {
    if (signal?.aborted) {
      result.timedOut = true;
      console.warn(`[payment-due] Execution deadline reached before overdue email for loan ${loan.id}; halting batch.`);
      return result;
    }
    try {
      const outstandingAmount = loan.principal_amount - loan.repaid_amount;
      await sendPaymentOverdueEmail({
        userId: loan.borrower_id,
        loanId: loan.id,
        dueAt: loan.due_at,
        amount: outstandingAmount > 0 ? outstandingAmount : loan.principal_amount,
      });
      await markLoanOverdueEmailed(loan.id);
      result.succeeded++;
      console.log(`[payment-due] Sent overdue email for loan ${loan.id}`);
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`loan ${loan.id}: ${msg}`);
      console.error(`[payment-due] Failed overdue email for loan ${loan.id}:`, msg);
    }
  }

  return result;
}
