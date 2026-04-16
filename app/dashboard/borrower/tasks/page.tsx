import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { TasksBoard } from "@/components/dashboard/TasksBoard";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getBorrowerDashboardMetrics, presentBorrowerMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { getPlatformTasks } from "@/app/api/tasks/complete/route";

export default async function BorrowerTasksPage() {
  const { user } = await requireAuthenticatedUser("borrower");
  const metrics = await getBorrowerDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  const [profileRes, completedEventsRes, snapshotRes] = supabase
    ? await Promise.all([
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
        // Which tasks has this user already completed?
        supabase
          .from("reputation_events")
          .select("source_id")
          .eq("user_id", user.id)
          .eq("source_type", "task_completion"),
        // Current trust score
        srClient
          ? srClient
              .from("reputation_snapshots")
              .select("score_total")
              .eq("user_id", user.id)
              .maybeSingle()
          : supabase
              .from("reputation_snapshots")
              .select("score_total")
              .eq("user_id", user.id)
              .maybeSingle(),
      ])
    : [{ data: null }, { data: [] }, { data: null }];

  const profile          = profileRes.data;
  const completedTaskIds = new Set((completedEventsRes.data ?? []).map((e) => String(e.source_id)));
  const currentScore     = snapshotRes.data?.score_total ?? 250;

  // Merge completion status into the canonical task list
  const platformTasks = getPlatformTasks().map((t) => ({
    ...t,
    learnUrl:  t.learnUrl ?? null,
    completed: completedTaskIds.has(t.id),
  }));

  return (
    <WorkspaceFrame
      roleLabel="Borrower Dashboard"
      heading="Trust Tasks"
      description="Complete these tasks to build your trust score. Higher score = better loan terms and higher limits."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentBorrowerMetrics(metrics)}
      currentPath="/dashboard/borrower/tasks"
      links={[
        { href: "/dashboard/borrower",         label: "Home" },
        { href: "/dashboard/borrower/loans",   label: "Apply for Loan" },
        { href: "/dashboard/borrower/repay",   label: "Repay Loan" },
        { href: "/dashboard/borrower/tasks",   label: "Trust Tasks" },
        { href: "/dashboard/borrower/profile", label: "Profile & Settings" },
      ]}
    >
      <div className="workspace-stack">
        {/* How the score works */}
        <article
          className="workspace-card workspace-card--full"
          style={{ background: "rgba(126,47,208,0.05)", border: "1px solid rgba(126,47,208,0.15)" }}
        >
          <h2 className="workspace-card-title">How Your Trust Score Works</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "1rem",
              marginTop: "0.75rem",
            }}
          >
            {[
              { icon: "🪪", event: "KYC Verified",       pts: "+50–110",  note: "One-time, on admin approval" },
              { icon: "📘", event: "Task Completed",     pts: "+25–35",   note: "Up to 90 pts from all tasks" },
              { icon: "💸", event: "Loan Repaid",        pts: "+20",      note: "Per full repayment" },
              { icon: "⚡", event: "Partial Repayment",  pts: "+5",       note: "Per payment made" },
            ].map((row) => (
              <div
                key={row.event}
                style={{
                  display: "flex", gap: "0.65rem", alignItems: "flex-start",
                  padding: "0.75rem", borderRadius: "0.6rem",
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <span style={{ fontSize: "1.4rem" }}>{row.icon}</span>
                <div>
                  <p style={{ fontWeight: 600, fontSize: "0.86rem", marginBottom: "0.2rem" }}>{row.event}</p>
                  <p style={{ fontSize: "0.82rem", color: "#22cf9d", fontWeight: 700 }}>{row.pts} pts</p>
                  <p style={{ fontSize: "0.75rem", opacity: 0.5 }}>{row.note}</p>
                </div>
              </div>
            ))}
          </div>
        </article>

        {/* Interactive tasks board */}
        <TasksBoard tasks={platformTasks} currentScore={currentScore} />
      </div>
    </WorkspaceFrame>
  );
}
