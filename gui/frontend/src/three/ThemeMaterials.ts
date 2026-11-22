// ThemeMaterials — CSS design tokens -> Three.js color, shader & texture bridge.
// Re-reads computed styles whenever the active theme changes and exposes
// calibrated optical-glass, Fresnel holo-shader, anti-aliased radar floor,
// procedural disassembly plate texture, and crisp wireframe/edge material
// factories across all 10 curated themes (including Daylight Lab `paper`).
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

const HOLO_FRESNEL_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const HOLO_FRESNEL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uRimPower;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uScanDensity;
  uniform float uIsLight;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;

  void main() {
    vec3 n = normalize(vWorldNormal);
    if (!gl_FrontFacing) n = -n;
    float ndotv = clamp(abs(dot(n, normalize(vViewDir))), 0.0, 1.0);
    float fresnel = pow(1.0 - ndotv, uRimPower);

    // Dual-frequency horizontal holographic scanlines scrolling gently upward
    float coarseScan = 0.86 + 0.14 * sin(vWorldPos.y * uScanDensity * 6.2831853 - uTime * 2.4);
    float fineScan = 0.94 + 0.06 * sin(vWorldPos.y * uScanDensity * 22.0 + uTime * 1.1);
    float scan = coarseScan * fineScan;

    vec3 col;
    float alpha;
    if (uIsLight > 0.5) {
      // Technical blueprint glass on daylight paper theme: deep ink rim, clean airy center
      vec3 coreTint = mix(uColor * 0.92, uColor * 0.58, fresnel);
      col = coreTint * (0.9 + 0.15 * scan);
      alpha = clamp(uOpacity * (0.16 + 0.88 * fresnel) * scan * uIntensity, 0.0, 0.88);
    } else {
      // Luminous cyber-forensic hologram on dark themes: razor Fresnel rim + bright edge highlight
      vec3 rimHighlight = mix(uColor, vec3(1.0), fresnel * 0.32);
      col = rimHighlight * (0.62 + 1.05 * fresnel) * uIntensity;
      alpha = clamp(uOpacity * (0.20 + 0.98 * fresnel) * scan * uIntensity, 0.0, 0.94);
    }

    gl_FragColor = vec4(col, alpha);
  }
