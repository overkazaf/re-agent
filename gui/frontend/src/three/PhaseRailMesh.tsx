// PhaseRailMesh — Dual-layer optical conduit along the 9-phase RE workflow spine
// (TRI→SCR→HYP→EXP→VER→AUD→DEL): inner luminous core tube + subtle outer
// wireframe sheath + traveling telemetry pulse bead along the active segment.
// Archived workflow transitions cleanly to calm golden amber.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { PHASE_ZONE, zoneOf, type PhaseRail, type ZoneKey } from './contract'
import type { TheaterMaterials } from './ThemeMaterials'

const PHASES = 9

/** Deduplicated zone waypoints in workflow order. */
const WAYPOINTS: THREE.Vector3[] = (() => {
  const seen: ZoneKey[] = []
  for (const z of PHASE_ZONE) {
    if (seen[seen.length - 1] !== z) seen.push(z)
  }
  return seen.map((z) => new THREE.Vector3(...zoneOf(z).center))
})()

interface ChunkData {
  curve: THREE.CatmullRomCurve3
  coreGeo: THREE.TubeGeometry
  sheathGeo: THREE.TubeGeometry
}

function buildChunks(): ChunkData[] {
  const spine = new THREE.CatmullRomCurve3(WAYPOINTS, false, 'catmullrom', 0.25)
  const chunks: ChunkData[] = []
  const SUBDIV = 6
  for (let k = 0; k < PHASES; k++) {
    const pts: THREE.Vector3[] = []
    for (let j = 0; j <= SUBDIV; j++) {
      pts.push(spine.getPoint((k + j / SUBDIV) / PHASES))
    }
    const curve = new THREE.CatmullRomCurve3(pts)
    chunks.push({
      curve,
      coreGeo: new THREE.TubeGeometry(curve, 12, 0.14, 8, false),
      sheathGeo: new THREE.TubeGeometry(curve, 10, 0.36, 6, false),
    })
  }
  return chunks
}

const PULSE_GEO = new THREE.SphereGeometry(0.42, 12, 12)

export function PhaseRailMesh({ rail, materials }: { rail: PhaseRail; materials: TheaterMaterials }) {
  const chunks = useMemo(buildChunks, [])
  useEffect(
    () => () => {
      chunks.forEach((c) => {
        c.coreGeo.dispose()
        c.sheathGeo.dispose()
      })
    },
    [chunks],
  )

  const activeCoreRef = useRef<THREE.MeshStandardMaterial | null>(null)
  const pulseRef = useRef<THREE.Mesh | null>(null)
  const activeChunk = !rail.archived && rail.activeIndex >= 0 && rail.activeIndex < PHASES ? chunks[rail.activeIndex] : null

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (activeCoreRef.current) {
      activeCoreRef.current.emissiveIntensity = 1.45 + Math.sin(t * 3.0) * 0.55
    }
    if (pulseRef.current && activeChunk) {
      const u = (t * 0.45) % 1
      const p = activeChunk.curve.getPoint(u)
      pulseRef.current.position.copy(p)
    }
  })

  return (
    <group>
      {chunks.map((c, i) => {
        const isActive = !rail.archived && i === rail.activeIndex
        const done = rail.archived || i < rail.activeIndex
        const color = rail.archived ? materials.amber : materials.accent
        return (
          <group key={i}>
            {/* Inner luminous optical spine */}
            <mesh geometry={c.coreGeo}>
              <meshStandardMaterial
                ref={isActive ? activeCoreRef : undefined}
                color={color}
                emissive={color}
                emissiveIntensity={done ? 1.15 : isActive ? 1.45 : 0.22}
                transparent
                opacity={done ? 0.88 : isActive ? 0.96 : 0.22}
                depthWrite={false}
              />
            </mesh>
            {/* Outer architectural wireframe sheath */}
            <mesh geometry={c.sheathGeo}>
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={done ? 0.65 : isActive ? 0.95 : 0.15}
                wireframe
                transparent
                opacity={done ? 0.36 : isActive ? 0.55 : 0.12}
                depthWrite={false}
              />
            </mesh>
          </group>
        )
      })}
      {/* Traveling telemetry pulse bead on the active phase segment */}
      {activeChunk && (
        <mesh ref={pulseRef} geometry={PULSE_GEO}>
          <meshBasicMaterial color={materials.accent} transparent opacity={0.95} />
        </mesh>
      )}
    </group>
  )
}
