"use client";

import { ErrorFallback } from "@/components/dashboard/ErrorFallback";

interface BorrowerErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function BorrowerError({ error, reset }: BorrowerErrorProps) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Borrower Dashboard Error"
      description="An unexpected error occurred on the borrower dashboard. Please try again."
    />
  );
}
