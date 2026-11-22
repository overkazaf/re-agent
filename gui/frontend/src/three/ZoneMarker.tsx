// ZoneMarker — Cyber-forensic station pad & iconic multi-part hardware glyph:
// recessed hex/circle platform, notched telemetry ring, counter-rotating gimbal
// arcs, active vertical holographic scan-ring, Fresnel + EdgesGeometry sculptures
// (incl. procedural disassembly glass plates on SCR), and ultra-clean monospace pill.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { ZoneKey, ZoneSpec } from './contract'
import { sceneActions } from '../store/scene'
import {
  makeDisasmCanvasTexture,
  makeEdgeLineMaterial,
  makeHoloFresnelMaterial,
  type TheaterMaterials,
} from './ThemeMaterials'

export interface ZoneMarkerProps {
  zone: ZoneSpec
  materials: TheaterMaterials
  /** Current workflow phase zone: illuminated ring + holographic scan-ring */
  active?: boolean
  /** Empty state: TRI breathing entry beacon */
  breathing?: boolean
}

const STATION_INDEX: Record<ZoneKey, string> = {
  TRI: '01',
  SCR: '02',
  HYP: '03',
  EXP: '04',
  VER: '05',
  AUD: '06',
  DEL: '07',
}

/** Builds a broken segmented gimbal arc on the XZ plane for LineSegments. */
function buildGimbalArcGeo(radius: number, arcs: number, spanRad: number, y: number): THREE.BufferGeometry {
  const pts: number[] = []
  const sector = (Math.PI * 2) / arcs
  const steps = 16
  for (let i = 0; i < arcs; i++) {
    const start = i * sector
    for (let s = 0; s < steps; s++) {
      const a0 = start + (s / steps) * spanRad
      const a1 = start + ((s + 1) / steps) * spanRad
      pts.push(
        Math.cos(a0) * radius,
        y,
        Math.sin(a0) * radius,
        Math.cos(a1) * radius,
        y,
        Math.sin(a1) * radius,
      )
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return geo
}

/** Builds notched landing pad telemetry ring + recessed hex inlay lines. */
function buildPadTelemetryGeo(r: number): THREE.BufferGeometry {
  const pts: number[] = []
  const y = 0.16

  // 24 radial perimeter notches (every 15°; bolder every 45°)
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    const isMajor = i % 3 === 0
    const inner = r * (isMajor ? 0.84 : 0.89)
    const outer = r * (isMajor ? 1.03 : 1.0)
    pts.push(c * inner, y, s * inner, c * outer, y, s * outer)
  }

  // Recessed hexagon inlay on platform floor
  const hexR = r * 0.72
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2 + Math.PI / 6
    const a1 = ((i + 1) / 6) * Math.PI * 2 + Math.PI / 6
    pts.push(
      Math.cos(a0) * hexR,
      y - 0.02,
      Math.sin(a0) * hexR,
      Math.cos(a1) * hexR,
      y - 0.02,
      Math.sin(a1) * hexR,
    )
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return geo
}

interface PadBundle {
  padDiscGeo: THREE.CircleGeometry
  outerRingGeo: THREE.RingGeometry
  innerRingGeo: THREE.RingGeometry
  clickGeo: THREE.CircleGeometry
  telemetryGeo: THREE.BufferGeometry
  gimbalOuterGeo: THREE.BufferGeometry
  gimbalInnerGeo: THREE.BufferGeometry
  scanRingGeo: THREE.TorusGeometry
  scanVeilGeo: THREE.CylinderGeometry
}

function buildPadGeometries(r: number): PadBundle {
  return {
    padDiscGeo: new THREE.CircleGeometry(r * 0.92, 6),
    outerRingGeo: new THREE.RingGeometry(r * 0.94, r * 0.99, 64, 1),
    innerRingGeo: new THREE.RingGeometry(r * 0.62, r * 0.65, 48, 1),
    clickGeo: new THREE.CircleGeometry(r, 36),
    telemetryGeo: buildPadTelemetryGeo(r),
    gimbalOuterGeo: buildGimbalArcGeo(r * 1.07, 3, (56 * Math.PI) / 180, 0.17),
    gimbalInnerGeo: buildGimbalArcGeo(r * 0.78, 4, (36 * Math.PI) / 180, 0.17),
    scanRingGeo: new THREE.TorusGeometry(r * 0.86, 0.09, 8, 48),
    scanVeilGeo: new THREE.CylinderGeometry(r * 0.84, r * 0.86, r * 0.22, 32, 1, true),
  }
}

export function ZoneMarker({ zone, materials, active = false, breathing = false }: ZoneMarkerProps) {
  const [hovered, setHovered] = useState(false)
  const hoveredRef = useRef(false)
  const gimbalOuterRef = useRef<THREE.LineSegments>(null)
  const gimbalInnerRef = useRef<THREE.LineSegments>(null)
  const scanGroupRef = useRef<THREE.Group>(null)
  const r = zone.radius

  const padGeo = useMemo(() => buildPadGeometries(r), [r])

  const padMats = useMemo(() => {
    const isLight = materials.isLight
    const holoCoreMat = makeHoloFresnelMaterial(materials.accent, active ? 0.56 : 0.34, 2.2, {
      isLight,
      scanDensity: 1.5,
    })
    const holoSubMat = makeHoloFresnelMaterial(
      zone.key === 'AUD' ? materials.violet : materials.faint,
      active ? 0.46 : 0.28,
      2.6,
      { isLight, scanDensity: 1.9 },
    )
    const edgeMat = makeEdgeLineMaterial(
      materials.accent,
      active ? (isLight ? 0.94 : 0.92) : isLight ? 0.7 : 0.62,
    )
    const edgeSubMat = makeEdgeLineMaterial(
      zone.key === 'AUD' ? materials.violet : materials.faint,
      active ? 0.8 : 0.46,
    )
    const ringMat = new THREE.MeshBasicMaterial({
      color: active ? materials.accent : materials.faint,
      transparent: true,
      opacity: active ? (isLight ? 0.76 : 0.82) : isLight ? 0.46 : 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const padMat = new THREE.MeshBasicMaterial({
      color: materials.accent,
      transparent: true,
      opacity: active ? (isLight ? 0.1 : 0.12) : isLight ? 0.05 : 0.045,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const notchMat = new THREE.LineBasicMaterial({
      color: active ? materials.accent : materials.rule,
      transparent: true,
      opacity: active ? 0.8 : isLight ? 0.58 : 0.48,
      depthWrite: false,
    })
    const gimbalMat = new THREE.LineBasicMaterial({
      color: materials.accent,
      transparent: true,
      opacity: active ? 0.86 : 0.46,
      depthWrite: false,
    })
    const scanRingMat = new THREE.MeshBasicMaterial({
      color: materials.accent,
      transparent: true,
      opacity: isLight ? 0.72 : 0.88,
      depthWrite: false,
      blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    })
    const scanVeilMat = new THREE.MeshBasicMaterial({
      color: materials.accent,
      transparent: true,
      opacity: isLight ? 0.09 : 0.13,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    })
    const clickMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    return {
      holoCoreMat,
      holoSubMat,
      edgeMat,
      edgeSubMat,
      ringMat,
      padMat,
      notchMat,
      gimbalMat,
      scanRingMat,
      scanVeilMat,
      clickMat,
    }
  }, [materials, active, zone.key])

  useEffect(
    () => () => {
      padGeo.padDiscGeo.dispose()
      padGeo.outerRingGeo.dispose()
      padGeo.innerRingGeo.dispose()
      padGeo.clickGeo.dispose()
      padGeo.telemetryGeo.dispose()
      padGeo.gimbalOuterGeo.dispose()
      padGeo.gimbalInnerGeo.dispose()
      padGeo.scanRingGeo.dispose()
      padGeo.scanVeilGeo.dispose()
    },
    [padGeo],
  )

  useEffect(
    () => () => {
      padMats.holoCoreMat.dispose()
      padMats.holoSubMat.dispose()
      padMats.edgeMat.dispose()
      padMats.edgeSubMat.dispose()
      padMats.ringMat.dispose()
      padMats.padMat.dispose()
      padMats.notchMat.dispose()
      padMats.gimbalMat.dispose()
      padMats.scanRingMat.dispose()
      padMats.scanVeilMat.dispose()
      padMats.clickMat.dispose()
    },
    [padMats],
  )

  // Reset hover cursor cleanly if component unmounts while pointer is over it
  useEffect(
    () => () => {
      if (hoveredRef.current) {
        document.body.style.cursor = ''
      }
    },
    [],
  )

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime
    const isHov = hoveredRef.current
    const isLight = materials.isLight

    padMats.holoCoreMat.uniforms.uTime.value = t
    padMats.holoSubMat.uniforms.uTime.value = t

    if (breathing) {
      const wave = Math.sin(t * 1.5)
      padMats.holoCoreMat.uniforms.uIntensity.value = 1.05 + wave * 0.28
      padMats.edgeMat.opacity = 0.72 + wave * 0.2
      padMats.ringMat.opacity = 0.52 + wave * 0.22
    } else if (active) {
      const wave = Math.sin(t * 2.6)
      padMats.holoCoreMat.uniforms.uIntensity.value = 1.18 + wave * 0.22
      padMats.edgeMat.opacity = 0.86 + wave * 0.1
      padMats.ringMat.opacity = 0.74 + wave * 0.16
      padMats.padMat.opacity = isLight ? 0.1 : 0.12
      padMats.gimbalMat.opacity = 0.84 + wave * 0.1
    } else if (isHov) {
      padMats.holoCoreMat.uniforms.uIntensity.value = 1.32
      padMats.edgeMat.opacity = 0.94
      padMats.ringMat.opacity = 0.78
      padMats.padMat.opacity = isLight ? 0.11 : 0.12
      padMats.gimbalMat.opacity = 0.82
    } else {
      padMats.holoCoreMat.uniforms.uIntensity.value = 0.92
      padMats.edgeMat.opacity = isLight ? 0.7 : 0.62
      padMats.ringMat.opacity = isLight ? 0.46 : 0.4
      padMats.padMat.opacity = isLight ? 0.05 : 0.045
      padMats.gimbalMat.opacity = 0.46
    }

    const gimbalSpeed = active ? 0.42 : isHov ? 0.34 : 0.14
    if (gimbalOuterRef.current) gimbalOuterRef.current.rotation.y += delta * gimbalSpeed
    if (gimbalInnerRef.current) gimbalInnerRef.current.rotation.y -= delta * gimbalSpeed * 1.35

    // Animated vertical holographic scan-ring sweeping smoothly up and down
    if (scanGroupRef.current && (active || breathing)) {
      const sweepPhase = 0.5 - 0.5 * Math.cos(t * 1.45)
      const minY = 0.35
      const maxY = r * 1.08
      scanGroupRef.current.position.y = minY + sweepPhase * (maxY - minY)
      const edgeFade = Math.sin(sweepPhase * Math.PI)
      padMats.scanRingMat.opacity = (isLight ? 0.25 : 0.35) + edgeFade * (isLight ? 0.5 : 0.58)
      padMats.scanVeilMat.opacity = edgeFade * (isLight ? 0.1 : 0.15)
    }
  })

  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    hoveredRef.current = true
    setHovered(true)
    document.body.style.cursor = 'pointer'
  }
  const onOut = () => {
    hoveredRef.current = false
    setHovered(false)
    document.body.style.cursor = ''
  }
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    sceneActions.setFocus({ kind: 'zone', zone: zone.key })
  }

  return (
    <group position={zone.center}>
      {/* Recessed hexagonal platform disc */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.08} geometry={padGeo.padDiscGeo} material={padMats.padMat} />
      {/* Crisp outer & inner precision rings */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.14} geometry={padGeo.outerRingGeo} material={padMats.ringMat} />
      <mesh rotation-x={-Math.PI / 2} position-y={0.13} geometry={padGeo.innerRingGeo} material={padMats.ringMat} />
      {/* Notched telemetry ring + recessed hex inlay */}
      <lineSegments geometry={padGeo.telemetryGeo} material={padMats.notchMat} />
      {/* Counter-rotating segmented gimbal arcs */}
      <lineSegments ref={gimbalOuterRef} geometry={padGeo.gimbalOuterGeo} material={padMats.gimbalMat} />
      <lineSegments ref={gimbalInnerRef} geometry={padGeo.gimbalInnerGeo} material={padMats.gimbalMat} />

      {/* Animated vertical holographic scan-ring on active or breathing station */}
      {(active || breathing) && (
        <group ref={scanGroupRef} position-y={0.5}>
          <mesh rotation-x={Math.PI / 2} geometry={padGeo.scanRingGeo} material={padMats.scanRingMat} />
          <mesh geometry={padGeo.scanVeilGeo} material={padMats.scanVeilMat} />
        </group>
      )}

      {/* Invisible full-circle click & hover target */}
      <mesh
        rotation-x={-Math.PI / 2}
        position-y={0.12}
        geometry={padGeo.clickGeo}
        material={padMats.clickMat}
        onPointerOver={onOver}
        onPointerOut={onOut}
        onClick={onClick}
      />

      {/* Distinct multi-part geek station hardware sculpture */}
      <StationSculpture
        zoneKey={zone.key}
        r={r}
        materials={materials}
        holoCoreMat={padMats.holoCoreMat}
        holoSubMat={padMats.holoSubMat}
        edgeMat={padMats.edgeMat}
        edgeSubMat={padMats.edgeSubMat}
        active={active || breathing}
      />

      {/* Ultra-clean geeky station HTML pill */}
      <Html position={labelPos(zone.key, r)} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className={`theater-chip${active || hovered ? ' theater-chip--active' : ''}`}
          style={{ opacity: active || hovered ? 1 : 0.88 }}
        >
          <span className="theater-zone-code">
            {STATION_INDEX[zone.key]}·{zone.key}
          </span>
          <span className="theater-zone-name">{zone.label}</span>
        </div>
      </Html>
    </group>
  )
}

interface SculptureProps {
  zoneKey: ZoneKey
  r: number
  materials: TheaterMaterials
  holoCoreMat: THREE.ShaderMaterial
  holoSubMat: THREE.ShaderMaterial
  edgeMat: THREE.LineBasicMaterial
  edgeSubMat: THREE.LineBasicMaterial
  active: boolean
}

function StationSculpture(props: SculptureProps) {
  switch (props.zoneKey) {
    case 'TRI':
      return <TriScannerSculpture {...props} />
    case 'SCR':
      return <ScrDisasmSculpture {...props} />
    case 'HYP':
      return <HypSpireSculpture {...props} />
    case 'EXP':
      return <ExpContainmentSculpture {...props} />
    case 'VER':
      return <VerGyroSculpture {...props} />
    case 'AUD':
      return <AudFirewallSculpture {...props} />
    case 'DEL':
      return <DelArchivalSculpture {...props} />
  }
}

/** TRI (01): Nested counter-rotating octahedral scanner prism + 3-axis crosshair ticks. */
function TriScannerSculpture({ r, holoCoreMat, holoSubMat, edgeMat, edgeSubMat, active }: SculptureProps) {
  const outerRef = useRef<THREE.Group>(null)
  const innerRef = useRef<THREE.Group>(null)

  const geos = useMemo(() => {
    const outerOct = new THREE.OctahedronGeometry(r * 0.34, 0)
    const outerEdges = new THREE.EdgesGeometry(outerOct)
    const innerOct = new THREE.OctahedronGeometry(r * 0.19, 0)
    const innerEdges = new THREE.EdgesGeometry(innerOct)

    // 3-axis precision crosshair arms + end ticks
    const arm = r * 0.56
    const gap = r * 0.38
    const tick = r * 0.06
    const pts = [
      // +X / -X
      gap, 0, 0, arm, 0, 0, -gap, 0, 0, -arm, 0, 0,
      arm, -tick, 0, arm, tick, 0, -arm, -tick, 0, -arm, tick, 0,
      // +Z / -Z
      0, 0, gap, 0, 0, arm, 0, 0, -gap, 0, 0, -arm,
      0, -tick, arm, 0, tick, arm, 0, -tick, -arm, 0, tick, -arm,
      // +Y / -Y
      0, gap * 0.85, 0, 0, arm * 0.9, 0, 0, -gap * 0.72, 0, 0, -arm * 0.78, 0,
    ]
    const crossGeo = new THREE.BufferGeometry()
    crossGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return { outerOct, outerEdges, innerOct, innerEdges, crossGeo }
  }, [r])

  useEffect(
    () => () => {
      geos.outerOct.dispose()
      geos.outerEdges.dispose()
      geos.innerOct.dispose()
      geos.innerEdges.dispose()
      geos.crossGeo.dispose()
    },
    [geos],
  )

  useFrame((_, delta) => {
    const spd = active ? 0.55 : 0.24
    if (outerRef.current) outerRef.current.rotation.y += delta * spd
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * spd * 1.45
      innerRef.current.rotation.x += delta * spd * 0.5
    }
  })

  return (
    <group position-y={r * 0.48}>
      <group ref={outerRef}>
        <mesh geometry={geos.outerOct} material={holoCoreMat} />
        <lineSegments geometry={geos.outerEdges} material={edgeMat} />
      </group>
      <group ref={innerRef} rotation-z={Math.PI * 0.25}>
        <mesh geometry={geos.innerOct} material={holoSubMat} />
        <lineSegments geometry={geos.innerEdges} material={edgeSubMat} />
      </group>
      <lineSegments geometry={geos.crossGeo} material={edgeMat} />
    </group>
  )
}

