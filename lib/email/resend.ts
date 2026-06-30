import { getServiceRoleClient } from "@/lib/supabase/server";
import {
  loanApprovedTemplate,
  loanFundedTemplate,
  paymentOverdueTemplate,
} from "@/lib/email/templates";

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

interface LoanEmailInput {
  userId: string;
  amount: number;
  loanId: string;
}

interface OverdueEmailInput extends LoanEmailInput {
  dueAt: string;
}

export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function appUrl(path: string) {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return new URL(path, base).toString();
}

async function getUserEmail(userId: string): Promise<string | null> {
  const supabase = getServiceRoleClient();
  const admin = supabase?.auth?.admin;
  if (!admin) return null;

  const { data, error } = await admin.getUserById(userId);
  if (error) {
    console.warn(`[email] Could not resolve email for user ${userId}: ${error.message}`);
    return null;
  }

  return data.user?.email ?? null;
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  if (!isResendConfigured()) return;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      reply_to: process.env.RESEND_REPLY_TO_EMAIL || undefined,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function sendLoanEmail(
  userId: string,
  template: ReturnType<typeof loanApprovedTemplate>,
): Promise<void> {
  try {
    const to = await getUserEmail(userId);
    if (!to) return;
    await sendEmail({ to, ...template });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[email] Failed to send loan email to ${userId}:`, message);
  }
}

export async function sendLoanApprovedEmail({
  userId,
  amount,
  loanId,
}: LoanEmailInput): Promise<void> {
  await sendLoanEmail(
    userId,
    loanApprovedTemplate({
      amount,
      dashboardUrl: appUrl(`/dashboard/borrower/loans?loan=${encodeURIComponent(loanId)}`),
    }),
  );
}

export async function sendLoanFundedEmail({
  userId,
  amount,
  loanId,
}: LoanEmailInput): Promise<void> {
  await sendLoanEmail(
    userId,
    loanFundedTemplate({
      amount,
      dashboardUrl: appUrl(`/dashboard/borrower/repay?loan=${encodeURIComponent(loanId)}`),
    }),
  );
}

export async function sendPaymentOverdueEmail({
  userId,
  amount,
  loanId,
  dueAt,
}: OverdueEmailInput): Promise<void> {
  await sendLoanEmail(
    userId,
    paymentOverdueTemplate({
      amount,
      dueAt,
      dashboardUrl: appUrl(`/dashboard/borrower/repay?loan=${encodeURIComponent(loanId)}`),
    }),
  );
}
