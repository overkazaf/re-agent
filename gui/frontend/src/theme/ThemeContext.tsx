// Theme state (WS2). Owns the data-theme attribute on <html> and the
// localStorage memory; CSS does the rest (see styles/tokens.css).
//
// The theme list is a local constant for now — the frozen contract's
// GetThemes() binding (= ui.ThemeNames) is wired by the integration layer in
// Phase 3, which can pass the live list via <ThemeProvider themes={...}>.
// This module deliberately does not call window.go itself.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { emitDemoSignal, registerLiveThemeSetter } from '../demo/signals'

export const THEME_NAMES = ['deck', 'amber', 'matrix', 'mono'] as const

export type ThemeName = (typeof THEME_NAMES)[number]

const STORAGE_KEY = '0xaf-theme'
const DEFAULT_THEME: ThemeName = 'deck'

interface ThemeContextValue {
  theme: ThemeName
  themes: readonly ThemeName[]
  setTheme: (name: ThemeName) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  themes: THEME_NAMES,
  setTheme: () => {},
})

function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value)
}

function storedTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && isThemeName(saved)) return saved
  } catch {
    // Private window / blocked storage: fall through to the default theme.
  }
  return DEFAULT_THEME
}

function applyTheme(name: ThemeName) {
  document.documentElement.setAttribute('data-theme', name)
}

export function ThemeProvider({ children, themes = THEME_NAMES }: { children: ReactNode; themes?: readonly ThemeName[] }) {
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const initial = storedTheme()
    applyTheme(initial)
    return initial
  })

  const setTheme = useCallback((name: ThemeName) => {
    setThemeState(name)
    applyTheme(name)
    try {
      localStorage.setItem(STORAGE_KEY, name)
    } catch {
      // Persistence is a convenience, not a requirement.
    }
    emitDemoSignal({ type: 'theme_changed', theme: name })
  }, [])

  useEffect(() => {
    registerLiveThemeSetter(setTheme)
    return () => registerLiveThemeSetter(null)
  }, [setTheme])

  // Belt and braces: keep the attribute in sync even if something else
  // clobbers it (HMR, another tab's bootstrap).
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const value = useMemo(() => ({ theme, themes, setTheme }), [theme, themes, setTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
