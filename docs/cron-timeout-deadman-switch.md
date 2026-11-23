# Timeout and Execution Dead-Man Switches on Scheduled Cron Handlers

## Overview
Serverless runtime execution ceilings (e.g. 10s, 60s, or 300s) pose a critical reliability challenge for sequential batch processing in automated keeper and cron handlers. When Horizon RPC, Soroban RPC, or external third-party endpoints experience high latency or transient hangs, unshielded handlers can be terminated mid-batch by the serverless platform.

This abruptly drops in-flight execution, risks inconsistent keeper state, and fails silently without alerting operators or recording audit trails.

The **TrustLend Cron Dead-Man Switch** architecture enforces proactive execution deadlines, provides atomic partial progress recording, logs execution history to the database, and alerts on failure or abort.

---

## Architecture Components

### 1. `DeadManSwitch` (`lib/cron/dead-man-switch.ts`)
- Manages an execution budget with a **Safety Buffer**:
  $$\text{Effective Deadline} = \text{Timeout Limit} - \text{Safety Buffer}$$
- Operates via a standard `AbortSignal` passed downstream into loops, HTTP fetch requests, and RPC invocations.
- Monitors iteration budgets via `checkOrAbort(estimatedNextItemMs)` and `isTimeExceeded()`.
- Automatically triggers before the platform hard-kill timeout, ensuring sufficient time to persist partial progress and write failure alerts.

### 2. Route Timeout Guard (`lib/cron/with-timeout-guard.ts`)
- Higher-order wrapper for all routes under `app/api/cron/*`.
- Standardizes:
  - Caller authentication (`CRON_SECRET` constant-time verification).
  - Runtime initialization of `DeadManSwitch`.
  - Database lifecycle tracking (`cron_execution_logs`: `running` $\rightarrow$ `completed` / `aborted` / `failed`).
  - Alert logging into `cron_alerts`.
  - Prometheus metrics reporting (`cron_executions_total`, `cron_execution_duration_seconds`, `cron_aborts_total`).
  - Response formatting preserving partial batch outcomes upon abort.

### 3. Database Execution Logs & Alerts (`lib/db/schema.ts`, `lib/cron/cron-logger.ts`)
- **`cron_execution_logs`**:
  - `id`: UUID primary key
  - `job_name`: identifier (`payment-due`, `default-management`, `liquidation`, `price-oracle`, `reputation-scoring`)
  - `status`: `running`, `completed`, `aborted`, `failed`
  - `started_at`, `completed_at`, `duration_ms`
  - `processed_count`, `success_count`, `failure_count`
  - `aborted`, `abort_reason`, `error`, `metadata`
- **`cron_alerts`**:
  - Logs critical warnings and errors for automated monitoring.

### 4. Cron Log Query API (`app/api/cron/logs/route.ts`)
- `GET /api/cron/logs`:
  - Query recent cron runs with optional filters: `jobName`, `limit`, `includeAlerts=true`, `unresolvedOnly=true`.

---

## Guarded Scheduled Cron Handlers

| Endpoint | Job Name | Timeout Budget | Safety Buffer | Primary Task |
| :--- | :--- | :--- | :--- | :--- |
| `/api/cron/payment-due` | `payment-due` | 25s | 3s | Overdue payment email & webhook alerts |
| `/api/cron/default-management` | `default-management` | 270s | 10s | On-chain default marking & insurance proposals |
| `/api/cron/liquidation` | `liquidation` | 270s | 10s | On-chain collateral LTV check & liquidation |
| `/api/cron/price-oracle` | `price-oracle` | 50s | 5s | Multi-source price aggregation & on-chain publish |
| `/api/cron/reputation-scoring` | `reputation-scoring` | 55s | 5s | Daily borrower trust score recalculation |

---

## Graceful Abort Behavior
When a handler aborts before the deadline:
1. Active loop iteration completes and the loop cleanly breaks.
2. Already processed records remain committed in the database (or on-chain).
3. The execution log updates to `status: "aborted"` with `abort_reason` and partial counts (`processed`, `succeeded`, `failed`, `remaining`).
4. An alert entry is inserted in `cron_alerts`.
5. The API responds with HTTP 200 and `{ ok: true, aborted: true, partial: true, remaining: N, ... }`, allowing external orchestrators (e.g., GitHub Actions, Vercel Cron) to cleanly record status without silent failure.