/** SCR (02): Stacked floating holographic disassembly glass plates textured with makeDisasmCanvasTexture. */
function ScrDisasmSculpture({ r, materials, edgeMat, edgeSubMat, active }: SculptureProps) {
  const stackRef = useRef<THREE.Group>(null)

  const resources = useMemo(() => {
    const tex = makeDisasmCanvasTexture(materials)
    const plateW = r * 0.96
    const plateH = plateW * (320 / 512)
    const plateGeo = new THREE.PlaneGeometry(plateW, plateH)
    const frameBox = new THREE.BoxGeometry(plateW, plateH, 0.14)
    const frameGeo = new THREE.EdgesGeometry(frameBox)
    frameBox.dispose()
    const frontMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: materials.isLight ? 0.94 : 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const backMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: materials.isLight ? 0.45 : 0.38,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    return { tex, plateGeo, frameGeo, frontMat, backMat }
  }, [r, materials])

  useEffect(
    () => () => {
      resources.plateGeo.dispose()
      resources.frameGeo.dispose()
      resources.frontMat.dispose()
      resources.backMat.dispose()
      resources.tex.dispose()
    },
    [resources],
  )

  useFrame(({ clock }) => {
    if (!stackRef.current) return
    const t = clock.elapsedTime
    stackRef.current.rotation.y = -0.32 + Math.sin(t * (active ? 0.95 : 0.45)) * 0.18
    stackRef.current.position.y = r * 0.56 + Math.sin(t * 1.4) * 0.24
  })

  return (
    <group ref={stackRef} position-y={r * 0.56}>
      {/* Rear parallax plate */}
      <group position={[-0.75, 0.35, -1.65]} rotation-y={0.08}>
        <mesh geometry={resources.plateGeo} material={resources.backMat} />
        <lineSegments geometry={resources.frameGeo} material={edgeSubMat} />
      </group>
      {/* Mid parallax plate */}
      <group position={[0.55, -0.18, -0.78]} rotation-y={-0.05}>
        <mesh geometry={resources.plateGeo} material={resources.backMat} />
        <lineSegments geometry={resources.frameGeo} material={edgeSubMat} />
      </group>
      {/* Primary crisp disassembly plate */}
      <group position={[0, 0, 0.2]}>
        <mesh geometry={resources.plateGeo} material={resources.frontMat} />
        <lineSegments geometry={resources.frameGeo} material={edgeMat} />
      </group>
    </group>
  )
}