`

export interface HoloFresnelOptions {
  isLight?: boolean
  scanDensity?: number
}

/**
 * Custom GLSL Fresnel + horizontal holo-scanline ShaderMaterial (dispose in caller cleanup).
 * Renders crisp luminous holo-glass on dark themes and technical blueprint glass on light `paper`.
 */
export function makeHoloFresnelMaterial(
  color: THREE.Color,
  opacity = 0.44,
  rimPower = 2.35,
  options?: HoloFresnelOptions,
): THREE.ShaderMaterial {
  const isLight = options?.isLight ?? cache?.isLight ?? false
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uRimPower: { value: rimPower },
      uTime: { value: 0 },
      uIntensity: { value: 1.0 },
      uScanDensity: { value: options?.scanDensity ?? 1.45 },
      uIsLight: { value: isLight ? 1.0 : 0.0 },
    },
    vertexShader: HOLO_FRESNEL_VERT,
    fragmentShader: HOLO_FRESNEL_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

const RADAR_FLOOR_VERT = /* glsl */ `
  varying vec2 vWorldXZ;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const RADAR_FLOOR_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uGridColor;
  uniform vec3 uAccentColor;
  uniform vec3 uFaintColor;
  uniform float uMaxRadius;
  uniform float uSweepSpeed;
  uniform float uGlow;
  uniform float uIsLight;

  varying vec2 vWorldXZ;

  float aaGrid(vec2 coord, float cellSize, float widthPx) {
    vec2 p = coord / cellSize;
    vec2 fw = max(fwidth(p), vec2(0.0001));
    vec2 g = abs(fract(p - 0.5) - 0.5) / fw;
    float line = min(g.x, g.y);
    return 1.0 - smoothstep(0.0, widthPx, line);
  }

  float aaRing(float dist, float radius, float widthPx) {
    float fw = max(fwidth(dist), 0.0001);
    float d = abs(dist - radius) / fw;
    return 1.0 - smoothstep(0.0, widthPx, d);
  }

  float aaAxis(float coord, float widthPx) {
    float fw = max(fwidth(coord), 0.0001);
    return 1.0 - smoothstep(0.0, widthPx, abs(coord) / fw);
  }

  void main() {
    float dist = length(vWorldXZ);
    if (dist > uMaxRadius) discard;

    // Smooth radial distance vignette fade (zero square edge cutoff)
    float radialFade = 1.0 - smoothstep(uMaxRadius * 0.64, uMaxRadius, dist);
    float innerFade = 1.0 - smoothstep(uMaxRadius * 0.44, uMaxRadius * 0.80, dist);

    // Anti-aliased sub-grid (4u) + major coordinate grid (16u)
    float subGrid = aaGrid(vWorldXZ, 4.0, 1.05) * innerFade;
    float majorGrid = aaGrid(vWorldXZ, 16.0, 1.38) * radialFade;

    // Micro "+" ticks at major 16-unit grid intersections
    vec2 cellLocal = abs(fract(vWorldXZ / 16.0 + 0.5) - 0.5) * 16.0;
    float crossX = (1.0 - smoothstep(0.0, 1.25, cellLocal.y / max(fwidth(vWorldXZ.y), 0.0001))) * step(cellLocal.x, 0.85);
    float crossZ = (1.0 - smoothstep(0.0, 1.25, cellLocal.x / max(fwidth(vWorldXZ.x), 0.0001))) * step(cellLocal.y, 0.85);
    float crossTick = max(crossX, crossZ) * innerFade;

    // Cardinal axes (X=0, Z=0)
    float axisLine = max(aaAxis(vWorldXZ.x, 1.5), aaAxis(vWorldXZ.y, 1.5)) * radialFade;

    // Concentric tactical range rings
    float ringInner = aaRing(dist, 22.0, 1.25);
    float ringMid = aaRing(dist, 42.0, 1.5);
    float ringOuter = aaRing(dist, 64.0, 1.25);
    float ringEdge = aaRing(dist, 86.0, 1.65);

    // Slow rotating forensic radar sweep beam
    float angle = atan(vWorldXZ.y, vWorldXZ.x);
    float sweepAngle = mod(-uTime * uSweepSpeed, 6.2831853) - 3.14159265;
    float dAngle = mod(sweepAngle - angle + 6.2831853, 6.2831853);
    float sweepMask = smoothstep(2.0, 10.0, dist) * (1.0 - smoothstep(82.0, 89.0, dist));
    float sweepLead = exp(-dAngle * 46.0) * sweepMask;
    float sweepTrail = pow(smoothstep(0.88, 0.0, dAngle), 1.9) * sweepMask;

    // Phosphor/ink excitation when the radar sweep passes over lines
    float excite = 1.0 + sweepTrail * 1.35 + sweepLead * 2.0;

    vec3 col = vec3(0.0);
    float alpha = 0.0;

    if (uIsLight > 0.5) {
      // Daylight paper blueprint style: crisp drafting lines + subtle cobalt sweep wash
      float subA = subGrid * 0.14;
      float majA = majorGrid * 0.34;
      float tickA = crossTick * 0.42;
      float axA = axisLine * 0.38;
      float rngA = (ringInner * 0.28 + ringMid * 0.44 + ringOuter * 0.28 + ringEdge * 0.48);
      float swpA = sweepTrail * 0.075 + sweepLead * 0.28;

      vec3 gridCol = mix(uGridColor, uFaintColor, 0.28);
      vec3 hiCol = uAccentColor;

      float wBase = subA + majA;
      float wAccent = tickA + axA + rngA + swpA;
      alpha = clamp(wBase + wAccent, 0.0, 0.72);
      col = mix(gridCol, hiCol, clamp(wAccent / max(alpha, 0.0001), 0.0, 1.0));
    } else {
      // Dark cyber-forensic deck: razor anti-aliased grid + NORAD phosphor sweep
      float glowBoost = 0.72 + uGlow * 0.55;
      float subA = subGrid * 0.14 * excite;
      float majA = majorGrid * 0.32 * excite;
      float tickA = crossTick * 0.48 * excite;
      float axA = axisLine * 0.38;
      float rngA = (ringInner * 0.26 + ringMid * 0.46 + ringOuter * 0.28 + ringEdge * 0.52) * excite;
      float swpA = (sweepTrail * 0.12 + sweepLead * 0.42) * glowBoost;

      vec3 accum =
        uGridColor * (subA + majA * 0.85) +
        uFaintColor * (axA + ringInner * 0.24 + ringOuter * 0.24) +
        uAccentColor * (tickA * 0.85 + ringMid * 0.52 + ringEdge * 0.62 + swpA * 1.25);

      alpha = clamp(subA + majA + tickA * 0.7 + axA + rngA + swpA, 0.0, 0.86);
      col = accum / max(alpha, 0.001);
      // Slight rim crispness on radar leading edge
      col = mix(col, mix(uAccentColor, vec3(1.0), 0.35), clamp(sweepLead * 0.85, 0.0, 1.0));
    }

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }
`

/**
 * Anti-aliased GLSL tactical radar floor ShaderMaterial (dispose in caller cleanup).
 * Features fwidth sub/major grid, radial vignette fade, concentric range rings,
 * and a slow rotating forensic radar sweep beam.
 */
export function makeRadarFloorMaterial(materials: TheaterMaterials): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGridColor: { value: materials.rule.clone() },
      uAccentColor: { value: materials.accent.clone() },
      uFaintColor: { value: materials.faint.clone() },
      uMaxRadius: { value: 112.0 },
      uSweepSpeed: { value: 0.28 },
      uGlow: { value: materials.glowStrength },
      uIsLight: { value: materials.isLight ? 1.0 : 0.0 },
    },
    vertexShader: RADAR_FLOOR_VERT,
    fragmentShader: RADAR_FLOOR_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

const DISASM_LINES: readonly { addr: string; hex: string; op: string; args: string; highlight?: 'accent' | 'amber' | 'ok' }[] = [
  { addr: '0x00401000', hex: '55', op: 'push', args: 'rbp' },
  { addr: '0x00401001', hex: '48 89 e5', op: 'mov', args: 'rbp, rsp' },
  { addr: '0x00401004', hex: '48 8b 47 18', op: 'mov', args: 'rax, [rdi+0x18]', highlight: 'accent' },
  { addr: '0x00401008', hex: '83 f0 2a', op: 'xor', args: 'eax, 0x2a', highlight: 'amber' },
  { addr: '0x0040100b', hex: '48 85 c0', op: 'test', args: 'rax, rax' },
  { addr: '0x0040100e', hex: '75 3c', op: 'jne', args: '0x40104c', highlight: 'amber' },
  { addr: '0x00401010', hex: 'e8 7b 02 00 00', op: 'call', args: 'verify_sig', highlight: 'ok' },
  { addr: '0x00401015', hex: '0f b6 04 0f', op: 'movzx', args: 'eax, byte [rdi+rcx]' },
  { addr: '0x00401019', hex: '35 ad de 00 00', op: 'xor', args: 'eax, 0xdead' },
  { addr: '0x0040101e', hex: 'c9', op: 'leave', args: '' },
  { addr: '0x0040101f', hex: 'c3', op: 'ret', args: '' },
]

const ENTROPY_BARS = [0.42, 0.68, 0.91, 0.84, 0.52, 0.77, 0.95, 0.88, 0.61, 0.45, 0.73]

function cssRgb(color: THREE.Color, alpha = 1): string {
  const r = Math.round(color.r * 255)
  const g = Math.round(color.g * 255)
  const b = Math.round(color.b * 255)
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Procedural crisp monospace disassembly/hex CanvasTexture for holographic data
 * plates (dispose in caller cleanup). Calibrated for both dark decks and light `paper`.
 */
export function makeDisasmCanvasTexture(materials: TheaterMaterials): THREE.CanvasTexture {
  if (typeof document === 'undefined') {
    const fallback = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : (null as unknown as HTMLCanvasElement)
    return new THREE.CanvasTexture(fallback)
  }
  const width = 512
  const height = 320
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (ctx) {
    const isLight = materials.isLight
    const monoFont = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

    // Translucent holographic plate substrate
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.86)' : cssRgb(materials.bg, 0.74)
    ctx.fillRect(4, 4, width - 8, height - 8)

    // Subtle horizontal scanlines across the plate
    ctx.fillStyle = cssRgb(materials.accent, isLight ? 0.045 : 0.055)
    for (let y = 8; y < height - 8; y += 6) {
      ctx.fillRect(6, y, width - 12, 1)
    }

    // Perimeter frame + crisp corner registration brackets
    ctx.strokeStyle = cssRgb(materials.accent, isLight ? 0.55 : 0.62)
    ctx.lineWidth = 1.5
    ctx.strokeRect(5, 5, width - 10, height - 10)

    const bLen = 16
    ctx.strokeStyle = cssRgb(materials.accent, 0.95)
    ctx.lineWidth = 2.5
    const drawCorner = (x: number, y: number, dx: number, dy: number) => {
      ctx.beginPath()
      ctx.moveTo(x, y + dy * bLen)
      ctx.lineTo(x, y)
      ctx.lineTo(x + dx * bLen, y)
      ctx.stroke()
    }
    drawCorner(5, 5, 1, 1)
    drawCorner(width - 5, 5, -1, 1)
    drawCorner(5, height - 5, 1, -1)
    drawCorner(width - 5, height - 5, -1, -1)

    // Header telemetry bar
    ctx.fillStyle = cssRgb(materials.accent, isLight ? 0.12 : 0.16)
    ctx.fillRect(6, 6, width - 12, 26)
    ctx.font = `700 11px ${monoFont}`
    ctx.fillStyle = cssRgb(materials.accent, 0.98)
    ctx.fillText('// DISASM · .text+0x00401000 · ELF64', 14, 23)
    ctx.fillStyle = cssRgb(materials.amber, 0.95)
    ctx.fillText('H:7.42', width - 64, 23)

    // Disassembly listing rows
    const rowStart = 50
    const rowStep = 21
    DISASM_LINES.forEach((row, idx) => {
      const y = rowStart + idx * rowStep
      if (row.highlight) {
        const hiCol =
          row.highlight === 'amber' ? materials.amber : row.highlight === 'ok' ? materials.ok : materials.accent
        ctx.fillStyle = cssRgb(hiCol, isLight ? 0.13 : 0.16)
        ctx.fillRect(10, y - 13, width - 68, 18)
        ctx.fillStyle = cssRgb(hiCol, 0.92)
        ctx.fillRect(10, y - 13, 3, 18)
      }

      ctx.font = `600 11px ${monoFont}`
      ctx.fillStyle = cssRgb(materials.faint, isLight ? 0.95 : 0.9)
      ctx.fillText(`${row.addr}:`, 18, y)

      ctx.font = `500 10.5px ${monoFont}`
      ctx.fillStyle = cssRgb(materials.muted, isLight ? 0.85 : 0.72)
      ctx.fillText(row.hex, 108, y)

      ctx.font = `700 11.5px ${monoFont}`
      const opColor =
        row.highlight === 'amber'
          ? materials.amber
          : row.highlight === 'ok'
            ? materials.ok
            : materials.accent
      ctx.fillStyle = cssRgb(opColor, 0.98)
      ctx.fillText(row.op, 218, y)

      if (row.args) {
        ctx.font = `500 11.5px ${monoFont}`
        ctx.fillStyle = cssRgb(materials.text, 0.94)
        ctx.fillText(row.args, 268, y)
      }

      // Right-column entropy tick bar
      const barMax = 38
      const barW = Math.round(ENTROPY_BARS[idx % ENTROPY_BARS.length] * barMax)
      ctx.fillStyle = cssRgb(materials.rule, isLight ? 0.45 : 0.5)
      ctx.fillRect(width - 52, y - 9, barMax, 6)
      ctx.fillStyle = cssRgb(idx === 3 || idx === 5 ? materials.amber : materials.accent, 0.85)
      ctx.fillRect(width - 52, y - 9, barW, 6)
    })

    // Vertical divider before entropy column
    ctx.strokeStyle = cssRgb(materials.rule, 0.55)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(width - 58, 36)
    ctx.lineTo(width - 58, height - 30)
    ctx.stroke()

    // Footer status strip
    ctx.fillStyle = cssRgb(materials.rule, isLight ? 0.25 : 0.35)
    ctx.fillRect(6, height - 26, width - 12, 20)
    ctx.font = `600 10px ${monoFont}`
    ctx.fillStyle = cssRgb(materials.muted, 0.92)
    ctx.fillText('CFG: 0x401000..0x40104c   XREF: 3', 14, height - 12)
    ctx.fillStyle = cssRgb(materials.ok, 0.95)
    ctx.fillText('[SIG: VERIFY]', width - 98, height - 12)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}
