'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ComponentProps } from 'react'

type ThemeProviderProps = ComponentProps<typeof NextThemesProvider>

/**
 * ThemeProvider – Client Component
 *
 * Thin wrapper around next-themes' provider so it can be rendered inside the
 * (server) root layout. It owns theme persistence and FOUC prevention: the
 * provider injects a blocking inline script that reads the saved theme from
 * localStorage and applies the `.dark` class before first paint.
 *
 * @param props - next-themes provider props (e.g. `attribute`, `defaultTheme`,
 *   `storageKey`), forwarded verbatim.
 * @param props.children - The application subtree that consumes the theme.
 * @returns The provider element wrapping `children`.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
