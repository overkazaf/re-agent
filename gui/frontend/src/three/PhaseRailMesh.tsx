// PhaseRailMesh — Dual-rail optical fiber data-bus along the 9-phase RE workflow
// spine (TRI→SCR→HYP→EXP→VER→AUD→DEL): central luminous core tube, twin parallel
// carrier rails with cross-tie optical brackets, station junction pylons, and
// multiple glowing animated data-packets streaming along completed segments
// toward the active phase frontier. Archived workflows shift to calm amber.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { PHASE_ZONE, zoneOf, type PhaseRail, type ZoneKey } from './contract'
import type { TheaterMaterials } from './ThemeMaterials'

const PHASES = 9
const RAIL_OFFSET = 0.56
const PACKET_COUNT = 10

interface WaypointSpec {
  zone: ZoneKey
  pos: THREE.Vector3
  firstPhaseIdx: number
}

/** Consecutive-deduplicated zone waypoints in workflow order for the spline curve. */
const WAYPOINTS: readonly WaypointSpec[] = (() => {
  const out: WaypointSpec[] = []
  PHASE_ZONE.forEach((z, idx) => {
    if (out[out.length - 1]?.zone !== z) {
      out.push({
        zone: z,
        pos: new THREE.Vector3(...zoneOf(z).center),
        firstPhaseIdx: idx,
      })
    }
  })
  return out
})()

/** Globally unique station pylons (one per visited ZoneKey, earliest phase index). */
const PYLONS: readonly WaypointSpec[] = (() => {
  const seen = new Set<ZoneKey>()
  const out: WaypointSpec[] = []
  for (const wp of WAYPOINTS) {
    if (seen.has(wp.zone)) continue
    seen.add(wp.zone)
    out.push(wp)
  }
  return out
})()

interface SegmentData {
  curve: THREE.CatmullRomCurve3
  coreGeo: THREE.TubeGeometry
  leftRailGeo: THREE.TubeGeometry
  rightRailGeo: THREE.TubeGeometry
  crossTieGeo: THREE.BufferGeometry
}

interface BusGeometryBundle {
  spine: THREE.CatmullRomCurve3
  segments: SegmentData[]
  pylonBaseGeo: THREE.CylinderGeometry
  pylonCoreGeo: THREE.OctahedronGeometry
  pylonEdgesGeo: THREE.EdgesGeometry
  packetCoreGeo: THREE.BoxGeometry
  packetHaloGeo: THREE.BoxGeometry
}

const UP = new THREE.Vector3(0, 1, 0)

function buildBusGeometries(): BusGeometryBundle {
  const spine = new THREE.CatmullRomCurve3(
    WAYPOINTS.map((w) => w.pos.clone()),
    false,
    'catmullrom',
    0.25,
  )

  const segments: SegmentData[] = []
  const SUBDIV = 10
  const tangent = new THREE.Vector3()
  const lateral = new THREE.Vector3()

  for (let k = 0; k < PHASES; k++) {
    const centerPts: THREE.Vector3[] = []
    const leftPts: THREE.Vector3[] = []
    const rightPts: THREE.Vector3[] = []
    const tiePts: number[] = []

    for (let j = 0; j <= SUBDIV; j++) {
      const u = (k + j / SUBDIV) / PHASES
      const pt = spine.getPoint(u)
      spine.getTangent(u, tangent)
      lateral.crossVectors(UP, tangent)
      if (lateral.lengthSq() < 1e-5) {
        lateral.set(1, 0, 0)
      } else {
        lateral.normalize()
      }

      const left = pt.clone().addScaledVector(lateral, RAIL_OFFSET)
      const right = pt.clone().addScaledVector(lateral, -RAIL_OFFSET)
      centerPts.push(pt)
      leftPts.push(left)
      rightPts.push(right)

      // Optical cross-tie couplers every 2 subdivisions
      if (j > 0 && j < SUBDIV && j % 2 === 0) {
        tiePts.push(left.x, left.y, left.z, right.x, right.y, right.z)
      }
    }

    const curve = new THREE.CatmullRomCurve3(centerPts)
    const leftCurve = new THREE.CatmullRomCurve3(leftPts)
    const rightCurve = new THREE.CatmullRomCurve3(rightPts)

    const crossTieGeo = new THREE.BufferGeometry()
    crossTieGeo.setAttribute('position', new THREE.Float32BufferAttribute(tiePts, 3))

    segments.push({
      curve,
      coreGeo: new THREE.TubeGeometry(curve, 16, 0.14, 8, false),
      leftRailGeo: new THREE.TubeGeometry(leftCurve, 14, 0.055, 6, false),
      rightRailGeo: new THREE.TubeGeometry(rightCurve, 14, 0.055, 6, false),
      crossTieGeo,
    })
  }

  const pylonBaseGeo = new THREE.CylinderGeometry(0.68, 0.84, 0.34, 6, 1)
  const pylonCoreGeo = new THREE.OctahedronGeometry(0.42, 0)
  const pylonEdgesGeo = new THREE.EdgesGeometry(pylonBaseGeo)
  const packetCoreGeo = new THREE.BoxGeometry(0.24, 0.24, 1.35)
  const packetHaloGeo = new THREE.BoxGeometry(0.56, 0.42, 1.95)

  return {
    spine,
    segments,
    pylonBaseGeo,
    pylonCoreGeo,
    pylonEdgesGeo,
    packetCoreGeo,
    packetHaloGeo,
  }
}

