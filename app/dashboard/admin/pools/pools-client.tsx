"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createLendingPool,
  togglePoolStatus,
  approveLoan,
  runAutoMatch,
} from "@/app/actions/admin-pools";

interface Pool {
  id: string;
  name: string;
  description: string | null;
  status: string;
  apr_bps: number;
  total_liquidity: number;
  available_liquidity: number;
}

interface Loan {
  id: string;
  status: string;
  principal_amount: number;
  apr_bps: number;
  duration_days: number;
  requested_at: string;
  borrower_profile: { full_name: string | null } | null;
}

interface AdminPoolsClientProps {
  pools: Pool[];
  pendingLoans: Loan[];
}

// ── Create Pool Form ────────────────────────────────────────────────────────────
function CreatePoolForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMsg(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createLendingPool(formData);
      if (result.success) {
        setMsg({ ok: true, text: "✅ Pool created successfully!" });
        setTimeout(() => {
          setOpen(false);
          setMsg(null);
          onCreated();
        }, 1200);
      } else {
        setMsg({ ok: false, text: `❌ ${result.error}` });
      }
    });
  };

  return (
    <div>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="workspace-button workspace-button--primary"
          style={{ marginBottom: "1rem" }}
        >
          + Create New Pool
        </button>
      ) : (
        <div
          style={{
            padding: "1.5rem",
            border: "1px solid rgba(126, 47, 208, 0.3)",
            borderRadius: "0.75rem",
            background: "rgba(126, 47, 208, 0.04)",
            marginBottom: "1.5rem",
          }}
        >
          <h3 className="workspace-card-title" style={{ marginBottom: "1rem" }}>
            New Lending Pool
          </h3>
          <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.75rem" }}>
            <div>
              <label className="workspace-label">Pool Name *</label>
              <input
                name="name"
                type="text"
                required
                placeholder="e.g. TrustLend Alpha Pool"
                className="workspace-input"
              />
            </div>
            <div>
              <label className="workspace-label">Description</label>
              <input
                name="description"
                type="text"
                placeholder="Short description for lenders"
                className="workspace-input"
              />
            </div>
            <div>
              <label className="workspace-label">APR (basis points) *</label>
              <input
                name="apr_bps"
                type="number"
                required
                min={10}
                max={10000}
                defaultValue={1500}
                className="workspace-input"
                onWheel={(e) => (e.target as HTMLInputElement).blur()}
              />
              <p className="workspace-hint">1500 = 15.00% APR</p>
            </div>

            {msg && (
              <p style={{ color: msg.ok ? "#22cf9d" : "#ff6b6b", fontSize: "0.875rem" }}>
                {msg.text}
              </p>
            )}

            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button
                type="submit"
                disabled={pending}
                className="workspace-button workspace-button--primary"
                style={{ flex: 1 }}
              >
                {pending ? "Creating..." : "Create Pool"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="workspace-button workspace-button--secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Pool Row ────────────────────────────────────────────────────────────────────
function PoolRow({ pool, onChanged }: { pool: Pool; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");

  const handleToggle = () => {
    const next = pool.status === "active" ? "paused" : "active";
    startTransition(async () => {
      const result = await togglePoolStatus(pool.id, next);
      if (result.success) onChanged();
      else setMsg(result.error ?? "Failed");
    });
  };

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{pool.name}</div>
        {pool.description && (
          <div style={{ fontSize: "0.78rem", opacity: 0.6 }}>{pool.description}</div>
        )}
      </td>
      <td>
        <span
          style={{
            padding: "0.2rem 0.6rem",
            borderRadius: "9999px",
            fontSize: "0.75rem",
            fontWeight: 600,
            background: pool.status === "active" ? "rgba(34,207,157,0.12)" : "rgba(255,107,107,0.12)",
            color: pool.status === "active" ? "#22cf9d" : "#ff6b6b",
          }}
        >
          {pool.status.toUpperCase()}
        </span>
      </td>
      <td>{(pool.apr_bps / 100).toFixed(2)}%</td>
      <td>{Number(pool.total_liquidity).toFixed(2)} XLM</td>
      <td>{Number(pool.available_liquidity).toFixed(2)} XLM</td>
      <td>
        <button
          onClick={handleToggle}
          disabled={pending}
          className="workspace-button workspace-button--secondary"
          style={{ fontSize: "0.75rem", padding: "0.35rem 0.7rem", height: "auto" }}
        >
          {pending ? "..." : pool.status === "active" ? "Pause" : "Activate"}
        </button>
        {msg && <p style={{ color: "#ff6b6b", fontSize: "0.72rem", marginTop: "0.2rem" }}>{msg}</p>}
      </td>
    </tr>
  );
}

// ── Pending Loan Row ────────────────────────────────────────────────────────────
function LoanRow({ loan, pools, onApproved }: { loan: Loan; pools: Pool[]; onApproved: () => void }) {
  const [selectedPool, setSelectedPool] = useState(pools[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState("");

  const activePools = pools.filter((p) => p.status === "active");

  const handleApprove = () => {
    if (!selectedPool) return;
    startTransition(async () => {
      const result = await approveLoan(loan.id, selectedPool);
      if (result.success) {
        setMsg("✅ Approved");
        setTimeout(onApproved, 800);
      } else {
        setMsg(`❌ ${result.error}`);
      }
    });
  };

  return (
    <tr>
      <td style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>{String(loan.id).slice(0, 8)}</td>
      <td>{loan.borrower_profile?.full_name ?? "—"}</td>
      <td>{Number(loan.principal_amount).toFixed(2)} XLM</td>
      <td>{(loan.apr_bps / 100).toFixed(2)}%</td>
      <td>{loan.duration_days}d</td>
      <td>
        {msg ? (
          <span style={{ fontSize: "0.82rem", color: msg.startsWith("✅") ? "#22cf9d" : "#ff6b6b" }}>
            {msg}
          </span>
        ) : (
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <select
              value={selectedPool}
              onChange={(e) => setSelectedPool(e.target.value)}
              className="workspace-input"
              style={{ padding: "0.3rem 0.5rem", fontSize: "0.8rem", height: "auto" }}
            >
              {activePools.length === 0 ? (
                <option value="">No active pools</option>
              ) : (
                activePools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({Number(p.available_liquidity).toFixed(0)} XLM available)
                  </option>
                ))
              )}
            </select>
            <button
              onClick={handleApprove}
              disabled={pending || !selectedPool || activePools.length === 0}
              className="workspace-button workspace-button--primary"
              style={{ fontSize: "0.75rem", padding: "0.35rem 0.7rem", height: "auto", whiteSpace: "nowrap" }}
            >
              {pending ? "..." : "Approve"}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ── Auto-Match Banner ───────────────────────────────────────────────────────────
function AutoMatchBar({ pendingCount, onDone }: { pendingCount: number; onDone: () => void }) {
  const [result, setResult] = useState<{ matched: number; skipped: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const handleRun = () => {
    setResult(null);
    setError("");
    startTransition(async () => {
      const res = await runAutoMatch();
      if (res.success) {
        setResult({ matched: res.matched, skipped: res.skipped });
        if (res.matched > 0) setTimeout(onDone, 1500);
      } else {
        setError(res.error ?? "Auto-match failed");
      }
    });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "0.85rem 1.2rem",
        borderRadius: "0.6rem",
        background: "rgba(34,207,157,0.06)",
        border: "1px solid rgba(34,207,157,0.2)",
        marginBottom: "1.5rem",
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1 }}>
        <p style={{ fontWeight: 600, fontSize: "0.9rem", margin: 0 }}>
          🤖 Auto-Loan Matching
        </p>
        <p style={{ fontSize: "0.8rem", opacity: 0.7, margin: "0.2rem 0 0" }}>
          {pendingCount} pending loan{pendingCount !== 1 ? "s" : ""} waiting.
          Click to automatically assign them to pools with enough liquidity.
        </p>
      </div>
      {result && (
        <span style={{ fontSize: "0.82rem", color: "#22cf9d" }}>
          ✅ {result.matched} matched, {result.skipped} skipped
        </span>
      )}
      {error && <span style={{ fontSize: "0.82rem", color: "#ff6b6b" }}>{error}</span>}
      <button
        onClick={handleRun}
        disabled={pending || pendingCount === 0}
        className="workspace-button workspace-button--primary"
        style={{ whiteSpace: "nowrap" }}
      >
        {pending ? "Matching..." : "Run Auto-Match"}
      </button>
    </div>
  );
}

// ── Main Client Component ───────────────────────────────────────────────────────
export default function AdminPoolsClient({ pools, pendingLoans }: AdminPoolsClientProps) {
  const router = useRouter();
  const refresh = () => router.refresh();

  return (
    <div className="workspace-stack">
      {/* Auto-Match Banner */}
      <AutoMatchBar pendingCount={pendingLoans.length} onDone={refresh} />

      {/* Create Pool */}
      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">Lending Pools</h2>
        <CreatePoolForm onCreated={refresh} />

        {pools.length === 0 ? (
          <p className="workspace-card-copy">No pools yet. Create the first one above.</p>
        ) : (
          <div className="workspace-table-wrap">
            <table className="workspace-table" aria-label="Lending pools table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>APR</th>
                  <th>Total Liquidity</th>
                  <th>Available</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <PoolRow key={pool.id} pool={pool} onChanged={refresh} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {/* Pending Loan Approvals */}
      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">
          Pending Loan Approvals
          {pendingLoans.length > 0 && (
            <span
              style={{
                marginLeft: "0.75rem",
                background: "rgba(255,107,107,0.15)",
                color: "#ff6b6b",
                borderRadius: "9999px",
                padding: "0.15rem 0.6rem",
                fontSize: "0.75rem",
                fontWeight: 700,
              }}
            >
              {pendingLoans.length}
            </span>
          )}
        </h2>
        <p className="workspace-card-copy" style={{ marginBottom: "1rem" }}>
          Select a pool and approve individual loans, or use Auto-Match above.
        </p>

        {pendingLoans.length === 0 ? (
          <p className="workspace-card-copy" style={{ opacity: 0.6 }}>
            No pending loans — all caught up! ✅
          </p>
        ) : (
          <div className="workspace-table-wrap">
            <table className="workspace-table" aria-label="Pending loans approval table">
              <thead>
                <tr>
                  <th>Loan ID</th>
                  <th>Borrower</th>
                  <th>Amount</th>
                  <th>APR</th>
                  <th>Duration</th>
                  <th>Assign Pool &amp; Approve</th>
                </tr>
              </thead>
              <tbody>
                {pendingLoans.map((loan) => (
                  <LoanRow
                    key={loan.id}
                    loan={loan}
                    pools={pools}
                    onApproved={refresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </div>
  );
}
