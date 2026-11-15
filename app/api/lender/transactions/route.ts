import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { metaString, readMetadata } from "@/lib/db/metadata";
import { ledgerTransactions } from "@/lib/db/schema";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { isBoundedString } from "@/lib/http/request-validation";

const PAGE_SIZE = 20;

/**
 * GET /api/lender/transactions?cursor=<cursor>&direction=<next|prev>
 *
 * Returns paginated transaction history for the authenticated lender.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { user } = await requireAuthenticatedUser("lender");
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

    const columns = {
      id: ledgerTransactions.id,
      category: ledgerTransactions.category,
      refType: ledgerTransactions.refType,
      refId: ledgerTransactions.refId,
      amount: ledgerTransactions.amount,
      currency: ledgerTransactions.currency,
      status: ledgerTransactions.status,
      metadata: ledgerTransactions.metadata,
      createdAt: ledgerTransactions.createdAt,
    };

    // The lender's own transactions with cursor-based pagination.
    const cursorDate = cursor ? new Date(cursor) : null;
    const cursorClause =
      cursorDate && !Number.isNaN(cursorDate.getTime())
        ? direction === "next"
          ? lt(ledgerTransactions.createdAt, cursorDate)
          : gt(ledgerTransactions.createdAt, cursorDate)
        : undefined;

    const userTxs = await db
      .select(columns)
      .from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.userId, user.id), cursorClause))
      .orderBy(desc(ledgerTransactions.createdAt))
      .limit(PAGE_SIZE + 1);

    const hasMore = userTxs.length > PAGE_SIZE;
    const items = userTxs.slice(0, PAGE_SIZE);

    // Incoming repayments are written by the borrower; the lender is
    // identified from the metadata the repayment route records.
    const allRepays = await db
      .select(columns)
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.refType, "loan_repay"))
      .orderBy(desc(ledgerTransactions.createdAt))
      .limit(200);

    const incomingRepays = allRepays.filter((tx) => {
      const meta = readMetadata(tx.metadata);
      return String(meta.lenderUserId) === user.id || String(meta.lenderAddress) === user.walletAddress;
    });

    // Merge and dedup
    const txMap = new Map<string, (typeof items)[number]>();
    for (const t of items) txMap.set(t.id, t);
    for (const t of incomingRepays) txMap.set(t.id, t);

    const transactions = Array.from(txMap.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    const formattedTransactions = transactions.map((tx) => {
      const meta = readMetadata(tx.metadata);
      const txHash = metaString(tx.metadata, "txHash");
      let subLabel = "";
      if (meta.loanId) subLabel = `Loan #${String(meta.loanId).slice(0, 8)}`;
      else if (tx.refId) subLabel = `Ref #${tx.refId.slice(0, 8)}`;

      let label = "Transaction";
      let type: "funding" | "repayment" | "deposit" | "withdrawal" = "funding";
      if (tx.refType === "loan_fund") {
        label = "P2P Loan Deployed";
        type = "funding";
      } else if (tx.refType === "loan_repay") {
        label = "Repayment Received";
        type = "repayment";
      } else if (tx.category === "deposit" || tx.category === "pool_deposit") {
        label = "Pool Deposit";
        type = "deposit";
      } else if (tx.category === "withdrawal" || tx.category === "pool_withdraw") {
        label = "Pool Withdrawal";
        type = "withdrawal";
      }

      return {
        id: tx.id,
        label,
        subLabel,
        amount: Number(tx.amount),
        currency: tx.currency || "XLM",
        date: tx.createdAt.toISOString(),
        status: tx.status || "completed",
        txHash,
        type,
      };
    });

    const nextCursor =
      formattedTransactions.length > 0 ? formattedTransactions[formattedTransactions.length - 1].date : undefined;

    return NextResponse.json({ transactions: formattedTransactions, hasMore, nextCursor });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof UnauthorizedError) {
      const unauthenticated = err.message === "Not authenticated";
      return NextResponse.json(
        { error: unauthenticated ? "Authentication required" : err.message },
        { status: unauthenticated ? 401 : 403 },
      );
    }
    console.error("Lender transactions fetch error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