/** HYP (03): Precision hexagonal crystalline spire + orbital confidence halo ring. */
function HypSpireSculpture({ r, holoCoreMat, holoSubMat, edgeMat, edgeSubMat, active }: SculptureProps) {
  const spireRef = useRef<THREE.Group>(null)
  const haloRef = useRef<THREE.Group>(null)

  const geos = useMemo(() => {
    const lowerSpire = new THREE.CylinderGeometry(r * 0.14, r * 0.28, r * 0.54, 6, 1)
    const lowerEdges = new THREE.EdgesGeometry(lowerSpire)
    const upperCrystal = new THREE.ConeGeometry(r * 0.14, r * 0.34, 6, 1)
    const upperEdges = new THREE.EdgesGeometry(upperCrystal)
    const haloRing = new THREE.TorusGeometry(r * 0.46, 0.075, 8, 42)
    const haloTicks = buildGimbalArcGeo(r * 0.54, 6, (28 * Math.PI) / 180, 0)
    return { lowerSpire, lowerEdges, upperCrystal, upperEdges, haloRing, haloTicks }
  }, [r])

  useEffect(
    () => () => {
      geos.lowerSpire.dispose()
      geos.lowerEdges.dispose()
      geos.upperCrystal.dispose()
      geos.upperEdges.dispose()
      geos.haloRing.dispose()
      geos.haloTicks.dispose()
    },
    [geos],
  )

  useFrame((_, delta) => {
    const spd = active ? 0.48 : 0.2
    if (spireRef.current) spireRef.current.rotation.y += delta * spd * 0.65
    if (haloRef.current) haloRef.current.rotation.y -= delta * spd * 1.4
  })

  // Keep HYP spire cleanly below y=9.2 so floating H-NNN hypothesis prisms (y=10..22) never collide
  return (
    <group>
      <group ref={spireRef}>
        <mesh position-y={r * 0.32} geometry={geos.lowerSpire} material={holoCoreMat} />
        <lineSegments position-y={r * 0.32} geometry={geos.lowerEdges} material={edgeMat} />
        <mesh position-y={r * 0.76} geometry={geos.upperCrystal} material={holoCoreMat} />
        <lineSegments position-y={r * 0.76} geometry={geos.upperEdges} material={edgeMat} />
      </group>
      {/* Tilted orbital confidence halo ring */}
      <group position-y={r * 0.52} rotation={[0.26, 0, -0.18]}>
        <group ref={haloRef}>
          <mesh rotation-x={Math.PI / 2} geometry={geos.haloRing} material={holoSubMat} />
          <lineSegments geometry={geos.haloTicks} material={edgeSubMat} />
        </group>
      </group>
    </group>
  )
}

