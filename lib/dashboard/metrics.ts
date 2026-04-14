import { getServerSupabaseClient } from "@/lib/supabase/server";

export interface BorrowerDashboardMetrics {
  reputationScore: number;
  availableCredit: number;
  activeLoans: number;
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
    { label: "Active loans", value: String(metrics.activeLoans) },
    { label: "Repayment rate", value: toPercentage(metrics.repaymentRate) },
  ];
}

export function presentLenderMetrics(metrics: LenderDashboardMetrics) {
  return [
    { label: "Capital deployed", value: toCurrency(metrics.deployedCapital) },
    { label: "Interest earned", value: toCurrency(metrics.totalEarnings) },
    { label: "Active positions", value: String(metrics.activePositions) },
    { label: "Portfolio default", value: toPercentage(metrics.defaultRate) },
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
    return { reputationScore: 0, availableCredit: 0, activeLoans: 0, repaymentRate: 0 };
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

    const reputation = snapshotRes.data?.score_total ?? 0;
    const loans = loansRes.data ?? [];

    const activeLoans = loans.filter((loan) => ["approved", "funded", "active"].includes(loan.status)).length;
    const repaidLoans = loans.filter((loan) => loan.status === "repaid").length;
    const defaultedLoans = loans.filter((loan) => loan.status === "defaulted").length;
    const repaymentBase = repaidLoans + defaultedLoans;
    const repaymentRate = repaymentBase > 0 ? (repaidLoans / repaymentBase) * 100 : 100;

    return {
      reputationScore: reputation,
      availableCredit: reputation * 10,
      activeLoans,
      repaymentRate,
    };
  } catch {
    return { reputationScore: 0, availableCredit: 0, activeLoans: 0, repaymentRate: 0 };
  }
}

export async function getLenderDashboardMetrics(userId: string): Promise<LenderDashboardMetrics> {
  const supabase = await getServerSupabaseClient();

  if (!supabase) {
    return { deployedCapital: 0, totalEarnings: 0, activePositions: 0, defaultRate: 0 };
  }

  try {
    const [positionsRes, loansRes] = await Promise.all([
      supabase
        .from("pool_positions")
        .select("status, principal_amount, earned_interest")
        .eq("lender_id", userId),
      supabase
        .from("loans")
        .select("status"),
    ]);

    const positions = positionsRes.data ?? [];
    const loans = loansRes.data ?? [];

    const deployedCapital = positions.reduce((sum, row) => sum + Number(row.principal_amount ?? 0), 0);
    const totalEarnings = positions.reduce((sum, row) => sum + Number(row.earned_interest ?? 0), 0);
    const activePositions = positions.filter((row) => row.status === "active").length;

    const defaultedLoans = loans.filter((loan) => loan.status === "defaulted").length;
    const maturedLoans = loans.filter((loan) => loan.status === "repaid" || loan.status === "defaulted").length;
    const defaultRate = maturedLoans > 0 ? (defaultedLoans / maturedLoans) * 100 : 0;

    return {
      deployedCapital,
      totalEarnings,
      activePositions,
      defaultRate,
    };
  } catch {
    return { deployedCapital: 0, totalEarnings: 0, activePositions: 0, defaultRate: 0 };
  }
}

export async function getAdminDashboardMetrics(): Promise<AdminDashboardMetrics> {
  const supabase = await getServerSupabaseClient();

  if (!supabase) {
    return { totalUsers: 0, totalLoans: 0, activeLoans: 0, highRiskUsers: 0 };
  }

  try {
    const [usersRes, totalLoansRes, activeLoansRes, highRiskRes] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("loans").select("id", { count: "exact", head: true }),
      supabase
        .from("loans")
        .select("id", { count: "exact", head: true })
        .in("status", ["approved", "funded", "active"]),
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .in("risk_status", ["high", "blocked"]),
    ]);

    return {
      totalUsers: usersRes.count ?? 0,
      totalLoans: totalLoansRes.count ?? 0,
      activeLoans: activeLoansRes.count ?? 0,
      highRiskUsers: highRiskRes.count ?? 0,
    };
  } catch {
    return { totalUsers: 0, totalLoans: 0, activeLoans: 0, highRiskUsers: 0 };
  }
}
