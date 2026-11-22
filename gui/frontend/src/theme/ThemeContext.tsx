// Theme state (WS2). Owns the data-theme, data-theme-mode, and optional
// data-crt atmosphere attributes on <html> and localStorage memory; CSS does
// the rest (tokens.css).
//
// Backwards-compatible contract: THEME_NAMES, ThemeName, ThemeProvider, and
// useTheme() preserve exact legacy signatures while expanding to 10 curated
// pro themes (CRT Phosphor, Forensic IDE, and Daylight Lab) with typed metadata.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { emitDemoSignal, registerLiveThemeSetter } from '../demo/signals'

export const THEME_NAMES = [
  'deck',
  'amber',
  'matrix',
  'mono',
  'obsidian',
  'nord',
  'dracula',
  'solarized',
  'crimson',
  'paper',
] as const

export type ThemeName = (typeof THEME_NAMES)[number]

export type ThemeGroup = 'CRT Phosphor' | 'Forensic IDE' | 'Daylight Lab'

export type ThemeMode = 'dark' | 'light'

export interface ThemeCatalogEntry {
  id: ThemeName
  label: string
  group: ThemeGroup
  mode: ThemeMode
  description: string
  /** [canvasBg, primaryAccent, secondaryAccent] */
  swatches: readonly [string, string, string]
}

export const THEME_CATALOG: readonly ThemeCatalogEntry[] = [
  {
    id: 'deck',
    label: 'Cyberdeck',
    group: 'CRT Phosphor',
    mode: 'dark',
    description: 'Cyan obsidian · default forensic deck',
    swatches: ['#070b11', '#22d3ee', '#a78bfa'],
  },
  {
    id: 'amber',
    label: 'Amber P3',
    group: 'CRT Phosphor',
    mode: 'dark',
    description: 'Warm amber P3 CRT phosphor',
    swatches: ['#0b0804', '#ffb000', '#ffd27f'],
  },
  {
    id: 'matrix',
    label: 'Matrix P1',
    group: 'CRT Phosphor',
    mode: 'dark',
    description: 'Emerald P1 green phosphor terminal',
    swatches: ['#050a07', '#00ff9c', '#7cffb2'],
  },
  {
    id: 'mono',
    label: 'Noir Mono',
    group: 'CRT Phosphor',
    mode: 'dark',
    description: 'High-contrast Swiss silver monochrome',
    swatches: ['#09090b', '#f8fafc', '#9ca0aa'],
  },
  {
    id: 'obsidian',
    label: 'Obsidian Violet',
    group: 'Forensic IDE',
    mode: 'dark',
    description: 'Deep graphite + electric violet & sky',
    swatches: ['#0b0a12', '#b480ff', '#38bdf8'],
  },
  {
    id: 'nord',
    label: 'Nordic Frost',
    group: 'Forensic IDE',
    mode: 'dark',
    description: 'Arctic slate + frost cyan for long RE',
    swatches: ['#1a1f28', '#88c0d0', '#b48ead'],
  },
  {
    id: 'dracula',
    label: 'Dracula Forensic',
    group: 'Forensic IDE',
    mode: 'dark',
    description: 'Plum charcoal + orchid, mint & coral',
    swatches: ['#181622', '#bd93f9', '#50fa7b'],
  },
  {
    id: 'solarized',
    label: 'Solarized Dark',
    group: 'Forensic IDE',
    mode: 'dark',
    description: 'Precision teal-slate + cyan & gold',
    swatches: ['#001f27', '#38bdb2', '#daa520'],
  },
  {
    id: 'crimson',
    label: 'Red Team Ops',
    group: 'Forensic IDE',
    mode: 'dark',
    description: 'Carbon black + tactical crimson & amber',
    swatches: ['#0a0709', '#fb5670', '#f59e0b'],
  },
  {
    id: 'paper',
    label: 'Forensic Paper',
    group: 'Daylight Lab',
    mode: 'light',
    description: 'Crisp alabaster daylight · zero-glare light',
    swatches: ['#f6f7f9', '#1d4ed8', '#057a55'],
  },
] as const

const CATALOG_BY_ID: Record<ThemeName, ThemeCatalogEntry> = Object.fromEntries(
  THEME_CATALOG.map((entry) => [entry.id, entry]),
) as Record<ThemeName, ThemeCatalogEntry>

export function getThemeMeta(id: ThemeName): ThemeCatalogEntry {
  return CATALOG_BY_ID[id] ?? THEME_CATALOG[0]
}

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
  const meta = getThemeMeta(name)
  document.documentElement.setAttribute('data-theme', name)
  document.documentElement.setAttribute('data-theme-mode', meta.mode)
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
    const next = isThemeName(name) ? name : DEFAULT_THEME
    setThemeState(next)
    applyTheme(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Persistence is a convenience, not a requirement.
    }
    emitDemoSignal({ type: 'theme_changed', theme: next })
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
