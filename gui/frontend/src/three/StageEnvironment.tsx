// StageEnvironment — Tactical cyber-forensic stage floor & atmospheric shell:
// anti-aliased GLSL radar floor with rotating forensic sweep beam, graduated
// 360° telemetry compass ring (5°/15°/45° notches), cardinal axis reticle ticks,
// counter-rotating outer calibration arcs, and a GPU-driven ambient telemetry
// particle field calibrated for both dark decks and daylight `paper`.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { makeRadarFloorMaterial, type TheaterMaterials } from './ThemeMaterials'

export interface StageEnvironmentProps {
  materials: TheaterMaterials
  showGrid?: boolean
}

const COMPASS_RADIUS = 88
const PARTICLE_COUNT = 140

const PARTICLE_VERT = /* glsl */ `
  attribute float aPhase;
  attribute float aSize;
  attribute float aSpeed;
  attribute float aTint;

  uniform float uTime;
  uniform float uPixelRatio;

  varying float vAlpha;
  varying float vTint;

  void main() {
    vec3 pos = position;
    float yMin = 2.0;
    float ySpan = 36.0;
    float y = yMin + mod(pos.y - yMin + uTime * aSpeed, ySpan);
    pos.y = y;
    pos.x += sin(uTime * 0.24 + aPhase) * 0.65;
    pos.z += cos(uTime * 0.21 + aPhase * 1.3) * 0.65;

    // Smooth vertical fade at bottom & top bounds + gentle shimmer
    float hNorm = (y - yMin) / ySpan;
    float heightFade = smoothstep(0.0, 0.14, hNorm) * (1.0 - smoothstep(0.78, 1.0, hNorm));
    float shimmer = 0.68 + 0.32 * sin(uTime * 1.15 + aPhase * 3.0);

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    float distFade = 1.0 - smoothstep(145.0, 275.0, -mvPos.z);
    vAlpha = heightFade * shimmer * distFade;
    vTint = aTint;

    gl_PointSize = clamp(aSize * uPixelRatio * (140.0 / max(-mvPos.z, 1.0)), 1.5, 9.0);
    gl_Position = projectionMatrix * mvPos;
  }
`

const PARTICLE_FRAG = /* glsl */ `
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform float uOpacity;
  uniform float uIsLight;

  varying float vAlpha;
  varying float vTint;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    // Crisp soft diamond/hex telemetry mote
    float diamond = abs(uv.x) + abs(uv.y);
    float radial = length(uv);
    float shape = mix(radial, diamond * 0.85, 0.45);
    float core = 1.0 - smoothstep(0.12, 0.48, shape);
    if (core < 0.01) discard;

    vec3 col = mix(uPrimaryColor, uSecondaryColor, vTint);
    if (uIsLight < 0.5) {
      col = mix(col, vec3(1.0), core * 0.22);
    }
    gl_FragColor = vec4(col, core * vAlpha * uOpacity);
  }
`

