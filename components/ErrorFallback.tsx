'use client'

import { Button } from '@/components/ui/button'

interface ErrorFallbackProps {
  error?: Error
  resetError?: () => void
}

export function ErrorFallback({ error, resetError }: ErrorFallbackProps) {
  return (
    <div className="error-fallback-shell">
      <div className="error-fallback-card">
        <div className="error-fallback-icon-wrap">
          <div className="error-fallback-orb" aria-hidden="true" />
          <span className="error-fallback-icon">!</span>
        </div>

        <h2 className="error-fallback-title">Something went wrong</h2>
        <p className="error-fallback-message">
          An unexpected error occurred while rendering this page. Our team has been notified.
        </p>

        {error && (
          <p className="error-fallback-detail">
            {error.name || 'Error'}: {error.message}
          </p>
        )}

        {resetError && (
          <Button
            onClick={resetError}
            variant="default"
            className="error-fallback-btn"
          >
            Try Again
          </Button>
        )}
      </div>
    </div>
  )
}
