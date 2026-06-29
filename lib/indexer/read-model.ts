type IndexerMode = "disabled" | "fallback" | "required";

export interface IndexedLoan {
  id: string;
  borrowerId?: string | null;
  borrowerAddress?: string | null;
  lenderId?: string | null;
  lenderAddress?: string | null;
  status: string;
  principalAmount: number;
  repaidAmount: number;
  aprBps: number;
  durationDays: number;
  dueAt: string | null;
  createdAt: string | null;
  requestedAt?: string | null;
  escrowId?: string | number | null;
}

export interface IndexedReputationEvent {
  id?: string;
  borrowerId?: string | null;
  borrowerAddress?: string | null;
  eventType?: string | null;
  pointsDelta: number;
  scoreAfter?: number | null;
  createdAt?: string | null;
}

export interface IndexedEscrowEvent {
  id?: string;
  loanId: string;
  lenderAddress?: string | null;
  borrowerAddress?: string | null;
  amount: number;
  eventType?: string | null;
  txHash?: string | null;
  createdAt?: string | null;
}

export interface IndexedDashboardReadModel {
  loans: IndexedLoan[];
  reputationEvents: IndexedReputationEvent[];
  escrowEvents: IndexedEscrowEvent[];
}

interface ReadOptions {
  userId?: string | null;
  walletAddress?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

function getMode(): IndexerMode {
  const raw = (process.env.TRUSTLEND_INDEXER_READ_MODE ?? "fallback").toLowerCase();
  if (raw === "required" || raw === "disabled") return raw;
  return "fallback";
}

export function isIndexerConfigured(): boolean {
  return Boolean(process.env.TRUSTLEND_INDEXER_GRAPHQL_URL || process.env.TRUSTLEND_INDEXER_REST_URL);
}

export function isIndexerRequired(): boolean {
  return getMode() === "required";
}

function getHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  const token = process.env.TRUSTLEND_INDEXER_API_KEY;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function unwrapRows<T>(payload: unknown, preferredKey: string): T[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const direct = record[preferredKey];
  if (Array.isArray(direct)) return direct as T[];
  if (direct && typeof direct === "object" && Array.isArray((direct as Record<string, unknown>).nodes)) {
    return (direct as Record<string, unknown>).nodes as T[];
  }
  if (Array.isArray(record.nodes)) return record.nodes as T[];
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).nodes)) {
      return (value as Record<string, unknown>).nodes as T[];
    }
  }
  return [];
}

async function requestGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  preferredKey: string,
): Promise<T[]> {
  const url = process.env.TRUSTLEND_INDEXER_GRAPHQL_URL;
  if (!url) return [];

  const res = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Indexer GraphQL returned ${res.status}`);

  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (json.errors) throw new Error("Indexer GraphQL returned errors");
  return unwrapRows<T>(json.data, preferredKey);
}

async function requestRest<T>(
  path: string,
  params: Record<string, string | number | undefined | null>,
  preferredKey: string,
): Promise<T[]> {
  const base = process.env.TRUSTLEND_INDEXER_REST_URL;
  if (!base) return [];

  const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, { headers: getHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Indexer REST returned ${res.status}`);

  const json = await res.json();
  return Array.isArray(json) ? (json as T[]) : unwrapRows<T>(json, preferredKey);
}