/** EXP (04): Hexagonal sandbox containment chamber with glowing segmented barrier arcs. */
function ExpContainmentSculpture({ r, holoCoreMat, holoSubMat, edgeMat, edgeSubMat, active }: SculptureProps) {
  const barrierRef = useRef<THREE.Group>(null)
  const coreRef = useRef<THREE.Group>(null)

  const geos = useMemo(() => {
    const chamber = new THREE.CylinderGeometry(r * 0.36, r * 0.42, r * 0.38, 6, 1)
    const chamberEdges = new THREE.EdgesGeometry(chamber)
    const innerCore = new THREE.IcosahedronGeometry(r * 0.14, 0)
    const innerCoreEdges = new THREE.EdgesGeometry(innerCore)
    // 3 curved segmented barrier arcs around the containment cylinder
    const barrierArc = new THREE.CylinderGeometry(
      r * 0.58,
      r * 0.58,
      r * 0.34,
      10,
      1,
      true,
      0,
      (72 * Math.PI) / 180,
    )
    const barrierEdges = new THREE.EdgesGeometry(barrierArc)
    return { chamber, chamberEdges, innerCore, innerCoreEdges, barrierArc, barrierEdges }
  }, [r])

  useEffect(
    () => () => {
      geos.chamber.dispose()
      geos.chamberEdges.dispose()
      geos.innerCore.dispose()
      geos.innerCoreEdges.dispose()
      geos.barrierArc.dispose()
      geos.barrierEdges.dispose()
    },
    [geos],
  )

  useFrame((_, delta) => {
    const spd = active ? 0.5 : 0.22
    if (barrierRef.current) barrierRef.current.rotation.y += delta * spd
    if (coreRef.current) {
      coreRef.current.rotation.y -= delta * spd * 1.6
      coreRef.current.rotation.x += delta * spd * 0.7
    }
  })

  return (
    <group>
      {/* Central hexagonal sandbox containment chamber */}
      <mesh position-y={r * 0.24} geometry={geos.chamber} material={holoSubMat} />
      <lineSegments position-y={r * 0.24} geometry={geos.chamberEdges} material={edgeMat} />
      {/* Suspended test-specimen core */}
      <group ref={coreRef} position-y={r * 0.34}>
        <mesh geometry={geos.innerCore} material={holoCoreMat} />
        <lineSegments geometry={geos.innerCoreEdges} material={edgeMat} />
      </group>
      {/* 3 orbiting glowing containment barrier arcs */}
      <group ref={barrierRef} position-y={r * 0.28}>
        {[0, 1, 2].map((idx) => (
          <group key={idx} rotation-y={(idx * Math.PI * 2) / 3}>
            <mesh geometry={geos.barrierArc} material={holoCoreMat} />
            <lineSegments geometry={geos.barrierEdges} material={edgeSubMat} />
          </group>
        ))}
      </group>
    </group>
  )
}