/** Deterministic PRNG (Mulberry32) so particle layout is crisp and reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Builds a segmented arc BufferGeometry for LineSegments on the XZ plane. */
function buildArcLineGeometry(
  radius: number,
  y: number,
  arcCount: number,
  arcSpanRad: number,
  phaseOffset = 0,
  stepsPerArc = 24,
): THREE.BufferGeometry {
  const pts: number[] = []
  const sectorStep = (Math.PI * 2) / arcCount
  for (let i = 0; i < arcCount; i++) {
    const start = i * sectorStep + phaseOffset
    for (let s = 0; s < stepsPerArc; s++) {
      const a0 = start + (s / stepsPerArc) * arcSpanRad
      const a1 = start + ((s + 1) / stepsPerArc) * arcSpanRad
      pts.push(
        Math.cos(a0) * radius,
        y,
        Math.sin(a0) * radius,
        Math.cos(a1) * radius,
        y,
        Math.sin(a1) * radius,
      )
    }
    // End-cap radial tick ticks at both ends of each calibration arc
    const endA = start + arcSpanRad
    pts.push(
      Math.cos(start) * (radius - 0.9),
      y,
      Math.sin(start) * (radius - 0.9),
      Math.cos(start) * (radius + 0.9),
      y,
      Math.sin(start) * (radius + 0.9),
      Math.cos(endA) * (radius - 0.9),
      y,
      Math.sin(endA) * (radius - 0.9),
      Math.cos(endA) * (radius + 0.9),
      y,
      Math.sin(endA) * (radius + 0.9),
    )
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return geo
}

/** Builds outer 360° telemetry compass ring (5°/15°/45° notches) + cardinal axis ticks. */
function buildCompassAndTicks(): {
  minorGeo: THREE.BufferGeometry
  majorGeo: THREE.BufferGeometry
  axisTickGeo: THREE.BufferGeometry
} {
  const minorPts: number[] = []
  const majorPts: number[] = []
  const y = -0.17

  // Outer perimeter ring (96 segments) + inner collar hairline
  const segs = 96
  const innerR = COMPASS_RADIUS - 2.8
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2
    const a1 = ((i + 1) / segs) * Math.PI * 2
    minorPts.push(
      Math.cos(a0) * COMPASS_RADIUS,
      y,
      Math.sin(a0) * COMPASS_RADIUS,
      Math.cos(a1) * COMPASS_RADIUS,
      y,
      Math.sin(a1) * COMPASS_RADIUS,
    )
    minorPts.push(
      Math.cos(a0) * innerR,
      y,
      Math.sin(a0) * innerR,
      Math.cos(a1) * innerR,
      y,
      Math.sin(a1) * innerR,
    )
  }

  // Degree notches every 5° (minor), 15° (medium), 45° (major octants)
  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    if (deg % 45 === 0) {
      majorPts.push(
        cos * (COMPASS_RADIUS - 3.6),
        y + 0.02,
        sin * (COMPASS_RADIUS - 3.6),
        cos * (COMPASS_RADIUS + 2.2),
        y + 0.02,
        sin * (COMPASS_RADIUS + 2.2),
      )
      // Cardinal diamond brackets at 0°/90°/180°/270°
      if (deg % 90 === 0) {
        const px = -sin
        const pz = cos
        const tipR = COMPASS_RADIUS + 3.6
        const baseR = COMPASS_RADIUS + 1.8
        const wing = 1.15
        majorPts.push(
          cos * tipR,
          y + 0.03,
          sin * tipR,
          cos * baseR + px * wing,
          y + 0.03,
          sin * baseR + pz * wing,
          cos * tipR,
          y + 0.03,
          sin * tipR,
          cos * baseR - px * wing,
          y + 0.03,
          sin * baseR - pz * wing,
        )
      }
    } else if (deg % 15 === 0) {
      majorPts.push(
        cos * (COMPASS_RADIUS - 2.6),
        y + 0.01,
        sin * (COMPASS_RADIUS - 2.6),
        cos * (COMPASS_RADIUS + 0.5),
        y + 0.01,
        sin * (COMPASS_RADIUS + 0.5),
      )
    } else {
      minorPts.push(
        cos * (COMPASS_RADIUS - 1.35),
        y,
        sin * (COMPASS_RADIUS - 1.35),
        cos * COMPASS_RADIUS,
        y,
        sin * COMPASS_RADIUS,
      )
    }
  }

  // Cardinal axis ruler ticks along ±X and ±Z every 8 units (bolder every 16 units)
  const axisPts: number[] = []
  for (let d = -80; d <= 80; d += 8) {
    if (d === 0) continue
    const half = d % 16 === 0 ? 1.65 : 0.85
    // Ticks perpendicular to X axis
    axisPts.push(d, y + 0.01, -half, d, y + 0.01, half)
    // Ticks perpendicular to Z axis
    axisPts.push(-half, y + 0.01, d, half, y + 0.01, d)
  }

  const minorGeo = new THREE.BufferGeometry()
  minorGeo.setAttribute('position', new THREE.Float32BufferAttribute(minorPts, 3))

  const majorGeo = new THREE.BufferGeometry()
  majorGeo.setAttribute('position', new THREE.Float32BufferAttribute(majorPts, 3))

  const axisTickGeo = new THREE.BufferGeometry()
  axisTickGeo.setAttribute('position', new THREE.Float32BufferAttribute(axisPts, 3))

  return { minorGeo, majorGeo, axisTickGeo }
}

/** Builds ambient telemetry dust/hex particle BufferGeometry. */
function buildParticleGeometry(): THREE.BufferGeometry {
  const rand = mulberry32(0xaf3d9017)
  const positions = new Float32Array(PARTICLE_COUNT * 3)
  const phases = new Float32Array(PARTICLE_COUNT)
  const sizes = new Float32Array(PARTICLE_COUNT)
  const speeds = new Float32Array(PARTICLE_COUNT)
  const tints = new Float32Array(PARTICLE_COUNT)

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Wide cylindrical annulus so central EXP/HYP DAG space remains unobstructed
    const angle = rand() * Math.PI * 2
    const radius = 18 + Math.sqrt(rand()) * 86
    const y = 2 + rand() * 36

    positions[i * 3] = Math.cos(angle) * radius
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = Math.sin(angle) * radius

    phases[i] = rand() * Math.PI * 2
    sizes[i] = 2.6 + rand() * 3.4
    speeds[i] = 0.25 + rand() * 0.55
    tints[i] = rand() > 0.72 ? 1.0 : 0.0
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1))
  geo.setAttribute('aTint', new THREE.BufferAttribute(tints, 1))
  return geo
}

