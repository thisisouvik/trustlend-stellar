"use server";

import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseClient } from "@/lib/supabase/server";

function getServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireAdmin() {
  const supabase = await getServerSupabaseClient();
  if (!supabase) throw new Error("Database unavailable");

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Not authenticated");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role !== "admin") throw new Error("Unauthorized: Admin only");

  return { user, supabase };
}

// ── Create a new lending pool ──────────────────────────────────────────────────
export async function createLendingPool(formData: FormData): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin();
    const admin = getServiceRoleClient();
    if (!admin) return { success: false, error: "Service client unavailable" };

    const name = String(formData.get("name") ?? "").trim();
    const aprBps = parseInt(String(formData.get("apr_bps") ?? "0"), 10);
    const description = String(formData.get("description") ?? "").trim();

    if (!name) return { success: false, error: "Pool name is required" };
    if (!aprBps || aprBps <= 0 || aprBps > 10000)
      return { success: false, error: "APR must be between 0.01% and 100%" };

    const { error } = await admin.from("lending_pools").insert({
      name,
      description: description || null,
      status: "active",
      apr_bps: aprBps,
      total_liquidity: 0,
      available_liquidity: 0,
    });

    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed" };
  }
}

// ── Toggle pool active/paused ──────────────────────────────────────────────────
export async function togglePoolStatus(
  poolId: string,
  newStatus: "active" | "paused"
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin();
    const admin = getServiceRoleClient();
    if (!admin) return { success: false, error: "Service client unavailable" };

    const { error } = await admin
      .from("lending_pools")
      .update({ status: newStatus })
      .eq("id", poolId);

    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed" };
  }
}

// ── Approve a pending loan and link to pool ────────────────────────────────────
export async function approveLoan(
  loanId: string,
  poolId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin();
    const admin = getServiceRoleClient();
    if (!admin) return { success: false, error: "Service client unavailable" };

    // Fetch loan to validate
    const { data: loan, error: fetchErr } = await admin
      .from("loans")
      .select("id, status, principal_amount, pool_id")
      .eq("id", loanId)
      .maybeSingle();

    if (fetchErr || !loan) return { success: false, error: "Loan not found" };
    if (loan.status !== "requested")
      return { success: false, error: `Loan is already ${loan.status}` };

    // Fetch pool to check liquidity
    const { data: pool } = await admin
      .from("lending_pools")
      .select("id, available_liquidity, status")
      .eq("id", poolId)
      .maybeSingle();

    if (!pool) return { success: false, error: "Pool not found" };
    if (pool.status !== "active") return { success: false, error: "Pool is not active" };

    const loanAmount = Number(loan.principal_amount ?? 0);
    const available = Number(pool.available_liquidity ?? 0);

    if (loanAmount > available) {
      return {
        success: false,
        error: `Insufficient pool liquidity: need ${loanAmount} XLM, pool has ${available} XLM`,
      };
    }

    const now = new Date().toISOString();

    // 1. Approve loan
    const { error: loanErr } = await admin
      .from("loans")
      .update({
        status: "approved",
        pool_id: poolId,
        approved_at: now,
      })
      .eq("id", loanId);

    if (loanErr) return { success: false, error: loanErr.message };

    // 2. Deduct available liquidity from pool
    const { error: poolErr } = await admin
      .from("lending_pools")
      .update({ available_liquidity: available - loanAmount })
      .eq("id", poolId);

    if (poolErr) return { success: false, error: poolErr.message };

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed" };
  }
}

// ── Run auto-matching: fund all pending loans that pools can cover ─────────────
export async function runAutoMatch(): Promise<{
  success: boolean;
  matched: number;
  skipped: number;
  error?: string;
}> {
  try {
    await requireAdmin();
    const admin = getServiceRoleClient();
    if (!admin) return { success: false, matched: 0, skipped: 0, error: "Service client unavailable" };

    // Get all pending loans ordered by creation (oldest first)
    const { data: pendingLoans } = await admin
      .from("loans")
      .select("id, principal_amount, pool_id")
      .eq("status", "requested")
      .order("requested_at", { ascending: true });

    // Get all active pools with liquidity
    const { data: activePools } = await admin
      .from("lending_pools")
      .select("id, available_liquidity")
      .eq("status", "active")
      .gt("available_liquidity", 0)
      .order("available_liquidity", { ascending: false });

    if (!pendingLoans || pendingLoans.length === 0) {
      return { success: true, matched: 0, skipped: 0 };
    }

    if (!activePools || activePools.length === 0) {
      return { success: true, matched: 0, skipped: pendingLoans.length };
    }

    // Mutable pool liquidity map
    const poolLiquidity = new Map<string, number>(
      activePools.map((p) => [String(p.id), Number(p.available_liquidity ?? 0)])
    );

    let matched = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    for (const loan of pendingLoans) {
      const amount = Number(loan.principal_amount ?? 0);

      // Find a pool with enough liquidity (prefer the assigned pool if any)
      let targetPoolId: string | null = null;
      const assignedPool = loan.pool_id ? String(loan.pool_id) : null;

      if (assignedPool && (poolLiquidity.get(assignedPool) ?? 0) >= amount) {
        targetPoolId = assignedPool;
      } else {
        // Pick the pool with most liquidity that covers the loan
        for (const [poolId, liquidity] of poolLiquidity) {
          if (liquidity >= amount) {
            targetPoolId = poolId;
            break;
          }
        }
      }

      if (!targetPoolId) {
        skipped++;
        continue;
      }

      // Approve and deduct
      const [loanResult, poolResult] = await Promise.all([
        admin.from("loans").update({ status: "approved", pool_id: targetPoolId, approved_at: now }).eq("id", loan.id),
        admin.from("lending_pools").update({ available_liquidity: (poolLiquidity.get(targetPoolId) ?? 0) - amount }).eq("id", targetPoolId),
      ]);

      if (loanResult.error || poolResult.error) {
        skipped++;
      } else {
        poolLiquidity.set(targetPoolId, (poolLiquidity.get(targetPoolId) ?? 0) - amount);
        matched++;
      }
    }

    return { success: true, matched, skipped };
  } catch (err) {
    return {
      success: false,
      matched: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : "Auto-match failed",
    };
  }
}
