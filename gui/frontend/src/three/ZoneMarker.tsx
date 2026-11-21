// ZoneMarker — Architectural zone landing pad: concentric precision rings,
// translucent platform disc, dual-layer optical glass + wireframe glyph,
// active vertical beacon, and frosted obsidian HTML label pill.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { ZoneKey, ZoneSpec } from './contract'
import { sceneActions } from '../store/scene'
import { makeGlassCoreMaterial, makeWireMaterial, type TheaterMaterials } from './ThemeMaterials'

interface ZoneMarkerProps {
  zone: ZoneSpec
  materials: TheaterMaterials
  /** Current workflow phase zone: illuminated ring + soft beacon */
  active?: boolean
  /** Empty state: TRI breathing entry beacon */
  breathing?: boolean
}

export function ZoneMarker({ zone, materials, active = false, breathing = false }: ZoneMarkerProps) {
  const [hovered, setHovered] = useState(false)
  const glyphRef = useRef<THREE.Group>(null)
  const r = zone.radius

  const wireMat = useMemo(
    () => makeWireMaterial(materials.accent, active ? 0.72 : 0.44, active ? 1.1 : 0.68),
    [materials, active],
  )
  const coreMat = useMemo(
    () => makeGlassCoreMaterial(materials.accent, active ? 0.24 : 0.12, active ? 0.52 : 0.22),
    [materials, active],
  )
  const ringMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: active ? materials.accent : materials.faint,
        transparent: true,
        opacity: active ? 0.78 : 0.38,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [materials, active],
  )
  const padMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: materials.accent,
        transparent: true,
        opacity: active ? 0.11 : 0.045,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [materials, active],
  )
  const beaconMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: materials.accent,
        transparent: true,
        opacity: 0.055,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [materials],
  )

  useEffect(
    () => () => {
      wireMat.dispose()
      coreMat.dispose()
      ringMat.dispose()
      padMat.dispose()
      beaconMat.dispose()
    },
    [wireMat, coreMat, ringMat, padMat, beaconMat],
  )

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime
    const base = active ? 1.05 : 0.65
    if (breathing) {
      const wave = Math.sin(t * 1.4)
      wireMat.emissiveIntensity = 0.85 + wave * 0.42
      ringMat.opacity = 0.48 + wave * 0.2
    } else if (active) {
      const wave = Math.sin(t * 2.8)
      wireMat.emissiveIntensity = base + 0.55 + wave * 0.35
      coreMat.emissiveIntensity = 0.48 + wave * 0.16
      ringMat.opacity = 0.76 + wave * 0.16
      beaconMat.opacity = 0.05 + wave * 0.02
    } else if (hovered) {
      wireMat.emissiveIntensity = base + 0.75
      coreMat.opacity = 0.22
      ringMat.opacity = 0.72
      padMat.opacity = 0.1
    } else {
      wireMat.emissiveIntensity = base
      coreMat.opacity = 0.12
      ringMat.opacity = 0.38
      padMat.opacity = 0.045
    }
    if (glyphRef.current) glyphRef.current.rotation.y += delta * (active ? 0.34 : 0.18)
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
      {/* Recessed translucent landing pad disc */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.08} material={padMat}>
        <circleGeometry args={[r * 0.94, 48]} />
      </mesh>
      {/* Crisp outer precision ring */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.14} material={ringMat}>
        <ringGeometry args={[r * 0.93, r, 64, 1]} />
      </mesh>
      {/* Inner calibration ring */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.13} material={ringMat}>
        <ringGeometry args={[r * 0.65, r * 0.68, 48, 1]} />
      </mesh>
      {/* Soft vertical beacon on active zone */}
      {active && (
        <mesh position-y={r * 0.7} material={beaconMat}>
          <cylinderGeometry args={[r * 0.35, r * 0.68, r * 1.4, 24, 1, true]} />
        </mesh>
      )}
      {/* Invisible full-circle click target */}
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
      {/* Dual-layer architectural glyph */}
      <group ref={glyphRef}>
        {renderGlyph(zone.key, r, coreMat, false)}
        {renderGlyph(zone.key, r, wireMat, true)}
      </group>
      <Html position={labelPos(zone.key, r)} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className={`theater-chip${active || hovered ? ' theater-chip--active' : ''}`}
          style={{ opacity: active || hovered ? 1 : 0.88 }}
        >
          <span className="theater-zone-code">{zone.key}</span>
          <span className="theater-zone-name">{zone.label}</span>
        </div>
      </Html>
    </group>
  )
}

/** Zone center architectural glyph: rendered twice (optical core + crisp wireframe cage). */
function renderGlyph(key: ZoneKey, r: number, mat: THREE.Material, outer: boolean): ReactNode {
  const s = outer ? 1.015 : 0.985
  switch (key) {
    case 'TRI':
      return (
        <mesh position-y={r * 0.42} material={mat} rotation-y={Math.PI * 0.25} scale={s}>
          <tetrahedronGeometry args={[r * 0.38, 0]} />
        </mesh>
      )
    case 'SCR':
      return (
        <mesh position-y={r * 0.55} material={mat} rotation-y={-0.35} scale={s}>
          <boxGeometry args={[r * 0.95, r * 0.6, 0.32]} />
        </mesh>
      )
    case 'HYP':
      return (
        <mesh position-y={r * 0.8} material={mat} scale={s}>
          <cylinderGeometry args={[r * 0.13, r * 0.22, r * 1.6, 6, 1, outer]} />
        </mesh>
      )
    case 'EXP':
      return (
        <mesh position-y={0.5} material={mat} scale={s}>
          <cylinderGeometry args={[r * 0.55, r * 0.55, 0.9, 6]} />
        </mesh>
      )
    case 'VER':
      return (
        <mesh position-y={0.8} material={mat} scale={s}>
          <boxGeometry args={[r * 0.75, 1.5, r * 0.75]} />
        </mesh>
      )
    case 'AUD':
      return (
        <group scale={s}>
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
        <group scale={s}>
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

function labelPos(key: ZoneKey, r: number): [number, number, number] {
  switch (key) {
    case 'TRI':
      return [0, r * 0.82, -r * 0.2]
    case 'SCR':
      return [0, r * 1.02, 0]
    case 'HYP':
      // Anchor HYP zone badge cleanly at the front rim of its pad so floating
      // H-NNN hypothesis prisms (y=10..22) above the tower never collide with it.
      return [0, 1.4, r * 1.16]
    case 'AUD':
      return [0, r * 1.42, 0]
    default:
      return [0, r * 1.02, 0]
  }
}
