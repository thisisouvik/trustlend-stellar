import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock Supabase service role client ─────────────────────────────────────────
const _mockUpdate = vi.fn();
const _mockSingle = vi.fn();
const _mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  getServiceRoleClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

import {
  queryDueLoans,
  sendWebhookNotification,
  markLoanNotified,
  runPaymentDueScheduler,
  type DueLoan,
} from "@/lib/scheduler/payment-due";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeLoan(overrides: Partial<DueLoan> = {}): DueLoan {
  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h from now
  return {
    id: "loan-1",
    borrower_id: "borrower-1",
    due_at: dueAt,
    principal_amount: 1000,
    repaid_amount: 200,
    metadata: {},
    ...overrides,
  };
}

function buildSelectChain(data: unknown, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error }),
    update: vi.fn().mockReturnThis(),
    then: undefined as unknown,
  };
  // Make the chain itself resolve like a promise (for .lte(...) which is the terminal call)
  Object.defineProperty(chain, "then", {
    get() {
      return (resolve: (v: unknown) => void) => resolve({ data, error });
    },
  });
  return chain;
}

// ── queryDueLoans ──────────────────────────────────────────────────────────────

describe("queryDueLoans", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns loans due within 48 hours that are not yet notified", async () => {
    const loan = makeLoan();
    const chain = buildSelectChain([loan]);
    mockFrom.mockReturnValue(chain);

    const result = await queryDueLoans();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("loan-1");
  });

  it("filters out loans already marked as notified", async () => {
    const notifiedLoan = makeLoan({
      metadata: { payment_due_notified_at: "2026-06-27T00:00:00.000Z" },
    });
    const chain = buildSelectChain([notifiedLoan]);
    mockFrom.mockReturnValue(chain);

    const result = await queryDueLoans();

    expect(result).toHaveLength(0);
  });

  it("returns empty array when no loans are due", async () => {
    const chain = buildSelectChain([]);
    mockFrom.mockReturnValue(chain);

    const result = await queryDueLoans();

    expect(result).toHaveLength(0);
  });

  it("throws when Supabase returns an error", async () => {
    const chain = buildSelectChain(null, { message: "DB error" });
    mockFrom.mockReturnValue(chain);

    await expect(queryDueLoans()).rejects.toThrow("Failed to query due loans: DB error");
  });

  it("handles multiple qualifying loans", async () => {
    const loans = [makeLoan({ id: "loan-1" }), makeLoan({ id: "loan-2" })];
    const chain = buildSelectChain(loans);
    mockFrom.mockReturnValue(chain);

    const result = await queryDueLoans();

    expect(result).toHaveLength(2);
  });
});

// ── sendWebhookNotification ────────────────────────────────────────────────────

describe("sendWebhookNotification", () => {
  beforeEach(() => vi.clearAllMocks());

  const webhookUrl = "https://example.com/webhook";

  it("sends a POST with the correct payload", async () => {
    const loan = makeLoan();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await sendWebhookNotification(loan, webhookUrl);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(webhookUrl);
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body);
    expect(body.borrowerId).toBe(loan.borrower_id);
    expect(body.loanId).toBe(loan.id);
    expect(body.dueDate).toBe(loan.due_at);
    expect(body.paymentAmount).toBe(800); // 1000 - 200
  });

  it("throws when the webhook returns a non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(sendWebhookNotification(makeLoan(), webhookUrl)).rejects.toThrow("HTTP 503");
  });

  it("throws on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    await expect(sendWebhookNotification(makeLoan(), webhookUrl)).rejects.toThrow("Network error");
  });
});

// ── markLoanNotified ──────────────────────────────────────────────────────────

describe("markLoanNotified", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to manual metadata merge when RPC is unavailable", async () => {
    mockRpc.mockResolvedValue({ error: { message: "function not found" } });

    const updateFn = vi.fn().mockResolvedValue({ error: null });
    const _eqFn = vi.fn().mockReturnValue({ error: null });
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { metadata: { existing_key: "value" } },
          error: null,
        }),
      }),
      update: vi.fn().mockReturnValue({ eq: updateFn }),
    };
    mockFrom.mockReturnValue(chain);

    await markLoanNotified("loan-1");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ payment_due_notified_at: expect.any(String) }),
      })
    );
  });
});

// ── runPaymentDueScheduler ────────────────────────────────────────────────────

describe("runPaymentDueScheduler", () => {
  const webhookUrl = "https://example.com/webhook";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_NOTIFICATION_URL = webhookUrl;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_NOTIFICATION_URL;
  });

  it("returns succeeded count when all notifications succeed", async () => {
    const loan = makeLoan();
    const chain = buildSelectChain([loan]);
    mockFrom.mockReturnValue(chain);
    mockRpc.mockResolvedValue({ error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const result = await runPaymentDueScheduler();

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("records failure without stopping other loans", async () => {
    const loans = [makeLoan({ id: "loan-1" }), makeLoan({ id: "loan-2" })];
    const chain = buildSelectChain(loans);
    mockFrom.mockReturnValue(chain);

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("Network error"));
        return Promise.resolve({ ok: true });
      })
    );
    mockRpc.mockResolvedValue({ error: null });

    const result = await runPaymentDueScheduler();

    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("loan-1");
  });

  it("returns zero processed for empty result set", async () => {
    const chain = buildSelectChain([]);
    mockFrom.mockReturnValue(chain);

    const result = await runPaymentDueScheduler();

    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
  });

  it("throws when WEBHOOK_NOTIFICATION_URL is not configured", async () => {
    delete process.env.WEBHOOK_NOTIFICATION_URL;
    await expect(runPaymentDueScheduler()).rejects.toThrow("WEBHOOK_NOTIFICATION_URL");
  });
});
