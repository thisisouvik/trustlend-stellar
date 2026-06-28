"use client";

import { ErrorFallback } from "@/components/dashboard/ErrorFallback";

interface AdminErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AdminError({ error, reset }: AdminErrorProps) {
  return (
    <ErrorFallback
      error={error}
      reset={reset}
      title="Admin Panel Error"
      description="An unexpected error occurred in the admin panel. Please try again."
    />
  );
}