export function PhaseRailMesh({ rail, materials }: { rail: PhaseRail; materials: TheaterMaterials }) {
  const bus = useMemo(buildBusGeometries, [])

  // Shared materials per phase state (done / active / pending) so disposal is exact and zero leaks occur
  const mats = useMemo(() => {
    const tone = rail.archived ? materials.amber : materials.accent
    const isLight = materials.isLight

    const coreDone = new THREE.MeshStandardMaterial({
      color: tone,
      emissive: tone,
      emissiveIntensity: isLight ? 0.55 : 1.18,
      transparent: true,
      opacity: isLight ? 0.85 : 0.9,
      depthWrite: false,
    })
    const coreActive = new THREE.MeshStandardMaterial({
      color: tone,
      emissive: tone,
      emissiveIntensity: isLight ? 0.78 : 1.5,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    })
    const corePending = new THREE.MeshStandardMaterial({
      color: materials.rule,
      emissive: materials.faint,
      emissiveIntensity: isLight ? 0.12 : 0.2,
      transparent: true,
      opacity: isLight ? 0.36 : 0.24,
      depthWrite: false,
    })

    const railDone = new THREE.MeshStandardMaterial({
      color: tone,
      emissive: tone,
      emissiveIntensity: isLight ? 0.35 : 0.75,
      transparent: true,
      opacity: isLight ? 0.62 : 0.58,
      depthWrite: false,
    })
    const railActive = new THREE.MeshStandardMaterial({
      color: tone,
      emissive: tone,
      emissiveIntensity: isLight ? 0.6 : 1.1,
      transparent: true,
      opacity: isLight ? 0.82 : 0.84,
      depthWrite: false,
    })
    const railPending = new THREE.MeshStandardMaterial({
      color: materials.rule,
      emissive: materials.rule,
      emissiveIntensity: 0.1,
      transparent: true,
      opacity: isLight ? 0.28 : 0.18,
      depthWrite: false,
    })

    const tieDone = new THREE.LineBasicMaterial({
      color: tone,
      transparent: true,
      opacity: isLight ? 0.52 : 0.48,
      depthWrite: false,
    })
    const tiePending = new THREE.LineBasicMaterial({
      color: materials.rule,
      transparent: true,
      opacity: isLight ? 0.24 : 0.18,
      depthWrite: false,
    })

    const pylonActiveMat = new THREE.MeshStandardMaterial({
      color: tone,
      emissive: tone,
      emissiveIntensity: isLight ? 0.6 : 1.15,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    })
    const pylonIdleMat = new THREE.MeshStandardMaterial({
      color: materials.faint,
      emissive: materials.faint,
      emissiveIntensity: isLight ? 0.18 : 0.32,
      transparent: true,
      opacity: isLight ? 0.45 : 0.38,
      depthWrite: false,
    })
    const pylonEdgeMat = new THREE.LineBasicMaterial({
      color: tone,
      transparent: true,
      opacity: isLight ? 0.74 : 0.78,
      depthWrite: false,
    })

    const packetCoreMat = new THREE.MeshBasicMaterial({
      color: isLight ? tone : new THREE.Color().copy(tone).lerp(new THREE.Color('#ffffff'), 0.45),
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    })
    const packetHaloMat = new THREE.MeshBasicMaterial({
      color: tone,
      transparent: true,
      opacity: isLight ? 0.28 : 0.38,
      depthWrite: false,
      blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    })

    return {
      coreDone,
      coreActive,
      corePending,
      railDone,
      railActive,
      railPending,
      tieDone,
      tiePending,
      pylonActiveMat,
      pylonIdleMat,
      pylonEdgeMat,
      packetCoreMat,
      packetHaloMat,
    }
  }, [materials, rail.archived])

  useEffect(
    () => () => {
      bus.segments.forEach((s) => {
        s.coreGeo.dispose()
        s.leftRailGeo.dispose()
        s.rightRailGeo.dispose()
        s.crossTieGeo.dispose()
      })
      bus.pylonBaseGeo.dispose()
      bus.pylonCoreGeo.dispose()
      bus.pylonEdgesGeo.dispose()
      bus.packetCoreGeo.dispose()
      bus.packetHaloGeo.dispose()
    },
    [bus],
  )

  useEffect(
    () => () => {
      mats.coreDone.dispose()
      mats.coreActive.dispose()
      mats.corePending.dispose()
      mats.railDone.dispose()
      mats.railActive.dispose()
      mats.railPending.dispose()
      mats.tieDone.dispose()
      mats.tiePending.dispose()
      mats.pylonActiveMat.dispose()
      mats.pylonIdleMat.dispose()
      mats.pylonEdgeMat.dispose()
      mats.packetCoreMat.dispose()
      mats.packetHaloMat.dispose()
    },
    [mats],
  )

  const packetRefs = useRef<(THREE.Group | null)[]>([])
  const scratchPos = useRef(new THREE.Vector3())
  const scratchAhead = useRef(new THREE.Vector3())

  const showPackets = rail.archived || (rail.activeIndex >= 0 && rail.activeIndex < PHASES)
  const progressLimit = rail.archived
    ? 1.0
    : rail.activeIndex >= 0
      ? Math.min(1.0, (rail.activeIndex + 1) / PHASES)
      : 0

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const wave = Math.sin(t * 3.0)
    mats.coreActive.emissiveIntensity = (materials.isLight ? 0.76 : 1.48) + wave * (materials.isLight ? 0.2 : 0.52)
    mats.railActive.emissiveIntensity = (materials.isLight ? 0.58 : 1.05) + wave * 0.28

    if (!showPackets || progressLimit <= 0.01) return

    const speed = rail.archived ? 0.085 : 0.165
    const pos = scratchPos.current
    const ahead = scratchAhead.current

    for (let i = 0; i < PACKET_COUNT; i++) {
      const grp = packetRefs.current[i]
      if (!grp) continue
      const phaseOffset = i / PACKET_COUNT
      const localU = (t * speed + phaseOffset) % 1
      const u = localU * progressLimit
      const uNext = Math.min(1, u + 0.008)

      bus.spine.getPoint(u, pos)
      bus.spine.getPoint(uNext, ahead)
      grp.position.set(pos.x, pos.y + 0.16, pos.z)
      grp.lookAt(ahead.x, ahead.y + 0.16, ahead.z)

      // Smooth fade-in at origin & surge-pulse near the active frontier
      const scaleZ = 0.72 + Math.sin(localU * Math.PI) * 0.52
      grp.scale.set(1, 1, scaleZ)
    }
  })

  return (
    <group>
      {/* 9-segment dual-rail optical fiber bus */}
      {bus.segments.map((seg, i) => {
        const isActive = !rail.archived && i === rail.activeIndex
        const done = rail.archived || i < rail.activeIndex
        const coreMat = isActive ? mats.coreActive : done ? mats.coreDone : mats.corePending
        const railMat = isActive ? mats.railActive : done ? mats.railDone : mats.railPending
        const tieMat = isActive || done ? mats.tieDone : mats.tiePending
        return (
          <group key={i}>
            <mesh geometry={seg.coreGeo} material={coreMat} />
            <mesh geometry={seg.leftRailGeo} material={railMat} />
            <mesh geometry={seg.rightRailGeo} material={railMat} />
            <lineSegments geometry={seg.crossTieGeo} material={tieMat} />
          </group>
        )
      })}

      {/* Station optical junction pylons (one per unique station) */}
      {PYLONS.map((wp) => {
        const lit = rail.archived || (rail.activeIndex >= 0 && rail.activeIndex >= wp.firstPhaseIdx)
        return (
          <group key={wp.zone} position={[wp.pos.x, wp.pos.y + 0.16, wp.pos.z]}>
            <mesh geometry={bus.pylonBaseGeo} material={lit ? mats.pylonActiveMat : mats.pylonIdleMat} />
            <lineSegments geometry={bus.pylonEdgesGeo} material={mats.pylonEdgeMat} />
            <mesh position-y={0.48} geometry={bus.pylonCoreGeo} material={lit ? mats.pylonActiveMat : mats.pylonIdleMat} />
          </group>
        )
      })}

      {/* Multiple animated glowing data-packets streaming along completed segments toward the active phase */}
      {showPackets &&
        Array.from({ length: PACKET_COUNT }, (_, i) => (
          <group
            key={i}
            ref={(el) => {
              packetRefs.current[i] = el
            }}
          >
            <mesh geometry={bus.packetCoreGeo} material={mats.packetCoreMat} />
            <mesh geometry={bus.packetHaloGeo} material={mats.packetHaloMat} />
          </group>
        ))}
    </group>
  )
}
