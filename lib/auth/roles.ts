export type UserRole = "borrower" | "lender" | "admin";

export const DEFAULT_ROLE: UserRole = "borrower";
export const PENDING_ROLE_KEY = "trustlend_pending_role";

export function isUserRole(value: unknown): value is UserRole {
  return value === "borrower" || value === "lender";
}

export function normalizeUserRole(value: unknown): UserRole {
  return isUserRole(value) ? value : DEFAULT_ROLE;
}

export function getDashboardPath(role: UserRole): string {
  return role === "lender" ? "/dashboard/lender" : "/dashboard/borrower";
}
