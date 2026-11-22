// ThemeMaterials — CSS design tokens -> Three.js color & material bridge.
// Re-reads computed styles whenever the active theme changes and exposes
// calibrated optical-glass + crisp wireframe/edge material factories across
// all 10 curated themes (including Daylight Lab light mode).
//
// Note: R3F <Canvas> uses a separate reconciler root where React context does
// not cross automatically; materials are resolved outside Canvas via
// useTheaterMaterials() and passed as props.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { getThemeMeta, useTheme, type ThemeName } from '../theme/ThemeContext'

export interface TheaterPaletteSpec {
  bg: string
  accent: string
  ok: string
  err: string
  violet: string
  amber: string
  faint: string
  rule: string
  muted: string
  text: string
  glowStrength: number
  isLight: boolean
}

export const THEATER_PALETTES: Record<ThemeName, TheaterPaletteSpec> = {
  deck: {
    bg: '#070b11',
    accent: 'rgb(34, 211, 238)',
    ok: 'rgb(74, 222, 128)',
    err: 'rgb(248, 113, 113)',
    violet: 'rgb(167, 139, 250)',
    amber: 'rgb(251, 191, 36)',
    faint: 'rgb(14, 116, 144)',
    rule: 'rgb(42, 56, 76)',
    muted: 'rgb(156, 171, 192)',
    text: 'rgb(232, 237, 244)',
    glowStrength: 0.62,
    isLight: false,
  },
  amber: {
    bg: '#0b0804',
    accent: 'rgb(255, 176, 0)',
    ok: 'rgb(255, 214, 51)',
    err: 'rgb(255, 104, 94)',
    violet: 'rgb(255, 210, 127)',
    amber: 'rgb(255, 186, 42)',
    faint: 'rgb(172, 116, 12)',
    rule: 'rgb(78, 56, 22)',
    muted: 'rgb(212, 164, 74)',
    text: 'rgb(255, 218, 138)',
    glowStrength: 0.76,
    isLight: false,
  },
  matrix: {
    bg: '#050a07',
    accent: 'rgb(0, 255, 156)',
    ok: 'rgb(52, 245, 162)',
    err: 'rgb(255, 112, 112)',
    violet: 'rgb(124, 255, 178)',
    amber: 'rgb(255, 209, 102)',
    faint: 'rgb(16, 168, 108)',
    rule: 'rgb(33, 66, 48)',
    muted: 'rgb(126, 192, 152)',
    text: 'rgb(214, 252, 228)',
    glowStrength: 0.68,
    isLight: false,
  },
  mono: {
    bg: '#09090b',
    accent: 'rgb(248, 250, 252)',
    ok: 'rgb(236, 238, 242)',
    err: 'rgb(255, 255, 255)',
    violet: 'rgb(212, 214, 222)',
    amber: 'rgb(218, 220, 226)',
    faint: 'rgb(156, 160, 170)',
    rule: 'rgb(56, 56, 66)',
    muted: 'rgb(164, 164, 174)',
    text: 'rgb(236, 236, 240)',
    glowStrength: 0.24,
    isLight: false,
  },
  obsidian: {
    bg: '#0b0a12',
    accent: 'rgb(180, 128, 255)',
    ok: 'rgb(74, 222, 128)',
    err: 'rgb(251, 113, 133)',
    violet: 'rgb(56, 189, 248)',
    amber: 'rgb(250, 204, 21)',
    faint: 'rgb(112, 68, 186)',
    rule: 'rgb(54, 48, 82)',
    muted: 'rgb(168, 162, 196)',
    text: 'rgb(238, 236, 248)',
    glowStrength: 0.46,
    isLight: false,
  },
  nord: {
    bg: '#1a1f28',
    accent: 'rgb(136, 192, 208)',
    ok: 'rgb(163, 190, 140)',
    err: 'rgb(224, 118, 128)',
    violet: 'rgb(180, 142, 173)',
    amber: 'rgb(235, 203, 139)',
    faint: 'rgb(84, 128, 148)',
    rule: 'rgb(67, 76, 94)',
    muted: 'rgb(176, 188, 208)',
    text: 'rgb(236, 239, 244)',
    glowStrength: 0.3,
    isLight: false,
  },
  dracula: {
    bg: '#181622',
    accent: 'rgb(189, 147, 249)',
    ok: 'rgb(80, 250, 123)',
    err: 'rgb(255, 108, 108)',
    violet: 'rgb(255, 121, 198)',
    amber: 'rgb(255, 184, 108)',
    faint: 'rgb(116, 84, 174)',
    rule: 'rgb(68, 71, 96)',
    muted: 'rgb(178, 182, 212)',
    text: 'rgb(244, 244, 240)',
    glowStrength: 0.44,
    isLight: false,
  },
  solarized: {
    bg: '#001f27',
    accent: 'rgb(56, 189, 178)',
    ok: 'rgb(148, 188, 52)',
    err: 'rgb(238, 100, 96)',
    violet: 'rgb(134, 144, 224)',
    amber: 'rgb(218, 165, 32)',
    faint: 'rgb(28, 114, 108)',
    rule: 'rgb(24, 78, 92)',
    muted: 'rgb(154, 174, 176)',
    text: 'rgb(220, 228, 224)',
    glowStrength: 0.28,
    isLight: false,
  },
  crimson: {
    bg: '#0a0709',
    accent: 'rgb(251, 86, 112)',
    ok: 'rgb(74, 222, 128)',
    err: 'rgb(255, 102, 102)',
    violet: 'rgb(245, 158, 11)',
    amber: 'rgb(251, 191, 36)',
    faint: 'rgb(156, 40, 62)',
    rule: 'rgb(72, 42, 52)',
    muted: 'rgb(190, 162, 169)',
    text: 'rgb(244, 232, 235)',
    glowStrength: 0.56,
    isLight: false,
  },
  paper: {
    bg: '#eef1f6',
    accent: 'rgb(29, 78, 216)',
    ok: 'rgb(5, 122, 85)',
    err: 'rgb(190, 18, 60)',
    violet: 'rgb(109, 40, 217)',
    amber: 'rgb(180, 83, 9)',
    faint: 'rgb(100, 116, 139)',
    rule: 'rgb(176, 188, 205)',
    muted: 'rgb(71, 85, 105)',
    text: 'rgb(17, 24, 39)',
    glowStrength: 0.14,
    isLight: true,
  },
}

