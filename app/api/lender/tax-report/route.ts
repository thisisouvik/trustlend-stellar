import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth/session";
import { getDb, type Db } from "@/lib/db/client";
import { lendingPools, poolPositions, profiles } from "@/lib/db/schema";
import { getLenderTaxReportData } from "@/lib/lender/tax-report-data";
import {
  buildTaxReportRows,
  summarizeTaxReport,
  toCsv,
  taxReportFilename,
} from "@/lib/lender/tax-report";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { parseBoundedInteger } from "@/lib/http/request-validation";

export const runtime = "nodejs";

function formatXlm(value: number | string | null | undefined) {
  return `${Number(value ?? 0).toFixed(2)} XLM`;
}

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { searchParams } = new URL(request.url);
    const yearStr = searchParams.get("year");
    const format = (searchParams.get("format") ?? "pdf").toLowerCase();

    // `year=all` lifts the filter; anything unparseable falls back to this year.
    const isAllYears = yearStr === "all";
    const parsedYearValue = parseBoundedInteger(yearStr, new Date().getFullYear(), 2000, 2100);
    if (!isAllYears && parsedYearValue === null) {
      return NextResponse.json({ error: "Invalid tax year" }, { status: 400 });
    }
    if (format !== "pdf" && format !== "csv") {
      return NextResponse.json({ error: "Invalid report format" }, { status: 400 });
    }
    const year =
      isAllYears
        ? null
        : parsedYearValue;

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (format === "csv") {
      return await buildCsvResponse(db, user.id, {
        walletAddress: user.walletAddress || null,
        year,
      });
    }

    // ── PDF summary (original behaviour) ─────────────────────────────────────
    const pdfYear = year ?? new Date().getFullYear();

    const [[profile], positions] = await Promise.all([
      db.select({ fullName: profiles.fullName }).from(profiles).where(eq(profiles.id, user.id)).limit(1),
      db
        .select({
          id: poolPositions.id,
          principal_amount: poolPositions.principalAmount,
          earned_interest: poolPositions.earnedInterest,
          opened_at: poolPositions.openedAt,
          closed_at: poolPositions.closedAt,
          status: poolPositions.status,
          pool_name: lendingPools.name,
        })
        .from(poolPositions)
        .leftJoin(lendingPools, eq(lendingPools.id, poolPositions.poolId))
        .where(eq(poolPositions.lenderId, user.id)),
    ]);

    // Filter positions active or closed in the given year
    const yearPositions = positions.filter((pos) => {
      const openedAt = pos.opened_at;
      const closedAt = pos.closed_at ?? new Date();
      return openedAt.getFullYear() <= pdfYear && closedAt.getFullYear() >= pdfYear;
    });

    const totalInterest = yearPositions.reduce((acc, pos) => acc + Number(pos.earned_interest ?? 0), 0);
    const totalPrincipal = yearPositions.reduce((acc, pos) => acc + Number(pos.principal_amount ?? 0), 0);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    const pdfBufferPromise = new Promise<Buffer>((resolve, reject) => {
      doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    try {
      const logoPath = path.join(process.cwd(), "public", "logo.png");
      const logo = await fs.readFile(logoPath);
      doc.image(logo, 50, 42, { width: 68 });
    } catch {
      // Logo is optional
    }

    doc
      .fillColor("#3f2a69")
      .fontSize(22)
      .text(`TrustLend Tax Report - ${pdfYear}`, 135, 50)
      .fillColor("#6b7280")
      .fontSize(10)
      .text("Annual summary of lender earnings and yield", 135, 78);

    doc
      .moveTo(50, 112)
      .lineTo(545, 112)
      .strokeColor("#e5e7eb")
      .stroke();

    doc.fillColor("#111827").fontSize(12);

    const lenderName = profile?.fullName || user.fullName || "TrustLend Lender";

    const summaryRows = [
      ["Report generated", new Date().toLocaleString("en-US")],
      ["Lender name", lenderName],
      ["Lender ID", user.id],
      ["Tax Year", String(pdfYear)],
      ["Total Principal Deployed", formatXlm(totalPrincipal)],
      ["Total Interest Earned", formatXlm(totalInterest)],
    ];

    let y = 130;
    for (const [label, value] of summaryRows) {
      doc
        .fillColor("#6b7280")
        .fontSize(10)
        .text(label, 50, y, { width: 160 })
        .fillColor("#111827")
        .fontSize(11)
        .text(value, 220, y, { width: 290 });
      y += 22;
    }

    y += 10;
    doc
      .fillColor("#3f2a69")
      .fontSize(14)
      .text("Position Details", 50, y);

    y += 26;
    doc
      .fillColor("#6b7280")
      .fontSize(10)
      .text("Pool Name", 50, y, { width: 150 })
      .text("Principal", 210, y, { width: 110 })
      .text("Earned Interest", 330, y, { width: 110, align: "right" })
      .text("Status", 450, y, { width: 80, align: "right" });

    y += 14;
    doc
      .moveTo(50, y)
      .lineTo(545, y)
      .strokeColor("#d1d5db")
      .stroke();

    y += 10;
    yearPositions.forEach((pos) => {
      if (y > 730) {
        doc.addPage();
        y = 60;
      }
      
      const poolName = pos.pool_name ?? "Unknown Pool";

      doc
        .fillColor("#111827")
        .fontSize(10)
        .text(poolName, 50, y, { width: 150 })
        .text(formatXlm(pos.principal_amount as string | number), 210, y, { width: 110 })
        .text(formatXlm(pos.earned_interest as string | number), 330, y, { width: 110, align: "right" })
        .text(String(pos.status), 450, y, { width: 80, align: "right" });
      y += 22;
    });

    doc
      .fillColor("#6b7280")
      .fontSize(9)
      .text(
        "This report is generated by TrustLend for informational purposes only and does not constitute official tax advice.",
        50,
        760,
        { width: 495, align: "center" }
      );

    doc.end();
    const pdf = await pdfBufferPromise;

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="trustlend-tax-report-${pdfYear}.pdf"`,
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("Tax report generation error:", error);
    return NextResponse.json({ error: "Failed to generate report" }, { status: 500 });
  }
}

/**
 * Per-event interest-income CSV (Issue #271).
 *
 * Covers both income sources — pool interest and directly funded marketplace
 * loans — where the PDF summary only ever reported pool positions.
 */
async function buildCsvResponse(
  db: Db,
  userId: string,
  { walletAddress, year }: { walletAddress: string | null; year: number | null }
) {
  const data = await getLenderTaxReportData(db, userId, walletAddress);
  const rows = buildTaxReportRows({ ...data, year });
  const summary = summarizeTaxReport(rows);
  const csv = toCsv(rows);
  const filename = taxReportFilename(year);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      // Surfaced so the client can tell the user what it just downloaded
      // without having to parse the file back.
      "X-Report-Rows": String(summary.rowCount),
      "X-Report-Total-Interest": String(summary.totalInterest),
      "X-Report-P2P-Included": "true",
    },
  });
}
