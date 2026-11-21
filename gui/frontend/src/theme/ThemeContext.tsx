// Theme state (WS2). Owns the data-theme (and optional data-crt atmosphere)
// attributes on <html> and localStorage memory; CSS does the rest (tokens.css).
//
// Backwards-compatible contract: THEME_NAMES, ThemeName, ThemeProvider, and
// useTheme() preserve exact legacy signatures while adding optional calm/refined/vivid
// CRT atmosphere control for long forensic sessions.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { emitDemoSignal, registerLiveThemeSetter } from '../demo/signals'

export const THEME_NAMES = ['deck', 'amber', 'matrix', 'mono'] as const

export type ThemeName = (typeof THEME_NAMES)[number]

export const CRT_MODES = ['refined', 'calm', 'vivid'] as const

export type CrtMode = (typeof CRT_MODES)[number]

const STORAGE_KEY = '0xaf-theme'
const CRT_STORAGE_KEY = '0xaf-crt-mode'
const DEFAULT_THEME: ThemeName = 'deck'
const DEFAULT_CRT: CrtMode = 'refined'

export interface ThemeContextValue {
  theme: ThemeName
  themes: readonly ThemeName[]
  setTheme: (name: ThemeName) => void
  crtMode: CrtMode
  setCrtMode: (mode: CrtMode) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  themes: THEME_NAMES,
  setTheme: () => {},
  crtMode: DEFAULT_CRT,
  setCrtMode: () => {},
})

function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value)
}

function isCrtMode(value: string): value is CrtMode {
  return (CRT_MODES as readonly string[]).includes(value)
}

function storedTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && isThemeName(saved)) return saved
  } catch {
    // Private window / blocked storage: fall through to default theme.
  }
  return DEFAULT_THEME
}

function storedCrtMode(): CrtMode {
  try {
    const saved = localStorage.getItem(CRT_STORAGE_KEY)
    if (saved && isCrtMode(saved)) return saved
  } catch {
    // Private window / blocked storage: fall through to default CRT mode.
  }
  return DEFAULT_CRT
}

function applyTheme(name: ThemeName) {
  document.documentElement.setAttribute('data-theme', name)
}

function applyCrtMode(mode: CrtMode) {
  document.documentElement.setAttribute('data-crt', mode)
}

export function ThemeProvider({ children, themes = THEME_NAMES }: { children: ReactNode; themes?: readonly ThemeName[] }) {
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const initial = storedTheme()
    applyTheme(initial)
    return initial
  })

  const [crtMode, setCrtModeState] = useState<CrtMode>(() => {
    const initial = storedCrtMode()
    applyCrtMode(initial)
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

  const setCrtMode = useCallback((mode: CrtMode) => {
    setCrtModeState(mode)
    applyCrtMode(mode)
    try {
      localStorage.setItem(CRT_STORAGE_KEY, mode)
    } catch {
      // Persistence is a convenience, not a requirement.
    }
  }, [])

  useEffect(() => {
    registerLiveThemeSetter(setTheme)
    return () => registerLiveThemeSetter(null)
  }, [setTheme])

  // Keep attributes synced across HMR or external DOM resets.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    applyCrtMode(crtMode)
  }, [crtMode])

  const value = useMemo(
    () => ({ theme, themes, setTheme, crtMode, setCrtMode }),
    [theme, themes, setTheme, crtMode, setCrtMode],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