/** VER (05): Twin interlocking orthogonal gyroscope rings around a verification core. */
function VerGyroSculpture({ r, holoCoreMat, holoSubMat, edgeMat, edgeSubMat, active }: SculptureProps) {
  const outerGyroRef = useRef<THREE.Mesh>(null)
  const innerGyroRef = useRef<THREE.Mesh>(null)
  const coreRef = useRef<THREE.Group>(null)

  const geos = useMemo(() => {
    const outerRing = new THREE.TorusGeometry(r * 0.44, 0.14, 10, 40)
    const innerRing = new THREE.TorusGeometry(r * 0.32, 0.12, 10, 36)
    const core = new THREE.OctahedronGeometry(r * 0.16, 0)
    const coreEdges = new THREE.EdgesGeometry(core)
    const ringTicks = buildGimbalArcGeo(r * 0.5, 4, (42 * Math.PI) / 180, 0)
    return { outerRing, innerRing, core, coreEdges, ringTicks }
  }, [r])

  useEffect(
    () => () => {
      geos.outerRing.dispose()
      geos.innerRing.dispose()
      geos.core.dispose()
      geos.coreEdges.dispose()
      geos.ringTicks.dispose()
    },
    [geos],
  )

  useFrame((_, delta) => {
    const spd = active ? 0.85 : 0.36
    if (outerGyroRef.current) {
      outerGyroRef.current.rotation.y += delta * spd
      outerGyroRef.current.rotation.x += delta * spd * 0.35
    }
    if (innerGyroRef.current) {
      innerGyroRef.current.rotation.z -= delta * spd * 1.15
      innerGyroRef.current.rotation.y -= delta * spd * 0.55
    }
    if (coreRef.current) {
      coreRef.current.rotation.y += delta * spd * 0.7
    }
  })

  return (
    <group position-y={r * 0.54}>
      <mesh ref={outerGyroRef} geometry={geos.outerRing} material={holoCoreMat} />
      <mesh ref={innerGyroRef} rotation-y={Math.PI / 2} geometry={geos.innerRing} material={holoSubMat} />
      <lineSegments geometry={geos.ringTicks} material={edgeSubMat} />
      <group ref={coreRef}>
        <mesh geometry={geos.core} material={holoCoreMat} />
        <lineSegments geometry={geos.coreEdges} material={edgeMat} />
      </group>
    </group>
  )
}

