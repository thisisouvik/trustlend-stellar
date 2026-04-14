import { redirect } from "next/navigation";
import { getDashboardPath } from "@/lib/auth/roles";
import {
  isTradeVaultAdminUser,
  requireAuthenticatedUser,
} from "@/lib/auth/session";

export default async function DashboardEntryPage() {
  const { user, role } = await requireAuthenticatedUser();

  if (isTradeVaultAdminUser(user)) {
    redirect("/dashboard/admin");
  }

  redirect(getDashboardPath(role));
}
