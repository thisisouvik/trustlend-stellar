import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";

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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function toPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function presentBorrowerMetrics(metrics: BorrowerDashboardMetrics) {
  return [
    { label: "Trust score", value: String(metrics.reputationScore) },
    { label: "Available credit", value: toCurrency(metrics.availableCredit) },
    // Show pending requests when there are no active loans yet
    metrics.activeLoans > 0
      ? { label: "Active loans", value: String(metrics.activeLoans) }
      : { label: "Loan requests", value: String(metrics.pendingLoans) },
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
    const [snapshotRes, loansRes] = await Promise.all([
      supabase
        .from("reputation_snapshots")
        .select("score_total")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("loans")
        .select("status")
        .eq("borrower_id", userId),
    ]);

    const reputation = snapshotRes.data?.score_total ?? 250;
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
  const supabase = await getServerSupabaseClient();

  if (!supabase) {
    return { deployedCapital: 0, totalEarnings: 0, activePositions: 0, defaultRate: 0 };
  }

  try {
    const sr = getServiceRoleClient();
    if (!sr) throw new Error("No SR");

    // 1. Pool positions
    const positionsRes = await supabase
      .from("pool_positions")
      .select("status, principal_amount, earned_interest")
      .eq("lender_id", userId);

    const positions = positionsRes.data ?? [];
    const poolDeployed = positions.reduce((s, r) => s + Number(r.principal_amount ?? 0), 0);
    const poolEarnings = positions.reduce((s, r) => s + Number(r.earned_interest   ?? 0), 0);
    const poolActive   = positions.filter((r) => r.status === "active").length;

    // 2. Load all loans (needed for default rate AND finding real P2P statuses)
    const { data: allLoans } = await sr.from("loans").select("id, status");
    const all = allLoans ?? [];
    const loanMap = Object.fromEntries(all.map(l => [String(l.id), l.status]));

    // 3. Direct P2P Loans Funded
    const p2pFunds = await sr
      .from("ledger_transactions")
      .select("amount, ref_id")
      .eq("user_id", userId)
      .eq("ref_type", "loan_fund");
    
    // We only count deployed capital for loans that were actually funded/active.
    // Wait, deployed capital is total all time. However, active position is ONLY if the loan is still active!
    const p2pLoansDeployed = (p2pFunds.data ?? []).reduce((s, t) => s + Number(t.amount), 0);
    const p2pActiveCount = (p2pFunds.data ?? []).filter((t) => {
      const st = loanMap[String(t.ref_id)];
      return st === "active" || st === "funded" || st === "approved";
    }).length;

    // 4. Earnings from P2P (Repayments where lenderUserId matches)
    const p2pRepays = await sr
      .from("ledger_transactions")
      .select("amount, metadata")
      .eq("ref_type", "loan_repay");
      
    const lenderRepays = (p2pRepays.data ?? []).filter(tx => {
       try {
         const meta = JSON.parse(String(tx.metadata || "{}"));
         return String(meta.lenderUserId) === String(userId) || String(meta.lenderAddress) === String(userId);
       } catch { return false; }
    });
    const p2pTotalRepaid = lenderRepays.reduce((s, t) => s + Number(t.amount), 0);
    const p2pEarnings = Math.max(0, p2pTotalRepaid - p2pLoansDeployed);

    const deployedCapital = poolDeployed + p2pLoansDeployed;
    const totalEarnings = poolEarnings + p2pEarnings;
    const activePositions = poolActive + p2pActiveCount;

    // Global default rate computation
    const bad          = all.filter((l) => l.status === "defaulted").length;
    const closed       = all.filter((l) => ["repaid","defaulted"].includes(String(l.status))).length;
    const defaultRate  = closed > 0 ? (bad / closed) * 100 : 0;

    return { deployedCapital, totalEarnings, activePositions, defaultRate };
  } catch {
    return { deployedCapital: 0, totalEarnings: 0, activePositions: 0, defaultRate: 0 };
  }
}

export async function getAdminDashboardMetrics(): Promise<AdminDashboardMetrics> {
  // Admin metrics need service role to see counts across ALL users
  const sr = getServiceRoleClient();
  if (!sr) return { totalUsers: 0, totalLoans: 0, activeLoans: 0, highRiskUsers: 0 };

  try {
    const [usersRes, totalLoansRes, activeLoansRes, highRiskRes] = await Promise.all([
      sr.from("profiles").select("id", { count: "exact", head: true }),
      sr.from("loans").select("id", { count: "exact", head: true }),
      sr.from("loans").select("id", { count: "exact", head: true })
        .in("status", ["approved", "funded", "active", "requested"]),
      sr.from("profiles").select("id", { count: "exact", head: true })
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
