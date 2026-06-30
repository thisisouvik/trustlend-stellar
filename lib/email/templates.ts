const brandName = "TrustLend";

function baseEmail({
  title,
  preview,
  body,
  actionUrl,
  actionLabel,
}: {
  title: string;
  preview: string;
  body: string;
  actionUrl?: string;
  actionLabel?: string;
}) {
  const button =
    actionUrl && actionLabel
      ? `<p style="margin:28px 0 0"><a href="${actionUrl}" style="display:inline-block;background:#7e2fd0;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px">${actionLabel}</a></p>`
      : "";

  return {
    subject: title,
    text: `${preview}\n\n${body.replace(/<[^>]+>/g, "")}${actionUrl ? `\n\n${actionUrl}` : ""}`,
    html: `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#151827">
    <div style="display:none;max-height:0;overflow:hidden">${preview}</div>
    <main style="max-width:560px;margin:0 auto;padding:32px 18px">
      <section style="background:#ffffff;border:1px solid #e8eaf3;border-radius:8px;padding:28px">
        <p style="margin:0 0 18px;color:#7e2fd0;font-weight:800;font-size:14px">${brandName}</p>
        <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#151827">${title}</h1>
        <div style="font-size:15px;line-height:1.65;color:#3f4454">${body}</div>
        ${button}
      </section>
      <p style="margin:18px 0 0;font-size:12px;color:#7b8192">
        You are receiving this because your loan status changed on TrustLend.
      </p>
    </main>
  </body>
</html>`,
  };
}

function formatAmount(amount: number) {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(amount)} XLM`;
}

export function loanApprovedTemplate({
  amount,
  dashboardUrl,
}: {
  amount: number;
  dashboardUrl?: string;
}) {
  return baseEmail({
    title: "Loan Approved",
    preview: `Your ${formatAmount(amount)} loan request has been approved.`,
    body: `<p>Your loan request for <strong>${formatAmount(amount)}</strong> has been approved and matched with platform liquidity.</p><p>We will update you again when funding is completed.</p>`,
    actionUrl: dashboardUrl,
    actionLabel: "View Loan",
  });
}

export function loanFundedTemplate({
  amount,
  dashboardUrl,
}: {
  amount: number;
  dashboardUrl?: string;
}) {
  return baseEmail({
    title: "Loan Funded",
    preview: `Your ${formatAmount(amount)} loan has been funded.`,
    body: `<p>Good news. Your loan for <strong>${formatAmount(amount)}</strong> has been funded.</p><p>The funds have been sent to your Stellar wallet, and repayment details are available in your dashboard.</p>`,
    actionUrl: dashboardUrl,
    actionLabel: "Open Dashboard",
  });
}

export function paymentOverdueTemplate({
  amount,
  dueAt,
  dashboardUrl,
}: {
  amount: number;
  dueAt: string;
  dashboardUrl?: string;
}) {
  const dueDate = new Date(dueAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return baseEmail({
    title: "Payment Overdue",
    preview: `Your TrustLend payment due on ${dueDate} is overdue.`,
    body: `<p>Your payment of <strong>${formatAmount(amount)}</strong> was due on <strong>${dueDate}</strong> and is now overdue.</p><p>Please repay as soon as possible to protect your reputation score and avoid default handling.</p>`,
    actionUrl: dashboardUrl,
    actionLabel: "Repay Now",
  });
}
