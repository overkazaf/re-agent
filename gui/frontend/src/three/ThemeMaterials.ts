// ThemeMaterials — CSS design tokens -> Three.js color & material bridge.
// Re-reads computed styles whenever the active theme changes and exposes
// calibrated optical-glass + crisp wireframe/edge material factories.
//
// Note: R3F <Canvas> uses a separate reconciler root where React context does
// not cross automatically; materials are resolved outside Canvas via
// useTheaterMaterials() and passed as props.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useTheme } from '../theme/ThemeContext'

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
}

let cache: TheaterMaterials | null = null

/** Reads theme colors from <html> computed CSS variables (cached; force=true refreshes). */
export function readThemeMaterials(force = false): TheaterMaterials {
  if (cache && !force) return cache
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): THREE.Color => {
    const raw = style.getPropertyValue(name).trim() || fallback
    try {
      return new THREE.Color(raw)
    } catch {
      return new THREE.Color(fallback)
    }
  }
  const amberRaw = style.getPropertyValue('--amber').trim() || style.getPropertyValue('--warn').trim()
  const glow = parseFloat(style.getPropertyValue('--glow-strength').trim())
  cache = {
    bg: read('--bg', '#070b11'),
    accent: read('--accent', 'rgb(34, 211, 238)'),
    ok: read('--ok', 'rgb(74, 222, 128)'),
    err: read('--err', 'rgb(248, 113, 113)'),
    violet: read('--violet', 'rgb(167, 139, 250)'),
    amber: amberRaw ? new THREE.Color(amberRaw) : new THREE.Color('rgb(251, 191, 36)'),
    faint: read('--accent-dim', 'rgb(14, 116, 144)'),
    rule: read('--rule', 'rgb(42, 56, 76)'),
    muted: read('--muted', 'rgb(156, 171, 192)'),
    text: read('--text', 'rgb(232, 237, 244)'),
    glowStrength: Number.isFinite(glow) && glow > 0 ? glow : 0.62,
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
