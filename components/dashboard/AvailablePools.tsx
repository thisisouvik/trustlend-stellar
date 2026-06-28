"use client";

/**
 * AvailablePools – Client Component
 *
 * Fetches available lending pools and the lender's positions from the
 * Supabase browser client *after* the page shell has rendered, so the
 * user immediately sees a polished skeleton instead of a blank screen.
 *
 * isLoading state conditionally renders <PoolCardSkeleton> while the
 * data is in-flight, and then transitions to the real pool cards via
 * Framer Motion once loaded.
 */

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/formatting";
import { PoolCardSkeleton } from "./PoolCardSkeleton";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface Pool {
  id: string;
  name: string;
  status: string;
  apr_bps: number;
  total_liquidity: number;
  available_liquidity: number;
}

interface Position {
  id: string;
  pool_id: string;
  status: string;
  principal_amount: number;
  earned_interest: number;
}

interface AvailablePoolsProps {
  /**
   * Optional server-side pre-fetched pools.
   * If supplied the component skips the client-side fetch and goes
   * straight to the rendered state (no skeleton flicker).
   */
  initialPools?: Pool[];
  /** Pre-fetched positions passed from the server component. */
  initialPositions?: Position[];
}

// ────────────────────────────────────────────────────────────────────────────
// Status badge
// ────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const isActive = status.toLowerCase() === "active";
  return (
    <span
      style={{
        padding: "0.2rem 0.65rem",
        borderRadius: "9999px",
        fontSize: "0.72rem",
        fontWeight: 700,
        letterSpacing: "0.04em",
        background: isActive ? "rgba(34,207,157,0.12)" : "rgba(255,107,107,0.12)",
        color: isActive ? "#22cf9d" : "#ff6b6b",
        textTransform: "uppercase",
      }}
    >
      {status}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Individual pool card
// ────────────────────────────────────────────────────────────────────────────

function PoolCard({
  pool,
  myPosition,
  index,
}: {
  pool: Pool;
  myPosition?: Position;
  index: number;
}) {
  const apr = (Number(pool.apr_bps ?? 0) / 100).toFixed(2);
  const totalSize = formatCurrency(Number(pool.total_liquidity ?? 0));
  const available = Number(pool.available_liquidity ?? 0).toFixed(2);

  return (
    <motion.article
      key={pool.id}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.07, ease: "easeOut" }}
      whileHover={{ y: -2, boxShadow: "0 8px 32px rgba(126,47,208,0.13)" }}
      style={{
        borderRadius: "0.95rem",
        border: myPosition
          ? "1px solid rgba(34,207,157,0.35)"
          : "1px solid rgba(122,138,177,0.22)",
        background: myPosition ? "rgba(34,207,157,0.04)" : "var(--card-bg, #f9fbff)",
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.9rem",
        cursor: "default",
        transition: "border-color 0.2s ease",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Decorative gradient orb for invested pools */}
      {myPosition && (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: "80px",
            height: "80px",
            background:
              "radial-gradient(circle, rgba(34,207,157,0.18) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
          <div
            style={{
              width: "2.25rem",
              height: "2.25rem",
              borderRadius: "50%",
              background: "linear-gradient(135deg, rgba(126,47,208,0.18), rgba(34,207,157,0.18))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.05rem",
              flexShrink: 0,
            }}
          >
            🏦
          </div>
          <div>
            <p style={{ fontWeight: 700, fontSize: "0.9rem", margin: 0, lineHeight: 1.2 }}>
              {pool.name}
            </p>
            <p style={{ fontSize: "0.72rem", opacity: 0.5, margin: "0.2rem 0 0", fontFamily: "monospace" }}>
              {String(pool.id).slice(0, 8)}
            </p>
          </div>
        </div>
        <StatusBadge status={pool.status} />
      </div>

      {/* Divider */}
      <div style={{ height: "1px", background: "rgba(122,138,177,0.12)" }} />

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
        {[
          { label: "APR", value: `${apr}%`, accent: "#22cf9d" },
          { label: "Total Size", value: totalSize, accent: undefined },
          { label: "Available", value: `${available} XLM`, accent: undefined },
        ].map(({ label, value, accent }) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <p
              style={{
                fontSize: "0.65rem",
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                opacity: 0.5,
                margin: 0,
              }}
            >
              {label}
            </p>
            <p
              style={{
                fontWeight: 700,
                fontSize: "0.88rem",
                color: accent ?? "inherit",
                margin: 0,
              }}
            >
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* Footer: my stake */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: "0.1rem",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          <p style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.07em", opacity: 0.5, margin: 0 }}>
            My Stake
          </p>
          {myPosition ? (
            <p style={{ fontWeight: 700, fontSize: "0.88rem", color: "#22cf9d", margin: 0 }}>
              {Number(myPosition.principal_amount ?? 0).toFixed(2)} XLM ✅
            </p>
          ) : (
            <p style={{ fontSize: "0.82rem", opacity: 0.4, margin: 0 }}>—</p>
          )}
        </div>

        {/* APR badge pill */}
        <div
          style={{
            background: "rgba(126,47,208,0.1)",
            border: "1px solid rgba(126,47,208,0.22)",
            borderRadius: "9999px",
            padding: "0.3rem 0.75rem",
            fontSize: "0.78rem",
            fontWeight: 700,
            color: "#7e2fd0",
          }}
        >
          {apr}% APR
        </div>
      </div>
    </motion.article>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Error state
// ────────────────────────────────────────────────────────────────────────────

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{
        padding: "1.5rem",
        borderRadius: "0.75rem",
        background: "rgba(255,107,107,0.07)",
        border: "1px solid rgba(255,107,107,0.2)",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        alignItems: "center",
      }}
    >
      <p style={{ fontSize: "0.88rem", color: "#ff6b6b", fontWeight: 600, margin: 0 }}>
        ⚠️ {message}
      </p>
      <button
        onClick={onRetry}
        style={{
          padding: "0.4rem 1.1rem",
          borderRadius: "0.6rem",
          background: "rgba(255,107,107,0.12)",
          border: "1px solid rgba(255,107,107,0.25)",
          color: "#ff6b6b",
          fontSize: "0.8rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </motion.div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

export function AvailablePools({ initialPools, initialPositions }: AvailablePoolsProps) {
  const [pools, setPools] = useState<Pool[]>(initialPools ?? []);
  const [positions, setPositions] = useState<Position[]>(initialPositions ?? []);

  // isLoading is true until we have confirmed data (or an error)
  const [isLoading, setIsLoading] = useState<boolean>(
    !initialPools || initialPools.length === 0
  );
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const supabase = getBrowserSupabaseClient();
      if (!supabase) throw new Error("Supabase client not initialised — check env vars.");

      const [poolsRes, positionsRes] = await Promise.all([
        supabase
          .from("lending_pools")
          .select("id, name, status, apr_bps, total_liquidity, available_liquidity")
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("pool_positions")
          .select("id, pool_id, status, principal_amount, earned_interest")
          .order("opened_at", { ascending: true }),
      ]);

      if (poolsRes.error) throw new Error(poolsRes.error.message);
      if (positionsRes.error) throw new Error(positionsRes.error.message);

      setPools(poolsRes.data ?? []);
      setPositions(positionsRes.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pools.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // If server already provided pools, skip the client fetch
    if (initialPools && initialPools.length > 0) {
      setIsLoading(false);
      return;
    }
    void fetchData();
  }, [initialPools, fetchData]);

  // ── Conditionally render skeleton while isLoading is true ──────────────
  if (isLoading) {
    return <PoolCardSkeleton />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={fetchData} />;
  }

  if (pools.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        style={{
          padding: "2.5rem",
          textAlign: "center",
          opacity: 0.55,
          border: "1px dashed rgba(122,138,177,0.3)",
          borderRadius: "0.95rem",
        }}
      >
        <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>No lending pools yet</p>
        <p style={{ fontSize: "0.85rem" }}>
          No lending pools have been created yet. Check back soon.
        </p>
      </motion.div>
    );
  }

  // ── Render pool cards once loaded ──────────────────────────────────────
  return (
    <AnimatePresence>
      <motion.section
        key="pools-grid"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        aria-label="Available lending pools"
      >
        {/* Section header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "1.25rem",
          }}
        >
          <h2 className="workspace-card-title" style={{ margin: 0 }}>
            Available Lending Pools
          </h2>
          <span
            style={{
              background: pools.some((p) =>
                positions.find((pos) => String(pos.pool_id) === String(p.id))
              )
                ? "rgba(34,207,157,0.12)"
                : "rgba(126,47,208,0.1)",
              color: pools.some((p) =>
                positions.find((pos) => String(pos.pool_id) === String(p.id))
              )
                ? "#22cf9d"
                : "#7e2fd0",
              borderRadius: "9999px",
              padding: "0.2rem 0.65rem",
              fontSize: "0.73rem",
              fontWeight: 700,
            }}
          >
            {pools.length} pool{pools.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Pool cards grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: "1rem",
          }}
        >
          {pools.map((pool, i) => {
            const myPosition = positions.find(
              (pos) => String(pos.pool_id) === String(pool.id)
            );
            return (
              <PoolCard key={pool.id} pool={pool} myPosition={myPosition} index={i} />
            );
          })}
        </div>
      </motion.section>
    </AnimatePresence>
  );
}
