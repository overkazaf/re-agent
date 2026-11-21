// ZoneMarker — 区块标记：底座圆环 + 中心 glyph + 文字标签。
// 标签用 drei <Html>（DOM overlay）而非 <Text>：troika 默认从 CDN 拉字体，
// Wails 桌面离线场景会挂。Html 内容走 CSS 变量（.glow-* / var(--accent)）保持 CRT 风格。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { ZoneKey, ZoneSpec } from './contract'
import { sceneActions } from '../store/scene'
import { makeWireMaterial, type TheaterMaterials } from './ThemeMaterials'

interface ZoneMarkerProps {
  zone: ZoneSpec
  materials: TheaterMaterials
  /** 当前相位所在区（rail.activeIndex → PHASE_ZONE 映射）：脉冲最亮 */
  active?: boolean
  /** 空态：TRI 入口呼吸光（其余区不挂载） */
  breathing?: boolean
}

export function ZoneMarker({ zone, materials, active = false, breathing = false }: ZoneMarkerProps) {
  const [hovered, setHovered] = useState(false)
  const glyphRef = useRef<THREE.Group>(null)
  const r = zone.radius

  const mat = useMemo(() => makeWireMaterial(materials.accent, 0.5, 0.9), [materials])
  useEffect(() => () => mat.dispose(), [mat])

  useFrame(({ clock }, delta) => {
    const base = 0.9
    if (breathing) mat.emissiveIntensity = base + Math.sin(clock.elapsedTime * 1.4) * 0.55
    else if (active) mat.emissiveIntensity = base + 1.1 + Math.sin(clock.elapsedTime * 3.2) * 0.6
    else if (hovered) mat.emissiveIntensity = base + 0.8
    else mat.emissiveIntensity = base
    if (glyphRef.current) glyphRef.current.rotation.y += delta * 0.25
  })

  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    setHovered(true)
    document.body.style.cursor = 'pointer'
  }
  const onOut = () => {
    setHovered(false)
    document.body.style.cursor = ''
  }
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    sceneActions.setFocus({ kind: 'zone', zone: zone.key })
  }

  return (
    <group position={zone.center}>
      {/* 底座圆环（视觉） */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.15} material={mat}>
        <ringGeometry args={[r * 0.7, r, 48, 1]} />
      </mesh>
      {/* 命中盘（透明整圆）：圆环中空，补上区中心的点击命中 */}
      <mesh
        rotation-x={-Math.PI / 2}
        position-y={0.12}
        onPointerOver={onOver}
        onPointerOut={onOut}
        onClick={onClick}
      >
        <circleGeometry args={[r, 40]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <group ref={glyphRef}>{renderGlyph(zone.key, r, mat)}</group>
      <Html position={[0, labelY(zone.key, r), 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className="glow-accent"
          style={{ fontSize: 11, letterSpacing: '0.16em', whiteSpace: 'nowrap', opacity: 0.92 }}
        >
          {zone.label}
        </div>
      </Html>
    </group>
  )
}

/** 中心 glyph：简单几何表意（TRI 四面体 / SCR 屏 / HYP 塔 / EXP 六边台 / VER 立方台 / AUD 拱门 / DEL 船坞）。 */
function renderGlyph(key: ZoneKey, r: number, mat: THREE.Material): ReactNode {
  switch (key) {
    case 'TRI':
      return (
        <mesh position-y={r * 0.42} material={mat} rotation-y={Math.PI * 0.25}>
          <tetrahedronGeometry args={[r * 0.38, 0]} />
        </mesh>
      )
    case 'SCR':
      return (
        <mesh position-y={r * 0.55} material={mat} rotation-y={-0.35}>
          <boxGeometry args={[r * 0.95, r * 0.6, 0.3]} />
        </mesh>
      )
    case 'HYP':
      return (
        <mesh position-y={r * 0.8} material={mat}>
          <cylinderGeometry args={[r * 0.12, r * 0.2, r * 1.6, 6, 1, true]} />
        </mesh>
      )
    case 'EXP':
      return (
        <mesh position-y={0.5} material={mat}>
          <cylinderGeometry args={[r * 0.55, r * 0.55, 0.9, 6]} />
        </mesh>
      )
    case 'VER':
      return (
        <mesh position-y={0.8} material={mat}>
          <boxGeometry args={[r * 0.75, 1.5, r * 0.75]} />
        </mesh>
      )
    case 'AUD':
      return (
        <group>
          <mesh position={[r * 0.45, r * 0.5, 0]} material={mat}>
            <boxGeometry args={[0.9, r, 0.9]} />
          </mesh>
          <mesh position={[-r * 0.45, r * 0.5, 0]} material={mat}>
            <boxGeometry args={[0.9, r, 0.9]} />
          </mesh>
          <mesh position={[0, r * 1.02, 0]} material={mat}>
            <boxGeometry args={[r * 1.1, 0.6, 0.9]} />
          </mesh>
        </group>
      )
    case 'DEL':
      return (
        <group>
          <mesh position={[0, 0.4, -r * 0.35]} material={mat}>
            <boxGeometry args={[r * 0.95, 0.7, 0.6]} />
          </mesh>
          <mesh position={[r * 0.45, 0.4, 0]} material={mat}>
            <boxGeometry args={[0.6, 0.7, r * 0.75]} />
          </mesh>
          <mesh position={[-r * 0.45, 0.4, 0]} material={mat}>
            <boxGeometry args={[0.6, 0.7, r * 0.75]} />
          </mesh>
        </group>
      )
  }
}

function labelY(key: ZoneKey, r: number): number {
  switch (key) {
    case 'TRI':
      return r * 0.95
    case 'SCR':
      return r * 1.0
    case 'HYP':
      // 越过棱镜群（derive 的假设节点 y≈10..18 + 标签），避免与 H-NNN 叠字
      return r * 2.5
    case 'AUD':
      return r * 1.45
    default:
      // EXP / VER / DEL：高于 glyph 顶部（旧值 3.2 会压在底座圆环上）
      return r * 1.05
  }
}
