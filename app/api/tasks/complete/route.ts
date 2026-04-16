import { NextRequest, NextResponse } from "next/server";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/tasks/complete
 * Marks a platform task as completed and awards trust score points.
 *
 * Body: { taskId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { taskId } = await request.json() as { taskId: string };
    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    // Find the platform task definition
    const PLATFORM_TASKS = getPlatformTasks();
    const task = PLATFORM_TASKS.find((t) => t.id === taskId);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Check if already completed (prevent double-claiming)
    const { data: existing } = await supabase
      .from("reputation_events")
      .select("id")
      .eq("user_id", user.id)
      .eq("source_type", "task_completion")
      .eq("source_id", taskId)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: "Task already completed. Each task can only be claimed once." },
        { status: 409 }
      );
    }

    // Record reputation event
    const { error: eventErr } = await supabase
      .from("reputation_events")
      .insert({
        user_id:     user.id,
        source_type: "task_completion",
        source_id:   taskId,
        points_delta: task.points,
        reason:      `Completed: ${task.title}`,
      });

    if (eventErr) {
      return NextResponse.json({ error: eventErr.message }, { status: 500 });
    }

    // Update (upsert) the reputation snapshot using service role
    const sr = getServiceRoleClient();
    if (sr) {
      // Get current snapshot
      const { data: snap } = await sr
        .from("reputation_snapshots")
        .select("score_total")
        .eq("user_id", user.id)
        .maybeSingle();

      const currentScore = snap?.score_total ?? 250;
      const newScore = Math.min(750, Math.max(0, currentScore + task.points));

      await sr.from("reputation_snapshots").upsert({
        user_id:     user.id,
        score_total: newScore,
        updated_at:  new Date().toISOString(),
      });
    }

    return NextResponse.json({
      taskId,
      pointsAwarded: task.points,
      message: `+${task.points} trust points awarded for completing "${task.title}"`,
    });
  } catch (err) {
    console.error("Task complete error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Canonical list of platform tasks. Server-side source of truth. */
export function getPlatformTasks() {
  return [
    {
      id:         "task_stellar_basics",
      title:      "Learn: How Stellar Payments Work",
      description:
        "Read TrustLend's guide on how Stellar (XLM) enables fast, low-cost cross-border payments " +
        "and how it's used to fund and repay loans on this platform.",
      category:   "Financial Literacy",
      points:     30,
      difficulty: "Easy",
      cta:        "Mark as Read",
      learnUrl:   "https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts",
    },
    {
      id:         "task_credit_score",
      title:      "Learn: How Your Trust Score Is Calculated",
      description:
        "Understand the 5 factors that build your TrustLend trust score: KYC verification, " +
        "on-time repayment, task completion, account age, and transaction history.",
      category:   "Platform Knowledge",
      points:     25,
      difficulty: "Easy",
      cta:        "I've Read This",
      learnUrl:   null, // inline content shown in UI
    },
    {
      id:         "task_defi_lending",
      title:      "Learn: DeFi Lending vs Traditional Banking",
      description:
        "Explore the key differences between decentralised P2P lending (like TrustLend) and " +
        "traditional bank loans — including how interest, collateral, and transparency work on-chain.",
      category:   "Financial Literacy",
      points:     35,
      difficulty: "Medium",
      cta:        "Mark as Completed",
      learnUrl:   "https://stellar.org/learn/the-basics",
    },
  ] as const;
}
