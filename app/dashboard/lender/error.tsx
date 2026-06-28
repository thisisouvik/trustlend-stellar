"use client";

import { ErrorFallback } from "@/components/dashboard/ErrorFallback";

interface LenderErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function LenderError({ error, reset }: LenderErrorProps) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Lender Dashboard Error"
      description="An unexpected error occurred on the lender dashboard. Please try again."
    />
  );
}
