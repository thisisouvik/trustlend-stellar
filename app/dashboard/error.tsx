"use client";

import { ErrorFallback } from "@/components/dashboard/ErrorFallback";

interface DashboardErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Dashboard Error"
      description="An unexpected error occurred in the dashboard. Please try again or return to the home page."
    />
  );
}