async function readIndexed<T>({
  graphqlQuery,
  graphqlQueryEnv,
  restPath,
  variables,
  restParams,
  preferredKey,
}: {
  graphqlQuery: string;
  graphqlQueryEnv: string;
  restPath: string;
  variables: Record<string, unknown>;
  restParams: Record<string, string | number | undefined | null>;
  preferredKey: string;
}): Promise<T[]> {
  if (getMode() === "disabled" || !isIndexerConfigured()) return [];

  const configuredQuery = process.env[graphqlQueryEnv];
  if (process.env.TRUSTLEND_INDEXER_GRAPHQL_URL) {
    return requestGraphql<T>(configuredQuery || graphqlQuery, variables, preferredKey);
  }
  return requestRest<T>(restPath, restParams, preferredKey);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function normalizeLoan(row: Record<string, unknown>): IndexedLoan {
  const principal =
    row.principalAmount ?? row.principal_amount ?? row.amount ?? row.totalPrincipal ?? 0;
  return {
    id: String(row.id ?? row.loanId ?? row.loan_id ?? ""),
    borrowerId: toStringOrNull(row.borrowerId ?? row.borrower_id),
    borrowerAddress: toStringOrNull(row.borrowerAddress ?? row.borrower),
    lenderId: toStringOrNull(row.lenderId ?? row.lender_id),
    lenderAddress: toStringOrNull(row.lenderAddress ?? row.lender),
    status: String(row.status ?? "requested").toLowerCase(),
    principalAmount: toNumber(principal),
    repaidAmount: toNumber(row.repaidAmount ?? row.repaid_amount ?? row.totalRepaid ?? 0),
    aprBps: toNumber(row.aprBps ?? row.apr_bps ?? row.interestRateBps ?? row.interest_rate_bps ?? 0),
    durationDays: toNumber(row.durationDays ?? row.duration_days ?? 0),
    dueAt: toStringOrNull(row.dueAt ?? row.due_at),
    createdAt: toStringOrNull(row.createdAt ?? row.created_at ?? row.ledgerTimestamp),
    requestedAt: toStringOrNull(row.requestedAt ?? row.requested_at),
    escrowId: toStringOrNull(row.escrowId ?? row.escrow_id),
  };
}

function normalizeReputationEvent(row: Record<string, unknown>): IndexedReputationEvent {
  return {
    id: toStringOrNull(row.id) ?? undefined,
    borrowerId: toStringOrNull(row.borrowerId ?? row.user_id),
    borrowerAddress: toStringOrNull(row.borrowerAddress ?? row.borrower),
    eventType: toStringOrNull(row.eventType ?? row.event_type),
    pointsDelta: toNumber(row.pointsDelta ?? row.points_delta ?? row.delta),
    scoreAfter: toNumber(row.scoreAfter ?? row.score_after ?? row.score),
    createdAt: toStringOrNull(row.createdAt ?? row.created_at ?? row.ledgerTimestamp),
  };
}

function normalizeEscrowEvent(row: Record<string, unknown>): IndexedEscrowEvent {
  return {
    id: toStringOrNull(row.id) ?? undefined,
    loanId: String(row.loanId ?? row.loan_id ?? row.refId ?? ""),
    lenderAddress: toStringOrNull(row.lenderAddress ?? row.lender),
    borrowerAddress: toStringOrNull(row.borrowerAddress ?? row.borrower),
    amount: toNumber(row.amount),
    eventType: toStringOrNull(row.eventType ?? row.event_type ?? row.type),
    txHash: toStringOrNull(row.txHash ?? row.tx_hash ?? row.transactionHash),
    createdAt: toStringOrNull(row.createdAt ?? row.created_at ?? row.ledgerTimestamp),
  };
}

const BORROWER_LOANS_QUERY = `
  query TrustLendBorrowerLoans($userId: String, $walletAddress: String, $limit: Int!) {
    loans(
      first: $limit
      orderBy: createdAt
      orderDirection: desc
      where: { borrowerId: $userId, borrowerAddress: $walletAddress }
    ) {
      id borrowerId borrowerAddress lenderId lenderAddress status principalAmount repaidAmount
      aprBps durationDays dueAt createdAt requestedAt escrowId
    }
  }
`;

const LENDER_LOANS_QUERY = `
  query TrustLendLenderLoans($userId: String, $walletAddress: String, $limit: Int!) {
    loans(
      first: $limit
      orderBy: createdAt
      orderDirection: desc
      where: { lenderId: $userId, lenderAddress: $walletAddress }
    ) {
      id borrowerId borrowerAddress lenderId lenderAddress status principalAmount repaidAmount
      aprBps durationDays dueAt createdAt requestedAt escrowId
    }
  }
`;

const ADMIN_LOANS_QUERY = `
  query TrustLendAdminLoans($limit: Int!) {
    loans(first: $limit, orderBy: createdAt, orderDirection: desc) {
      id borrowerId borrowerAddress lenderId lenderAddress status principalAmount repaidAmount
      aprBps durationDays dueAt createdAt requestedAt escrowId
    }
  }
`;

const REPUTATION_EVENTS_QUERY = `
  query TrustLendReputationEvents($userId: String, $walletAddress: String, $limit: Int!) {
    reputationEvents(
      first: $limit
      orderBy: createdAt
      orderDirection: desc
      where: { borrowerId: $userId, borrowerAddress: $walletAddress }
    ) {
      id borrowerId borrowerAddress eventType pointsDelta scoreAfter createdAt
    }
  }
`;

const ESCROW_EVENTS_QUERY = `
  query TrustLendEscrowEvents($walletAddress: String, $limit: Int!) {
    escrowEvents(
      first: $limit
      orderBy: createdAt
      orderDirection: desc
      where: { lenderAddress: $walletAddress }
    ) {
      id loanId lenderAddress borrowerAddress amount eventType txHash createdAt
    }
  }
`;

export async function getIndexedBorrowerReadModel(options: ReadOptions): Promise<IndexedDashboardReadModel> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const variables = {
    userId: options.userId ?? "",
    walletAddress: options.walletAddress ?? "",
    limit,
  };

  const [loans, reputationEvents] = await Promise.all([
    readIndexed<Record<string, unknown>>({
      graphqlQuery: BORROWER_LOANS_QUERY,
      graphqlQueryEnv: "TRUSTLEND_INDEXER_BORROWER_LOANS_QUERY",
      restPath: "/loans",
      variables,
      restParams: { borrowerId: options.userId, borrowerAddress: options.walletAddress, limit },
      preferredKey: "loans",
    }),
    readIndexed<Record<string, unknown>>({
      graphqlQuery: REPUTATION_EVENTS_QUERY,
      graphqlQueryEnv: "TRUSTLEND_INDEXER_REPUTATION_EVENTS_QUERY",
      restPath: "/reputation-events",
      variables,
      restParams: { borrowerId: options.userId, borrowerAddress: options.walletAddress, limit },
      preferredKey: "reputationEvents",
    }),
  ]);

  return {
    loans: loans.map(normalizeLoan).filter((loan) => loan.id),
    reputationEvents: reputationEvents.map(normalizeReputationEvent),
    escrowEvents: [],
  };
}

