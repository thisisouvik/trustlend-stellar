import { NextRequest, NextResponse } from "next/server";
import { getServiceRoleClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const supabase = getServiceRoleClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database service unavailable" }, { status: 500 });
    }

    const { searchParams } = request.nextUrl;
    const status = searchParams.get("status");
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 10, 1), 100) : 10;

    let query = supabase
      .from("lending_pools")
      .select("id, name, description, status, apr_bps, total_liquidity, available_liquidity, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq("status", status);
    }

    const { data: pools, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, pools }, { status: 200 });
  } catch (_error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
