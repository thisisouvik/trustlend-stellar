'use client'

import * as React from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

/**
 * ThemeToggle – Client Component
 *
 * A header button that flips the app between light and dark mode. The choice
 * is delegated to next-themes, which persists it to localStorage (under the
 * `trustlend-theme` key) and applies the `.dark` class before paint, so the
 * preference survives reloads with no flash of unstyled content.
 *
 * `resolvedTheme` is only knowable on the client (it depends on localStorage
 * and the system preference), so a `mounted` guard defers the icon state and
 * accessible label until after hydration to avoid a server/client mismatch.
 *
 * @returns A toggle button whose sun/moon icons cross-fade with the theme.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  // `resolvedTheme` is only known on the client (it depends on localStorage /
  // the system preference), so defer to after mount to avoid a hydration
  // mismatch and to label/act on the real current theme.
  React.useEffect(() => setMounted(true), [])

  const isDark = resolvedTheme === 'dark'

  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="relative h-9 w-9 rounded-full transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
      aria-label={mounted ? `Switch to ${isDark ? 'light' : 'dark'} mode` : 'Toggle theme'}
      aria-pressed={mounted ? isDark : undefined}
      title={mounted ? `Switch to ${isDark ? 'light' : 'dark'} mode` : undefined}
      suppressHydrationWarning
    >
      <Sun className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
    </button>
  )
}