/** AUD (06): Isolated monolithic prism surrounded by a hexagonal perimeter firewall shield. */
function AudFirewallSculpture({ r, holoCoreMat, holoSubMat, edgeMat, edgeSubMat, active }: SculptureProps) {
  const shieldRef = useRef<THREE.Group>(null)
  const monoRef = useRef<THREE.Group>(null)

  const geos = useMemo(() => {
    const monolith = new THREE.CylinderGeometry(r * 0.16, r * 0.21, r * 0.88, 6, 1)
    const monolithEdges = new THREE.EdgesGeometry(monolith)
    const cap = new THREE.ConeGeometry(r * 0.16, r * 0.18, 6, 1)
    const capEdges = new THREE.EdgesGeometry(cap)
    const shieldPanel = new THREE.BoxGeometry(r * 0.42, r * 0.52, 0.16)
    const shieldEdges = new THREE.EdgesGeometry(shieldPanel)
    return { monolith, monolithEdges, cap, capEdges, shieldPanel, shieldEdges }
  }, [r])

  useEffect(
    () => () => {
      geos.monolith.dispose()
      geos.monolithEdges.dispose()
      geos.cap.dispose()
      geos.capEdges.dispose()
      geos.shieldPanel.dispose()
      geos.shieldEdges.dispose()
    },
    [geos],
  )

  useFrame((_, delta) => {
    const spd = active ? 0.34 : 0.14
    if (shieldRef.current) shieldRef.current.rotation.y += delta * spd
    if (monoRef.current) monoRef.current.rotation.y -= delta * spd * 0.65
  })

  const shieldRadius = r * 0.54

  return (
    <group>
      {/* Isolated central audit monolith */}
      <group ref={monoRef}>
        <mesh position-y={r * 0.48} geometry={geos.monolith} material={holoCoreMat} />
        <lineSegments position-y={r * 0.48} geometry={geos.monolithEdges} material={edgeMat} />
        <mesh position-y={r * 1.01} geometry={geos.cap} material={holoCoreMat} />
        <lineSegments position-y={r * 1.01} geometry={geos.capEdges} material={edgeMat} />
      </group>
      {/* Hexagonal perimeter firewall shield (6 segmented baffles) */}
      <group ref={shieldRef} position-y={r * 0.36}>
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const angle = (i / 6) * Math.PI * 2
          return (
            <group
              key={i}
              position={[Math.cos(angle) * shieldRadius, 0, Math.sin(angle) * shieldRadius]}
              rotation-y={-angle + Math.PI / 2}
            >
              <mesh geometry={geos.shieldPanel} material={holoSubMat} />
              <lineSegments geometry={geos.shieldEdges} material={edgeSubMat} />
            </group>
          )
        })}
      </group>
    </group>
  )
}

