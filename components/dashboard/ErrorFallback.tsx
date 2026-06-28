"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

interface ErrorFallbackProps {
  error?: Error | null;
  reset?: () => void;
  title?: string;
  description?: string;
}

export function ErrorFallback({
  error,
  reset,
  title = "Something went wrong",
  description = "An unexpected error occurred while rendering this page. Please try again.",
}: ErrorFallbackProps) {
  return (
    <main className="role-dashboard-shell">
      <section className="role-dashboard-card role-dashboard-card--wide">
        <div className="workspace-layout" style={{ gridTemplateColumns: "1fr" }}>
          <div className="workspace-main-panel" style={{ textAlign: "center", padding: "4rem 2rem" }}>
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: "999px",
                margin: "0 auto 1.5rem",
                background:
                  "radial-gradient(circle at 28% 24%, rgba(255,255,255,0.95), rgba(255,255,255,0) 35%), linear-gradient(145deg, #7f2fd1, #2dd39f)",
                boxShadow: "0 10px 18px rgba(95, 48, 174, 0.32)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "2rem",
              }}
            >
              !
            </div>

            <h1
              className="font-display"
              style={{
                margin: 0,
                fontSize: "clamp(1.5rem, 3vw, 2rem)",
                color: "#24285a",
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
            >
              {title}
            </h1>

            <p
              style={{
                margin: "0.75rem auto 0",
                maxWidth: 420,
                color: "#5f6888",
                fontSize: "0.9rem",
                lineHeight: 1.6,
              }}
            >
              {description}
            </p>

            {error && (
              <p
                style={{
                  margin: "1rem auto 0",
                  maxWidth: 500,
                  padding: "0.75rem 1rem",
                  borderRadius: "0.75rem",
                  background: "rgba(255,107,107,0.08)",
                  border: "1px solid rgba(255,107,107,0.2)",
                  color: "#cc3344",
                  fontSize: "0.78rem",
                  fontFamily: "monospace",
                  textAlign: "left",
                  overflow: "auto",
                  maxHeight: 120,
                }}
              >
                {error.message}
              </p>
            )}

            <div style={{ marginTop: "2rem", display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
              {reset && (
                <Button onClick={reset}>
                  Try Again
                </Button>
              )}
              <Link href="/dashboard">
                <Button variant="outline">
                  Back to Dashboard
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
