import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { metaString } from "@/lib/db/metadata";
import { ledgerTransactions, loanRepayments, loans } from "@/lib/db/schema";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { isBoundedString } from "@/lib/http/request-validation";

const PAGE_SIZE = 20;

type BorrowerTransaction = {
  id: string;
  type: "loan_requested" | "funding_received" | "repayment_made";
  loanId: string;
  amount: number;
  date: string;
  txHash: string;
  loanStatus: string;
};

/**
 * GET /api/borrower/transactions?cursor=<cursor>&direction=<next|prev>
 *
 * Returns paginated transaction history for the authenticated borrower.
 * Cursor is the created_at timestamp of the last item.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { user } = await requireAuthenticatedUser("borrower");
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
    const direction = request.nextUrl.searchParams.get("direction") || "next";
    if (cursor && !isBoundedString(cursor, 64)) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
    if (direction !== "next" && direction !== "prev") {
      return NextResponse.json({ error: "Invalid direction" }, { status: 400 });
    }

    // Loans with cursor-based pagination (one extra row to detect "more").
    const cursorDate = cursor ? new Date(cursor) : null;
    const cursorClause =
      cursorDate && !Number.isNaN(cursorDate.getTime())
        ? direction === "next"
          ? lt(loans.createdAt, cursorDate)
          : gt(loans.createdAt, cursorDate)
        : undefined;

    const loanRows = await db
      .select({
        id: loans.id,
        status: loans.status,
        principalAmount: loans.principalAmount,
        createdAt: loans.createdAt,
      })
      .from(loans)
      .where(and(eq(loans.borrowerId, user.id), cursorClause))
      .orderBy(desc(loans.createdAt))
      .limit(PAGE_SIZE + 1);

    const hasMore = loanRows.length > PAGE_SIZE;
    const items = loanRows.slice(0, PAGE_SIZE);
    const loanIds = items.map((l) => l.id);

    if (loanIds.length === 0) {
      return NextResponse.json({ transactions: [], hasMore: false, nextCursor: undefined });
    }

    // Ledger entries (request + funding) and repayments for this page of loans.
    const [ledgerRows, repaymentRows] = await Promise.all([
      db
        .select({
          refType: ledgerTransactions.refType,
          refId: ledgerTransactions.refId,
          metadata: ledgerTransactions.metadata,
          createdAt: ledgerTransactions.createdAt,
          amount: ledgerTransactions.amount,
        })
        .from(ledgerTransactions)
        .where(
          and(inArray(ledgerTransactions.refType, ["loan_fund", "loan_request"]), inArray(ledgerTransactions.refId, loanIds)),
        ),
      db
        .select({
          id: loanRepayments.id,
          loanId: loanRepayments.loanId,
          amount: loanRepayments.amount,
          createdAt: loanRepayments.createdAt,
        })
        .from(loanRepayments)
        .where(inArray(loanRepayments.loanId, loanIds))
        .orderBy(desc(loanRepayments.createdAt))
        .limit(100),
    ]);

    // Repayment ledger rows carry the tx hash; fetch them in one query.
    const repaymentIds = repaymentRows.map((r) => r.id);
    const repayLedgerRows = repaymentIds.length
      ? await db
          .select({ refId: ledgerTransactions.refId, metadata: ledgerTransactions.metadata })
          .from(ledgerTransactions)
          .where(and(eq(ledgerTransactions.refType, "loan_repay"), inArray(ledgerTransactions.refId, repaymentIds)))
      : [];
    const repayHashByRepaymentId = new Map(
      repayLedgerRows.map((row) => [row.refId ?? "", metaString(row.metadata, "txHash")]),
    );

    const requestTxMap = new Map<string, { date: string; amount: number }>();
    const fundTxMap = new Map<string, { hash: string; amount: number; date: string }>();
    for (const entry of ledgerRows) {
      if (!entry.refId) continue;
      if (entry.refType === "loan_request") {
        requestTxMap.set(entry.refId, { date: entry.createdAt.toISOString(), amount: Number(entry.amount ?? 0) });
      } else {
        // A loan may have several fundings (#269); keep the latest for the feed.
        fundTxMap.set(entry.refId, {
          hash: metaString(entry.metadata, "txHash"),
          amount: (fundTxMap.get(entry.refId)?.amount ?? 0) + Number(entry.amount ?? 0),
          date: entry.createdAt.toISOString(),
        });
      }
    }

    const transactions: BorrowerTransaction[] = [];

    for (const loan of items) {
      const requestTx = requestTxMap.get(loan.id);
      transactions.push({
        id: `request-${loan.id}`,
        type: "loan_requested",
        loanId: loan.id,
        amount: requestTx?.amount ?? Number(loan.principalAmount ?? 0),
        date: requestTx?.date || loan.createdAt.toISOString(),
        txHash: "",
        loanStatus: loan.status,
      });

      const fund = fundTxMap.get(loan.id);
      if (fund && fund.amount > 0) {
        transactions.push({
          id: `fund-${loan.id}`,
          type: "funding_received",
          loanId: loan.id,
          amount: fund.amount,
          date: fund.date || loan.createdAt.toISOString(),
          txHash: fund.hash,
          loanStatus: loan.status,
        });
      }
    }

    for (const r of repaymentRows) {
      const loan = items.find((l) => l.id === r.loanId);
      if (!loan) continue;
      transactions.push({
        id: `repay-${r.id}`,
        type: "repayment_made",
        loanId: r.loanId,
        amount: Number(r.amount),
        date: r.createdAt.toISOString(),
        txHash: repayHashByRepaymentId.get(r.id) ?? "",
        loanStatus: loan.status,
      });
    }

    transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const nextCursor = transactions.length > 0 ? transactions[transactions.length - 1].date : undefined;

    return NextResponse.json({ transactions, hasMore, nextCursor });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof UnauthorizedError) {
      const unauthenticated = err.message === "Not authenticated";
      return NextResponse.json(
        { error: unauthenticated ? "Authentication required" : err.message },
        { status: unauthenticated ? 401 : 403 },
      );
    }
    console.error("Transactions fetch error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