/** DEL / WRI (07): Precision stacked archival data-core monolith. */
function DelArchivalSculpture({ r, holoCoreMat, holoSubMat, edgeMat, edgeSubMat, active }: SculptureProps) {
  const stackRef = useRef<THREE.Group>(null)
  const sealRef = useRef<THREE.Group>(null)

  const geos = useMemo(() => {
    const slab1 = new THREE.CylinderGeometry(r * 0.44, r * 0.48, r * 0.16, 6, 1)
    const slab1Edges = new THREE.EdgesGeometry(slab1)
    const slab2 = new THREE.CylinderGeometry(r * 0.35, r * 0.39, r * 0.16, 6, 1)
    const slab2Edges = new THREE.EdgesGeometry(slab2)
    const slab3 = new THREE.CylinderGeometry(r * 0.26, r * 0.3, r * 0.16, 6, 1)
    const slab3Edges = new THREE.EdgesGeometry(slab3)
    const seal = new THREE.OctahedronGeometry(r * 0.14, 0)
    const sealEdges = new THREE.EdgesGeometry(seal)
    return { slab1, slab1Edges, slab2, slab2Edges, slab3, slab3Edges, seal, sealEdges }
  }, [r])

  useEffect(
    () => () => {
      geos.slab1.dispose()
      geos.slab1Edges.dispose()
      geos.slab2.dispose()
      geos.slab2Edges.dispose()
      geos.slab3.dispose()
      geos.slab3Edges.dispose()
      geos.seal.dispose()
      geos.sealEdges.dispose()
    },
    [geos],
  )

  useFrame(({ clock }, delta) => {
    const spd = active ? 0.42 : 0.18
    if (stackRef.current) stackRef.current.rotation.y += delta * spd * 0.5
    if (sealRef.current) {
      sealRef.current.rotation.y -= delta * spd * 1.4
      sealRef.current.position.y = r * 0.84 + Math.sin(clock.elapsedTime * 2.0) * 0.22
    }
  })

  return (
    <group>
      <group ref={stackRef}>
        {/* Tier 1 base archival slab */}
        <mesh position-y={r * 0.16} geometry={geos.slab1} material={holoSubMat} />
        <lineSegments position-y={r * 0.16} geometry={geos.slab1Edges} material={edgeSubMat} />
        {/* Tier 2 mid archival slab */}
        <mesh position-y={r * 0.38} geometry={geos.slab2} material={holoCoreMat} />
        <lineSegments position-y={r * 0.38} geometry={geos.slab2Edges} material={edgeMat} />
        {/* Tier 3 upper archival slab */}
        <mesh position-y={r * 0.6} geometry={geos.slab3} material={holoCoreMat} />
        <lineSegments position-y={r * 0.6} geometry={geos.slab3Edges} material={edgeMat} />
      </group>
      {/* Floating archival verification seal crystal */}
      <group ref={sealRef} position-y={r * 0.84}>
        <mesh geometry={geos.seal} material={holoCoreMat} />
        <lineSegments geometry={geos.sealEdges} material={edgeMat} />
      </group>
    </group>
  )
}

function labelPos(key: ZoneKey, r: number): [number, number, number] {
  switch (key) {
    case 'TRI':
      return [0, r * 0.92, -r * 0.18]
    case 'SCR':
      return [0, r * 1.08, 0]
    case 'HYP':
      // Anchor HYP zone badge cleanly at the front rim of its pad so floating
      // H-NNN hypothesis prisms (y=10..22) above the spire never collide with it.
      return [0, 1.4, r * 1.16]
    case 'AUD':
      return [0, r * 1.32, 0]
    default:
      return [0, r * 1.06, 0]
  }
}