export function StageEnvironment({ materials, showGrid = true }: StageEnvironmentProps) {
  const outerArcARef = useRef<THREE.LineSegments>(null)
  const outerArcBRef = useRef<THREE.LineSegments>(null)

  const geometries = useMemo(() => {
    const floorGeo = new THREE.PlaneGeometry(240, 240, 1, 1)
    const { minorGeo, majorGeo, axisTickGeo } = buildCompassAndTicks()
    const arcAGeo = buildArcLineGeometry(92.5, -0.15, 3, (54 * Math.PI) / 180, 0.25, 28)
    const arcBGeo = buildArcLineGeometry(95.8, -0.14, 4, (30 * Math.PI) / 180, 0.72, 20)
    const particleGeo = buildParticleGeometry()
    return { floorGeo, minorGeo, majorGeo, axisTickGeo, arcAGeo, arcBGeo, particleGeo }
  }, [])

  const mats = useMemo(() => {
    const radarMat = makeRadarFloorMaterial(materials)
    const minorMat = new THREE.LineBasicMaterial({
      color: materials.rule,
      transparent: true,
      opacity: materials.isLight ? 0.52 : 0.36,
      depthWrite: false,
    })
    const majorMat = new THREE.LineBasicMaterial({
      color: materials.isLight ? materials.accent : materials.faint,
      transparent: true,
      opacity: materials.isLight ? 0.58 : 0.62,
      depthWrite: false,
    })
    const axisTickMat = new THREE.LineBasicMaterial({
      color: materials.accent,
      transparent: true,
      opacity: materials.isLight ? 0.42 : 0.38,
      depthWrite: false,
    })
    const arcAMat = new THREE.LineBasicMaterial({
      color: materials.accent,
      transparent: true,
      opacity: materials.isLight ? 0.46 : 0.42,
      depthWrite: false,
    })
    const arcBMat = new THREE.LineBasicMaterial({
      color: materials.violet,
      transparent: true,
      opacity: materials.isLight ? 0.38 : 0.34,
      depthWrite: false,
    })
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1
    const particleMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: dpr },
        uPrimaryColor: { value: (materials.isLight ? materials.faint : materials.accent).clone() },
        uSecondaryColor: { value: materials.violet.clone() },
        uOpacity: { value: materials.isLight ? 0.36 : 0.48 },
        uIsLight: { value: materials.isLight ? 1.0 : 0.0 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: materials.isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    })
    return { radarMat, minorMat, majorMat, axisTickMat, arcAMat, arcBMat, particleMat }
  }, [materials])

  useEffect(
    () => () => {
      geometries.floorGeo.dispose()
      geometries.minorGeo.dispose()
      geometries.majorGeo.dispose()
      geometries.axisTickGeo.dispose()
      geometries.arcAGeo.dispose()
      geometries.arcBGeo.dispose()
      geometries.particleGeo.dispose()
    },
    [geometries],
  )

  useEffect(
    () => () => {
      mats.radarMat.dispose()
      mats.minorMat.dispose()
      mats.majorMat.dispose()
      mats.axisTickMat.dispose()
      mats.arcAMat.dispose()
      mats.arcBMat.dispose()
      mats.particleMat.dispose()
    },
    [mats],
  )

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime
    mats.radarMat.uniforms.uTime.value = t
    mats.particleMat.uniforms.uTime.value = t
    if (showGrid) {
      if (outerArcARef.current) outerArcARef.current.rotation.y += delta * 0.036
      if (outerArcBRef.current) outerArcBRef.current.rotation.y -= delta * 0.024
    }
  })

  return (
    <group>
      {/* Tactical GLSL radar floor + graduated 360° telemetry compass + counter-rotating calibration arcs */}
      <group visible={showGrid}>
        <mesh
          rotation-x={-Math.PI / 2}
          position={[0, -0.24, 0]}
          geometry={geometries.floorGeo}
          material={mats.radarMat}
        />
        <lineSegments geometry={geometries.minorGeo} material={mats.minorMat} />
        <lineSegments geometry={geometries.majorGeo} material={mats.majorMat} />
        <lineSegments geometry={geometries.axisTickGeo} material={mats.axisTickMat} />
        <lineSegments ref={outerArcARef} geometry={geometries.arcAGeo} material={mats.arcAMat} />
        <lineSegments ref={outerArcBRef} geometry={geometries.arcBGeo} material={mats.arcBMat} />
      </group>

      {/* Ambient GPU-animated telemetry mote field */}
      <points geometry={geometries.particleGeo} material={mats.particleMat} frustumCulled={false} />
    </group>
  )
}
