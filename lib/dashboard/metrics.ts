import { getServerSupabaseClient } from "@/lib/supabase/server";

export interface BorrowerDashboardMetrics {
  reputationScore: number;
  availableCredit: number;
  activeLoans: number;
  pendingLoans: number;
  repaymentRate: number;
}

export interface LenderDashboardMetrics {
  deployedCapital: number;
  totalEarnings: number;
  activePositions: number;
  defaultRate: number;
}

export interface AdminDashboardMetrics {
  totalUsers: number;
  totalLoans: number;
  activeLoans: number;
  highRiskUsers: number;
}

function toCurrency(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)} XLM`;
}

function toPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function presentBorrowerMetrics(metrics: BorrowerDashboardMetrics) {
  return [
    { label: "Trust score", value: String(metrics.reputationScore) },
    { label: "Available credit", value: toCurrency(metrics.availableCredit) },
    metrics.pendingLoans > 0
      ? { label: "Loan requests", value: String(metrics.pendingLoans) }
      : { label: "Active loans", value: String(metrics.activeLoans) },
    { label: "Repayment rate", value: toPercentage(metrics.repaymentRate) },
  ];
}

export function presentLenderMetrics(metrics: LenderDashboardMetrics) {
  return [
    { label: "Capital deployed", value: toCurrency(metrics.deployedCapital) },
    { label: "Interest earned", value: toCurrency(metrics.totalEarnings) },
    { label: "Active positions", value: String(metrics.activePositions) },
  ];
}

export function presentAdminMetrics(metrics: AdminDashboardMetrics) {
  return [
    { label: "Total users", value: String(metrics.totalUsers) },
    { label: "Total loans", value: String(metrics.totalLoans) },
    { label: "Active loans", value: String(metrics.activeLoans) },
    { label: "High risk users", value: String(metrics.highRiskUsers) },
  ];
}


export async function getBorrowerDashboardMetrics(userId: string): Promise<BorrowerDashboardMetrics> {
  const supabase = await getServerSupabaseClient();

  if (!supabase) {
    return { reputationScore: 0, availableCredit: 0, activeLoans: 0, pendingLoans: 0, repaymentRate: 0 };
  }

  try {
    const [eventsRes, loansRes] = await Promise.all([
      supabase
        .from("reputation_events")
        .select("points_delta")
        .eq("user_id", userId),
      supabase
        .from("loans")
        .select("status")
        .eq("borrower_id", userId),
    ]);

    const events = eventsRes.data ?? [];
    const reputationPoints = events.reduce((sum, row) => sum + Number(row.points_delta ?? 0), 0);
    const reputation = Math.max(0, 250 + reputationPoints);
    const loans = loansRes.data ?? [];

    const pendingLoans  = loans.filter((loan) => loan.status === "requested").length;
    const activeLoans   = loans.filter((loan) => ["active", "funded", "approved"].includes(loan.status)).length;
    const repaidLoans   = loans.filter((loan) => loan.status === "repaid").length;
    const defaultedLoans = loans.filter((loan) => loan.status === "defaulted").length;
    const repaymentBase = repaidLoans + defaultedLoans;
    const repaymentRate = repaymentBase > 0 ? (repaidLoans / repaymentBase) * 100 : 100;

    return {
      reputationScore: reputation,
      availableCredit: reputation * 10,
      activeLoans,
      pendingLoans,
      repaymentRate,
    };
  } catch {
    return { reputationScore: 250, availableCredit: 2500, activeLoans: 0, pendingLoans: 0, repaymentRate: 0 };
  }
}

export async function getLenderDashboardMetrics(userId: string): Promise<LenderDashboardMetrics> {
  const { getServerSupabaseClient, getServiceRoleClient } = await import("@/lib/supabase/server");
  const supabase = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  if (!supabase || !srClient) {
    return { deployedCapital: 0, totalEarnings: 0, activePositions: 0, defaultRate: 0 };
  }

  try {
    // 1. Pool positions
    const positionsRes = await supabase
      .from("pool_positions")
      .select("status, principal_amount, earned_interest")
      .eq("lender_id", userId);

    const positions = positionsRes.data ?? [];
    const poolDeployed = positions.reduce((s, r) => s + Number(r.principal_amount ?? 0), 0);
    const poolEarnings = positions.reduce((s, r) => s + Number(r.earned_interest   ?? 0), 0);
    const poolActive   = positions.filter((r) => r.status === "active").length;

    // 2. P2P Metrics
    const { data: p2pFunds } = await supabase
      .from("ledger_transactions")
      .select("amount, ref_id")
      .eq("user_id", userId)
      .eq("ref_type", "loan_fund");

    const { data: p2pRepays } = await srClient
      .from("ledger_transactions")
      .select("amount, metadata")
      .eq("ref_type", "loan_repay");

    const lenderRepays = (p2pRepays ?? []).filter(tx => {
      try {
        const meta = JSON.parse(String(tx.metadata || "{}"));
        return String(meta.lenderUserId) === String(userId) || String(meta.lenderAddress) === String(userId);
      } catch { return false; }
    });

    // We must group by loan (ref_id) so a newly funded loan doesn't wipe out past profits!
    const loanProfitMap = new Map<string, { deployed: number; received: number }>();

    for (const tx of (p2pFunds ?? [])) {
      const id = String(tx.ref_id);
      const cur = loanProfitMap.get(id) ?? { deployed: 0, received: 0 };
      cur.deployed += Number(tx.amount || 0);
      loanProfitMap.set(id, cur);
    }

    for (const tx of lenderRepays) {
      let id = "";
      try {
        const meta = JSON.parse(String(tx.metadata || "{}"));
        id = meta.loanId ? String(meta.loanId) : "";
      } catch {}
      if (!id) continue;

      const cur = loanProfitMap.get(id) ?? { deployed: 0, received: 0 };
      cur.received += Number(tx.amount || 0);
      loanProfitMap.set(id, cur);
    }

    let p2pProfit = 0;
    for (const { deployed, received } of loanProfitMap.values()) {
      p2pProfit += Math.max(0, received - deployed);
    }

    const p2pDeployed = (p2pFunds ?? []).reduce((s, t) => s + Number(t.amount || 0), 0);

    // Get active loan count from the funded loans
    const loanIds = Array.from(loanProfitMap.keys());
    let p2pActiveCount = 0;
    if (loanIds.length > 0) {
      const { data: loans } = await srClient
        .from("loans")
        .select("status")
        .in("id", loanIds);
      p2pActiveCount = (loans ?? []).filter(l => l.status === "active").length;
    }

    const deployedCapital = poolDeployed + p2pDeployed;
    const totalEarnings = poolEarnings + p2pProfit;
    const activePositions = poolActive + p2pActiveCount;
    const defaultRate = 0;

    return { deployedCapital, totalEarnings, activePositions, defaultRate };
  } catch {
    return { deployedCapital: 0, totalEarnings: 0, activePositions: 0, defaultRate: 0 };
  }
}

export async function getAdminDashboardMetrics(): Promise<AdminDashboardMetrics> {
  const supabase = await getServerSupabaseClient();
  if (!supabase) return { totalUsers: 0, totalLoans: 0, activeLoans: 0, highRiskUsers: 0 };

  try {
    const [usersRes, totalLoansRes, activeLoansRes, highRiskRes] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("loans").select("id", { count: "exact", head: true }),
      supabase.from("loans").select("id", { count: "exact", head: true })
        .in("status", ["approved", "funded", "active", "requested"]),
      supabase.from("profiles").select("id", { count: "exact", head: true })
        .in("risk_status", ["high", "blocked"]),
    ]);
    return {
      totalUsers:    usersRes.count    ?? 0,
      totalLoans:    totalLoansRes.count ?? 0,
      activeLoans:   activeLoansRes.count ?? 0,
      highRiskUsers: highRiskRes.count ?? 0,
    };
  } catch {
    return { totalUsers: 0, totalLoans: 0, activeLoans: 0, highRiskUsers: 0 };
  }
}