export async function getIndexedLenderReadModel(options: ReadOptions): Promise<IndexedDashboardReadModel> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const variables = {
    userId: options.userId ?? "",
    walletAddress: options.walletAddress ?? "",
    limit,
  };

  const [loans, escrowEvents] = await Promise.all([
    readIndexed<Record<string, unknown>>({
      graphqlQuery: LENDER_LOANS_QUERY,
      graphqlQueryEnv: "TRUSTLEND_INDEXER_LENDER_LOANS_QUERY",
      restPath: "/loans",
      variables,
      restParams: { lenderId: options.userId, lenderAddress: options.walletAddress, limit },
      preferredKey: "loans",
    }),
    readIndexed<Record<string, unknown>>({
      graphqlQuery: ESCROW_EVENTS_QUERY,
      graphqlQueryEnv: "TRUSTLEND_INDEXER_ESCROW_EVENTS_QUERY",
      restPath: "/escrow-events",
      variables,
      restParams: { lenderAddress: options.walletAddress, limit },
      preferredKey: "escrowEvents",
    }),
  ]);

  return {
    loans: loans.map(normalizeLoan).filter((loan) => loan.id),
    reputationEvents: [],
    escrowEvents: escrowEvents.map(normalizeEscrowEvent).filter((event) => event.loanId),
  };
}

export async function getIndexedAdminReadModel(limit = DEFAULT_LIMIT): Promise<IndexedDashboardReadModel> {
  const loans = await readIndexed<Record<string, unknown>>({
    graphqlQuery: ADMIN_LOANS_QUERY,
    graphqlQueryEnv: "TRUSTLEND_INDEXER_ADMIN_LOANS_QUERY",
    restPath: "/loans",
    variables: { limit },
    restParams: { limit },
    preferredKey: "loans",
  });

  return {
    loans: loans.map(normalizeLoan).filter((loan) => loan.id),
    reputationEvents: [],
    escrowEvents: [],
  };
}