export interface TheaterMaterials {
  bg: THREE.Color
  accent: THREE.Color
  ok: THREE.Color
  err: THREE.Color
  violet: THREE.Color
  amber: THREE.Color
  /** --accent-dim: subdued primary tone for secondary geometry */
  faint: THREE.Color
  /** --rule: architectural grid & framing hairlines */
  rule: THREE.Color
  /** --muted: subdued metadata & rejected nodes */
  muted: THREE.Color
  /** --text: key directional highlight tint */
  text: THREE.Color
  glowStrength: number
  isLight: boolean
}

let cache: TheaterMaterials | null = null

function activeThemeFallback(): TheaterPaletteSpec {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme') as ThemeName | null
    if (attr && attr in THEATER_PALETTES) {
      return THEATER_PALETTES[attr]
    }
  }
  return THEATER_PALETTES.deck
}

/** Reads theme colors from <html> computed CSS variables (cached; force=true refreshes). */
export function readThemeMaterials(force = false): TheaterMaterials {
  if (cache && !force) return cache
  const fb = activeThemeFallback()
  const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const read = (name: string, fallback: string): THREE.Color => {
    const raw = style?.getPropertyValue(name).trim() || fallback
    try {
      return new THREE.Color(raw)
    } catch {
      return new THREE.Color(fallback)
    }
  }
  const amberRaw = style?.getPropertyValue('--amber').trim() || style?.getPropertyValue('--warn').trim()
  const glowRaw = style?.getPropertyValue('--glow-strength').trim() ?? ''
  const glow = parseFloat(glowRaw)
  const attr = typeof document !== 'undefined' ? (document.documentElement.getAttribute('data-theme') as ThemeName | null) : null
  const isLight = attr ? getThemeMeta(attr).mode === 'light' : fb.isLight

  cache = {
    // In light paper mode, give the 3D stage a subtle architectural alabaster slate backdrop
    // so crisp white HUD chips and deep navy/emerald wireframes pop cleanly.
    bg: isLight ? new THREE.Color(fb.bg) : read('--bg', fb.bg),
    accent: read('--accent', fb.accent),
    ok: read('--ok', fb.ok),
    err: read('--err', fb.err),
    violet: read('--violet', fb.violet),
    amber: amberRaw ? new THREE.Color(amberRaw) : new THREE.Color(fb.amber),
    faint: isLight ? new THREE.Color(fb.faint) : read('--accent-dim', fb.faint),
    rule: isLight ? new THREE.Color(fb.rule) : read('--rule', fb.rule),
    muted: read('--muted', fb.muted),
    text: read('--text', fb.text),
    glowStrength: Number.isFinite(glow) && glow >= 0 ? glow : fb.glowStrength,
    isLight,
  }
  return cache
}

/** Call outside <Canvas>: returns a fresh object reference whenever theme changes. */
export function useTheaterMaterials(): TheaterMaterials {
  const { theme } = useTheme()
  return useMemo(() => readThemeMaterials(true), [theme])
}

/** Mount outside <Canvas> to keep the module cache synced on theme switches. */
export function ThemeSync(): null {
  const { theme } = useTheme()
  useEffect(() => {
    readThemeMaterials(true)
  }, [theme])
  return null
}

/** Crisp emissive wireframe material (dispose in caller cleanup). */
export function makeWireMaterial(
  color: THREE.Color,
  opacity = 0.55,
  emissiveIntensity = 0.85,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity,
    wireframe: true,
    transparent: true,
    opacity,
    depthWrite: false,
  })
}

/**
 * Translucent optical-glass solid core material for architectural depth &
 * specular sheen beneath wireframe/edge cages (dispose in caller cleanup).
 */
export function makeGlassCoreMaterial(
  color: THREE.Color,
  opacity = 0.22,
  emissiveIntensity = 0.35,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity,
    roughness: 0.28,
    metalness: 0.35,
    transparent: true,
    opacity,
    depthWrite: false,
  })
}

/** Crisp razor-sharp edge-cage LineBasicMaterial (dispose in caller cleanup). */
export function makeEdgeLineMaterial(color: THREE.Color, opacity = 0.82): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  })
}
