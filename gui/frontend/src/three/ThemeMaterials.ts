// ThemeMaterials — 主题 CSS 变量 → three 颜色/材质参数的唯一桥梁。
// CRT 质感：线框 + 自发光 + 透明；主题名变化时重读 computed style，
// 缓存对象整体换新引用，消费方用 useMemo 依赖它重建材质（旧材质 dispose）。
//
// 注意：R3F <Canvas> 是独立 reconciler root，React context 不穿透；
// 主题材料在 Canvas 外读取（useTheaterMaterials），再以 props 传入场景树。
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
  /** --accent-dim：暗化的主色（普通 ev 节点、次级结构） */
  faint: THREE.Color
  glowStrength: number
}

let cache: TheaterMaterials | null = null

/** 从 <html> 的 CSS 变量读主题色（模块级缓存；force=true 强制重读）。 */
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
  const glow = parseFloat(style.getPropertyValue('--glow-strength').trim())
  cache = {
    bg: read('--bg', '#05080c'),
    accent: read('--accent', 'rgb(34, 211, 238)'),
    ok: read('--ok', 'rgb(74, 222, 128)'),
    err: read('--err', 'rgb(248, 113, 113)'),
    violet: read('--violet', 'rgb(167, 139, 250)'),
    amber: read('--amber', 'rgb(251, 191, 36)'),
    faint: read('--accent-dim', 'rgb(14, 116, 144)'),
    glowStrength: Number.isFinite(glow) && glow > 0 ? glow : 1,
  }
  return cache
}

/** Canvas 外层使用：主题切换时返回全新对象（引用变化驱动下游重建）。 */
export function useTheaterMaterials(): TheaterMaterials {
  const { theme } = useTheme()
  // 主题名是唯一依赖：切换即重读 computed style。
  return useMemo(() => readThemeMaterials(true), [theme])
}

/** 挂在 Canvas 外：主题切换时刷新模块级缓存（供不便走 props 的场合直接 readThemeMaterials()）。 */
export function ThemeSync(): null {
  const { theme } = useTheme()
  useEffect(() => {
    readThemeMaterials(true)
  }, [theme])
  return null
}

/** CRT 线框自发光材质（剧场统一质感）。调用方在 useEffect 清理里 dispose。 */
export function makeWireMaterial(
  color: THREE.Color,
  opacity = 0.55,
  emissiveIntensity = 0.9,
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
