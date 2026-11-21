// PhaseRailMesh — 相位主线能量脊：TRI→…→DEL 沿 9 阶段骨架的折线管道
// （CatmullRomCurve3 + TubeGeometry 线框）。按 rail.activeIndex 分段着色：
// 已走段实心 emissive、当前段 useFrame 脉冲、未到段半透明虚化（opacity 0.25）；
// archived 后整条转金色（--amber）并停止脉冲。
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { PHASE_ZONE, zoneOf, type PhaseRail, type ZoneKey } from './contract'
import type { TheaterMaterials } from './ThemeMaterials'

const PHASES = 9

/** 主线路径：按 PHASE_ZONE 顺序去重后的区中心（TRI→SCR→HYP→EXP→VER→AUD→DEL）。 */
const WAYPOINTS: THREE.Vector3[] = (() => {
  const seen: ZoneKey[] = []
  for (const z of PHASE_ZONE) {
    if (seen[seen.length - 1] !== z) seen.push(z)
  }
  return seen.map((z) => new THREE.Vector3(...zoneOf(z).center))
})()

/** 每相位一段的管道几何（9 段等参数分割，段序号 == phaseIndex，与 PHASE_ZONE 对齐）。 */
function buildChunkGeometries(): THREE.TubeGeometry[] {
  const curve = new THREE.CatmullRomCurve3(WAYPOINTS, false, 'catmullrom', 0.25)
  const geoms: THREE.TubeGeometry[] = []
  const SUBDIV = 6
  for (let k = 0; k < PHASES; k++) {
    const pts: THREE.Vector3[] = []
    for (let j = 0; j <= SUBDIV; j++) {
      pts.push(curve.getPoint((k + j / SUBDIV) / PHASES))
    }
    geoms.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.32, 6, false))
  }
  return geoms
}

export function PhaseRailMesh({ rail, materials }: { rail: PhaseRail; materials: TheaterMaterials }) {
  const geoms = useMemo(buildChunkGeometries, [])
  useEffect(
    () => () => {
      geoms.forEach((g) => g.dispose())
    },
    [geoms],
  )
  const activeMatRef = useRef<THREE.MeshStandardMaterial | null>(null)

  useFrame(({ clock }) => {
    if (activeMatRef.current) {
      activeMatRef.current.emissiveIntensity = 1.6 + Math.sin(clock.elapsedTime * 3.4) * 0.9
    }
  })

  return (
    <group>
      {geoms.map((g, i) => {
        const isActive = !rail.archived && i === rail.activeIndex
        const done = rail.archived || i < rail.activeIndex
        const color = rail.archived ? materials.amber : materials.accent
        return (
          <mesh key={i} geometry={g}>
            <meshStandardMaterial
              ref={isActive ? activeMatRef : undefined}
              color={color}
              emissive={color}
              emissiveIntensity={done ? 1.3 : isActive ? 1.6 : 0.25}
              wireframe
              transparent
              opacity={done ? 0.85 : isActive ? 0.95 : 0.25}
              depthWrite={false}
            />
          </mesh>
        )
      })}
    </group>
  )
}
