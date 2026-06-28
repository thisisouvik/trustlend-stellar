import { getServiceRoleClient } from "@/lib/supabase/server";

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
  const supabase = getServiceRoleClient();
  if (!supabase) throw new Error("Service role client unavailable");

  const now = new Date();
  const cutoff = new Date(now.getTime() + LOOKAHEAD_HOURS * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("loans")
    .select("id, borrower_id, due_at, principal_amount, repaid_amount, metadata")
    .in("status", ["active", "funded"])
    .not("due_at", "is", null)
    .gt("due_at", now.toISOString())
    .lte("due_at", cutoff.toISOString());

  if (error) throw new Error(`Failed to query due loans: ${error.message}`);

  // Filter out already-notified loans in JS (avoids complex jsonb query)
  return (data ?? []).filter(
    (loan) => !(loan.metadata as Record<string, unknown>)?.payment_due_notified_at
  );
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
  const supabase = getServiceRoleClient();
  if (!supabase) throw new Error("Service role client unavailable");

  const { error } = await supabase.rpc("jsonb_set_metadata_key", {
    p_loan_id: loanId,
    p_key: "payment_due_notified_at",
    p_value: new Date().toISOString(),
  });

  // Fallback: manual merge if RPC not available
  if (error) {
    const { data: loan, error: fetchErr } = await supabase
      .from("loans")
      .select("metadata")
      .eq("id", loanId)
      .single();

    if (fetchErr) throw new Error(`Failed to fetch loan for metadata update: ${fetchErr.message}`);

    const { error: updateErr } = await supabase
      .from("loans")
      .update({
        metadata: {
          ...(loan.metadata as Record<string, unknown>),
          payment_due_notified_at: new Date().toISOString(),
        },
      })
      .eq("id", loanId);

    if (updateErr) throw new Error(`Failed to mark loan notified: ${updateErr.message}`);
  }
}

export interface RunResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

/**
 * Main scheduler entrypoint. Queries due loans and delivers webhook notifications.
 */
export async function runPaymentDueScheduler(): Promise<RunResult> {
  const webhookUrl = process.env.WEBHOOK_NOTIFICATION_URL;
  if (!webhookUrl) throw new Error("WEBHOOK_NOTIFICATION_URL is not configured");

  const loans = await queryDueLoans();
  const result: RunResult = { processed: loans.length, succeeded: 0, failed: 0, errors: [] };

  for (const loan of loans) {
    try {
      await sendWebhookNotification(loan, webhookUrl);
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

  return result;
}
