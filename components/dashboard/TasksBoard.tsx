"use client";

import { useState, useTransition } from "react";

interface PlatformTask {
  id: string;
  title: string;
  description: string;
  category: string;
  points: number;
  difficulty: string;
  cta: string;
  learnUrl: string | null;
  completed: boolean;
}

interface TaskCardProps {
  task: PlatformTask;
  onComplete: (taskId: string) => Promise<{ error?: string }>;
}

function DifficultyPill({ level }: { level: string }) {
  const color = level === "Easy" ? "#22cf9d" : level === "Medium" ? "#f5a623" : "#ff6b6b";
  return (
    <span style={{
      fontSize: "0.72rem", fontWeight: 700, padding: "0.15rem 0.5rem",
      borderRadius: "9999px", background: `${color}18`, color,
      border: `1px solid ${color}33`, letterSpacing: "0.04em",
    }}>
      {level}
    </span>
  );
}

function TaskCard({ task, onComplete }: TaskCardProps) {
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(task.completed);
  const [error, setError] = useState<string | null>(null);

  const handleComplete = () => {
    startTransition(async () => {
      setError(null);
      const res = await onComplete(task.id);
      if (res.error) {
        setError(res.error);
      } else {
        setDone(true);
      }
    });
  };

  return (
    <article
      className="workspace-card"
      style={{
        border: done
          ? "1px solid rgba(34,207,157,0.35)"
          : "1px solid rgba(255,255,255,0.07)",
        opacity: done ? 0.75 : 1,
        transition: "border-color 0.3s, opacity 0.3s",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Top-left accent bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, width: "3px",
        height: "100%", background: done ? "#22cf9d" : "#7e2fd0", borderRadius: "9999px 0 0 9999px",
      }} />

      <div style={{ paddingLeft: "0.5rem" }}>
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.6rem", gap: "0.5rem" }}>
          <span style={{
            fontSize: "0.72rem", fontWeight: 600, padding: "0.15rem 0.5rem",
            borderRadius: "9999px", background: "rgba(126,47,208,0.12)",
            color: "#9b6fe0", letterSpacing: "0.04em",
          }}>
            {task.category}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            <DifficultyPill level={task.difficulty} />
            <span style={{
              fontSize: "0.78rem", fontWeight: 700, color: "#f5a623",
              background: "rgba(245,166,35,0.1)", borderRadius: "9999px",
              padding: "0.15rem 0.5rem",
            }}>
              +{task.points} pts
            </span>
          </div>
        </div>

        <h2 className="workspace-card-title" style={{ marginBottom: "0.5rem" }}>
          {done ? "✅ " : "📘 "}{task.title}
        </h2>
        <p className="workspace-card-copy" style={{ fontSize: "0.85rem", opacity: 0.7, lineHeight: 1.55, marginBottom: "1rem" }}>
          {task.description}
        </p>

        {/* Learn link */}
        {task.learnUrl && !done && (
          <a
            href={task.learnUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block", marginBottom: "0.85rem",
              fontSize: "0.82rem", color: "#9b6fe0", textDecoration: "underline",
            }}
          >
            Read the guide ↗
          </a>
        )}

        {error && (
          <p style={{ fontSize: "0.8rem", color: "#ff6b6b", marginBottom: "0.5rem" }}>
            {error}
          </p>
        )}

        {done ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#22cf9d", fontSize: "0.85rem", fontWeight: 600 }}>
            <span>✅</span>
            <span>Completed — +{task.points} trust points awarded</span>
          </div>
        ) : (
          <button
            onClick={handleComplete}
            disabled={isPending}
            className="workspace-button workspace-button--primary"
            style={{ fontSize: "0.85rem", padding: "0.5rem 1.25rem" }}
          >
            {isPending ? "Saving…" : task.cta}
          </button>
        )}
      </div>
    </article>
  );
}

interface TasksBoardProps {
  tasks: PlatformTask[];
  currentScore: number;
}

export function TasksBoard({ tasks, currentScore }: TasksBoardProps) {
  const [localScore, setLocalScore] = useState(currentScore);
  const completedCount = tasks.filter((t) => t.completed).length;

  const handleComplete = async (taskId: string): Promise<{ error?: string }> => {
    const res = await fetch("/api/tasks/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    const json = await res.json() as { pointsAwarded?: number; error?: string };
    if (!res.ok) return { error: json.error ?? "Failed to complete task" };
    if (json.pointsAwarded) {
      setLocalScore((s) => Math.min(750, s + json.pointsAwarded!));
    }
    return {};
  };

  return (
    <div>
      {/* Score progress banner */}
      <div
        style={{
          background: "linear-gradient(135deg, rgba(126,47,208,0.15) 0%, rgba(34,207,157,0.1) 100%)",
          border: "1px solid rgba(126,47,208,0.2)",
          borderRadius: "0.85rem",
          padding: "1.25rem 1.5rem",
          marginBottom: "1.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <p style={{ fontSize: "0.78rem", opacity: 0.55, marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Current Trust Score
          </p>
          <p style={{ fontSize: "2rem", fontWeight: 800, color: localScore >= 200 ? "#22cf9d" : localScore >= 100 ? "#f5a623" : "#ff6b6b", lineHeight: 1 }}>
            {localScore} <span style={{ fontSize: "0.9rem", opacity: 0.4 }}>/ 750</span>
          </p>
        </div>
        <div style={{ flex: 1, maxWidth: "320px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", opacity: 0.55, marginBottom: "0.35rem" }}>
            <span>{completedCount}/{tasks.length} tasks done</span>
            <span>{Math.round((localScore / 750) * 100)}% to max</span>
          </div>
          <div style={{ height: "7px", borderRadius: "9999px", background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${Math.min(100, (localScore / 750) * 100)}%`,
              background: "linear-gradient(90deg, #7e2fd0, #22cf9d)",
              borderRadius: "9999px",
              transition: "width 0.5s ease",
            }} />
          </div>
          <p style={{ fontSize: "0.73rem", opacity: 0.4, marginTop: "0.3rem" }}>
            KYC verified • task completion • loan repayment all increase your score
          </p>
        </div>
      </div>

      {/* Task cards grid */}
      <div className="workspace-stack">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onComplete={handleComplete} />
        ))}
      </div>
    </div>
  );
}
