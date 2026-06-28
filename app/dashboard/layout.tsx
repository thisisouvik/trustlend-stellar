import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <GlobalErrorBoundary>{children}</GlobalErrorBoundary>
}
