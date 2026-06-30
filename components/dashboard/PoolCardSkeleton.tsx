"use client";

import { motion } from "framer-motion";

// ──────────────────────────────────────────────────────────
// Reusable pulse-shimmer bar
// ──────────────────────────────────────────────────────────
function ShimmerBar({
  width = "100%",
  height = "0.85rem",
  className = "",
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return (
    <div
      className={`animate-pulse rounded-md bg-gray-200 dark:bg-white/10 ${className}`}
      style={{ width, height }}
    />
  );
}

// ──────────────────────────────────────────────────────────
// Single pool card skeleton
// ──────────────────────────────────────────────────────────
function PoolCardItem({ delay = 0 }: { delay?: number }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: "easeOut" }}
      style={{
        borderRadius: "0.95rem",
        border: "1px solid rgba(122, 138, 177, 0.18)",
        background: "var(--card-bg, #f9fbff)",
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.9rem",
      }}
    >
      {/* Header row: icon + name + status badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
          {/* Icon placeholder */}
          <div
            className="animate-pulse rounded-full bg-gray-200 dark:bg-white/10"
            style={{ width: "2.25rem", height: "2.25rem", flexShrink: 0 }}
          />
          {/* Pool name */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            <ShimmerBar width="9rem" height="0.85rem" />
            <ShimmerBar width="5rem" height="0.65rem" />
          </div>
        </div>
        {/* Status badge */}
        <ShimmerBar width="4rem" height="1.4rem" className="rounded-full!" />
      </div>

      {/* Divider */}
      <div
        className="animate-pulse"
        style={{ height: "1px", background: "rgba(122,138,177,0.15)" }}
      />

      {/* Stats grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "0.75rem",
        }}
      >
        {["APR", "Total Size", "Available"].map((label) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <ShimmerBar width="3.5rem" height="0.65rem" />
            <ShimmerBar width="5rem" height="0.88rem" />
          </div>
        ))}
      </div>

      {/* Footer: My stake + APR badge placeholder */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "0.1rem" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          <ShimmerBar width="4.5rem" height="0.65rem" />
          <ShimmerBar width="3rem" height="0.82rem" />
        </div>
        <ShimmerBar width="5rem" height="1.6rem" className="rounded-full!" />
      </div>
    </motion.article>
  );
}

// ──────────────────────────────────────────────────────────
// Stats row skeleton (matches the summary cards row)
// ──────────────────────────────────────────────────────────
function StatCardSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: "easeOut" }}
      className="workspace-card"
      style={{ display: "flex", flexDirection: "column", gap: "0.55rem", justifyContent: "center" }}
    >
      <ShimmerBar width="60%" height="0.65rem" />
      <ShimmerBar width="75%" height="1.4rem" />
      <ShimmerBar width="45%" height="0.6rem" />
    </motion.article>
  );
}

// ──────────────────────────────────────────────────────────
// Banner skeleton (matches the "Available to Invest" banner)
// ──────────────────────────────────────────────────────────
function BannerSkeleton() {
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      style={{
        borderRadius: "1rem",
        border: "1px solid rgba(34,207,157,0.2)",
        background: "linear-gradient(135deg, rgba(34,207,157,0.07) 0%, rgba(34,207,157,0.02) 100%)",
        padding: "1.5rem 2rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "1rem",
      }}
    >
      {/* Left: icon + label + balance */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <div
          className="animate-pulse rounded-full bg-gray-200 dark:bg-white/10"
          style={{ width: "3rem", height: "3rem", flexShrink: 0 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <ShimmerBar width="7rem" height="0.65rem" />
          <ShimmerBar width="11rem" height="1.75rem" />
          <ShimmerBar width="8rem" height="0.6rem" />
        </div>
      </div>
      {/* Right: 3 quick stats */}
      <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: "0.4rem", alignItems: "center" }}>
            <ShimmerBar width="5rem" height="0.6rem" />
            <ShimmerBar width="4rem" height="1rem" />
          </div>
        ))}
      </div>
    </motion.article>
  );
}

// ──────────────────────────────────────────────────────────
// Main exported skeleton component (Available Pools only)
// ──────────────────────────────────────────────────────────
export function PoolCardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading pools…">
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.25rem" }}>
        <ShimmerBar width="12rem" height="1.1rem" />
        <ShimmerBar width="3.5rem" height="1.4rem" className="rounded-full!" />
      </div>

      {/* Pool cards grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: "1rem",
        }}
      >
        {[0, 0.07, 0.14, 0.21].map((delay, i) => (
          <PoolCardItem key={i} delay={delay} />
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Full page skeleton for route loading
// ──────────────────────────────────────────────────────────
export function LenderPoolsPageSkeleton() {
  return (
    <div className="workspace-stack" aria-busy="true" aria-label="Loading pool data…">
      {/* Banner */}
      <section aria-label="Available to Invest">
        <BannerSkeleton />
      </section>

      {/* My positions summary + chart */}
      <section className="workspace-grid workspace-grid--two">
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {[0, 0.06, 0.12].map((delay, i) => (
            <StatCardSkeleton key={i} delay={delay} />
          ))}
        </div>

        {/* Chart placeholder */}
        <motion.article
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.1, ease: "easeOut" }}
          className="workspace-card"
          style={{ display: "flex", flexDirection: "column", gap: "0.85rem", padding: "2rem" }}
        >
          <ShimmerBar width="60%" height="0.7rem" />
          <div
            className="animate-pulse rounded-lg bg-gray-100 dark:bg-white/5"
            style={{ flex: 1, minHeight: "130px" }}
          />
        </motion.article>
      </section>

      {/* Available pools – card grid wrapper */}
      <article className="workspace-card workspace-card--full">
        <PoolCardSkeleton />
      </article>

      {/* Deposit / Withdraw forms + Positions list */}
      <section className="workspace-grid workspace-grid--two">
        {/* Forms card */}
        <motion.article
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.2, ease: "easeOut" }}
          className="workspace-card workspace-card--full"
          style={{ padding: "1.4rem" }}
        >
          <ShimmerBar width="9rem" height="0.9rem" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginTop: "1rem" }}>
            {[0, 1].map((i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <ShimmerBar width="6rem" height="0.7rem" />
                <ShimmerBar width="100%" height="2.25rem" />
                <ShimmerBar width="100%" height="2.25rem" />
                <ShimmerBar width="100%" height="2.5rem" className="rounded-lg!" />
              </div>
            ))}
          </div>
        </motion.article>

        {/* Positions list card */}
        <motion.article
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.25, ease: "easeOut" }}
          className="workspace-card"
        >
          <ShimmerBar width="7rem" height="0.9rem" />
          <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem", marginTop: "1rem" }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="animate-pulse"
                style={{
                  padding: "0.75rem",
                  borderRadius: "0.6rem",
                  background: "rgba(122,138,177,0.07)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.45rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <ShimmerBar width="7rem" height="0.75rem" />
                  <ShimmerBar width="3.5rem" height="1.2rem" className="rounded-full!" />
                </div>
                <div style={{ display: "flex", gap: "1.5rem" }}>
                  <ShimmerBar width="5rem" height="0.65rem" />
                  <ShimmerBar width="4rem" height="0.65rem" />
                </div>
              </div>
            ))}
          </div>
        </motion.article>
      </section>
    </div>
  );
}
