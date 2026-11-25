import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { loanRepayments, loans } from "@/lib/db/schema";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { isBoundedString } from "@/lib/http/request-validation";

export async function GET(request: NextRequest) {
  try {
    // ── Rate limit ───────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { user } = await requireAuthenticatedUser("borrower");
    const loanId = request.nextUrl.searchParams.get("loanId");

    if (!isBoundedString(loanId, 128)) {
      return NextResponse.json({ error: "loanId is required" }, { status: 400 });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Verify loan belongs to this borrower
    const [loan] = await db
      .select({
        id: loans.id,
        principal_amount: loans.principalAmount,
        repaid_amount: loans.repaidAmount,
        status: loans.status,
      })
      .from(loans)
      .where(and(eq(loans.id, loanId), eq(loans.borrowerId, user.id)))
      .limit(1);

    if (!loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    }

    // Fetch repayment history
    const repayments = await db
      .select({ id: loanRepayments.id, amount: loanRepayments.amount, created_at: loanRepayments.createdAt })
      .from(loanRepayments)
      .where(eq(loanRepayments.loanId, loanId))
      .orderBy(desc(loanRepayments.createdAt))
      .limit(50);

    const dueAmount = Math.max(0, Number(loan.principal_amount) - Number(loan.repaid_amount ?? 0));

    return NextResponse.json({
      repayments: repayments.map((r) => ({
        id: r.id,
        repayment_id: r.id,
        amount: Number(r.amount),
        created_at: r.created_at,
      })),
      dueAmount,
      loanStatus: loan.status,
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error("Repayments fetch error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
