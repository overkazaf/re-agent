// ForensicTheater — 3D Forensic Theater main component (sole public entry in index.ts).
// Renders the WebGL tactical stage: calibrated lighting, atmospheric depth fog,
// architectural coordinate floor grid, CameraRig, ZoneMarkers, dual-layer
// PhaseRailMesh, Evidence/Hypothesis DAG, and frosted HoloPanels.
//
// Preserves window.__theaterDebug.zoneScreenPos(zone) and data-fullscreen-stage="theater".
import { useEffect, useMemo, type CSSProperties } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { PHASE_ZONE, ZONES, zoneOf, type SceneState, type ZoneKey } from './contract'
import { sceneActions } from '../store/scene'
import { useStageFullscreen } from '../lib/fullscreen'
import { ThemeSync, useTheaterMaterials, type TheaterMaterials } from './ThemeMaterials'
import { useThrottledScene } from './useThrottledScene'
import { CameraRig } from './CameraRig'
import { ZoneMarker } from './ZoneMarker'
import { PhaseRailMesh } from './PhaseRailMesh'
import { DagLayer } from './DagLayer'
import { HoloPanels, type HoloHudData } from './HoloPanels'

declare global {
  interface Window {
    __DEMO__?: boolean
    /** Track A E2E debug hook (DEV / demo; see contract.ts) */
    __theaterDebug?: {
      zoneScreenPos: (zone: ZoneKey) => { x: number; y: number } | null
    }
  }
}

export interface ForensicTheaterProps {
  /** Low-frequency HUD summary (TRANSCRIPT/TELE/QUEUE) */
  hud?: HoloHudData | null
  /** Clicking a TRANSCRIPT strip returns to Classic workbench view */
  onExitToClassic?: () => void
}

/** Last pointerdown page coords so onPointerMissed ignores orbit drags. */
const lastPointerDown = { x: Number.NaN, y: Number.NaN }

export function ForensicTheater({ hud = null, onExitToClassic }: ForensicTheaterProps) {
  const materials = useTheaterMaterials()
  const scene = useThrottledScene(250)
  const fs = useStageFullscreen()
  return (
    <>
      <ThemeSync />
      <div
        data-fullscreen-stage={fs.open ? 'theater' : undefined}
        style={
          fs.open
            ? {
                position: 'fixed',
                inset: 0,
                width: '100vw',
                height: '100vh',
                zIndex: 38,
                background: 'var(--bg)',
              }
            : { position: 'relative', flex: '1 1 0', minHeight: 0 }
        }
      >
        <Canvas
          style={{ position: 'absolute', inset: 0 }}
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ position: [0, 74, 126], fov: 48, near: 0.5, far: 650 }}
          onPointerMissed={(e) => {
            const dx = e.clientX - lastPointerDown.x
            const dy = e.clientY - lastPointerDown.y
            if (dx * dx + dy * dy > 36) return
            sceneActions.setFocus({ kind: 'global' })
          }}
        >
          <SceneRoot materials={materials} scene={scene} hud={hud} onExitToClassic={onExitToClassic} />
        </Canvas>
        <div style={theaterFsBarStyle}>
          {fs.open && (
            <span style={theaterFsBadgeStyle}>
              {fs.nativeActive ? '● OS FULLSCREEN' : '● 100% VIEWPORT'}
            </span>
          )}
          <button
            type="button"
            onClick={fs.toggle}
            title={fs.open ? '退出 3D 剧场全屏 (Esc)' : '将 3D 剧场铺满整个屏幕（系统真全屏）'}
            style={fs.open ? theaterFsExitBtnStyle : theaterFsBtnStyle}
          >
            {fs.open ? '✕ 退出全屏' : '⛶ 全屏剧场'}
          </button>
        </div>
        <div style={theaterLegendStyle} aria-hidden>
          DRAG ORBIT · SCROLL ZOOM · CLICK ZONE · CLICK VOID RESET
        </div>
      </div>
    </>
  )
}

const theaterFsBarStyle: CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 12,
  zIndex: 5,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
}

const theaterFsBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--ok)',
  border: '1px solid color-mix(in srgb, var(--ok) 45%, var(--rule))',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-3) 86%, transparent)',
  backdropFilter: 'blur(6px)',
  padding: '3px 8px',
  letterSpacing: '0.08em',
}

const theaterFsBtnStyle: CSSProperties = {
  border: '1px solid var(--border-accent)',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-3) 84%, transparent)',
  backdropFilter: 'blur(6px)',
  color: 'var(--accent)',
  fontSize: 10.5,
  fontWeight: 500,
  padding: '3px 9px',
  letterSpacing: '0.04em',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.38)',
}

const theaterFsExitBtnStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--warn) 70%, var(--rule))',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-3) 92%, transparent)',
  backdropFilter: 'blur(6px)',
  color: 'var(--warn)',
  fontSize: 10.5,
  fontWeight: 600,
  padding: '3px 10px',
  letterSpacing: '0.04em',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.44)',
}

const theaterLegendStyle: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 10,
  zIndex: 4,
  pointerEvents: 'none',
  fontSize: 9.5,
  letterSpacing: '0.12em',
  color: 'var(--faint)',
  opacity: 0.72,
  padding: '2px 7px',
  borderRadius: 'var(--radius-xs)',
  background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
  border: '1px solid var(--border-subtle)',
}

/**
 * Architectural ground stage: subtle coordinate grid, concentric radar
 * calibration rings, and faint axis guides that anchor zones in 3D space.
 */
function StageFloor({ materials }: { materials: TheaterMaterials }) {
  const { gridGeo, axisGeo, gridMat, axisMat, ringMat } = useMemo(() => {
    // Coarse tactical grid (-96..96 every 16 units)
    const gridPts: number[] = []
    const extent = 96
    const step = 16
    for (let v = -extent; v <= extent; v += step) {
      if (v === 0) continue
      gridPts.push(-extent, -0.22, v, extent, -0.22, v)
      gridPts.push(v, -0.22, -extent, v, -0.22, extent)
    }
    const gGeo = new THREE.BufferGeometry()
    gGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3))

    const aGeo = new THREE.BufferGeometry()
    aGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-extent, -0.18, 0, extent, -0.18, 0, 0, -0.18, -extent, 0, -0.18, extent],
        3,
      ),
    )

    const gMat = new THREE.LineBasicMaterial({
      color: materials.rule,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    })
    const aMat = new THREE.LineBasicMaterial({
      color: materials.faint,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    })
    const rMat = new THREE.MeshBasicMaterial({
      color: materials.rule,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    return { gridGeo: gGeo, axisGeo: aGeo, gridMat: gMat, axisMat: aMat, ringMat: rMat }
  }, [materials])

  useEffect(
    () => () => {
      gridGeo.dispose()
      axisGeo.dispose()
      gridMat.dispose()
      axisMat.dispose()
      ringMat.dispose()
    },
    [gridGeo, axisGeo, gridMat, axisMat, ringMat],
  )

  return (
    <group>
      <lineSegments geometry={gridGeo} material={gridMat} />
      <lineSegments geometry={axisGeo} material={axisMat} />
      {/* Concentric forensic calibration rings centered on EXP */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.16, 0]} material={ringMat}>
        <ringGeometry args={[41.6, 42, 96]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.16, 0]} material={ringMat}>
        <ringGeometry args={[73.6, 74, 112]} />
      </mesh>
    </group>
  )
}

function SceneRoot({
  materials,
  scene,
  hud,
  onExitToClassic,
}: {
  materials: TheaterMaterials
  scene: SceneState
  hud: HoloHudData | null
  onExitToClassic?: () => void
}) {
  const primary = scene.sessions[0] ?? null
  let activeZone: ZoneKey | null = null
  if (primary && !primary.rail.archived) {
    const i = primary.rail.activeIndex
    if (i >= 0 && i < PHASE_ZONE.length) activeZone = PHASE_ZONE[i]
  }
  return (
    <>
      <color attach="background" args={[materials.bg.getHex()]} />
      <fog attach="fog" args={[materials.bg.getHex(), 138, 295]} />
      <ambientLight intensity={0.32} />
      <hemisphereLight args={[materials.accent, materials.bg, 0.45]} />
      {/* Crisp architectural key light for specular facets on optical-glass cores */}
      <directionalLight position={[42, 82, 58]} intensity={0.78} color={materials.text} />
      {/* Accent wash over EXP/HYP + violet rim over AUD */}
      <pointLight position={[0, 36, 12]} color={materials.accent} intensity={1.05} decay={0} />
      <pointLight position={[0, 36, -62]} color={materials.violet} intensity={0.85} decay={0} />
      <StageFloor materials={materials} />
      <CameraRig />
      <PointerDownProbe />
      <TheaterDebugBridge />
      {scene.empty ? (
        <ZoneMarker zone={zoneOf('TRI')} materials={materials} breathing />
      ) : (
        <>
          {ZONES.map((z) => (
            <ZoneMarker key={z.key} zone={z} materials={materials} active={activeZone === z.key} />
          ))}
          {scene.sessions.map((s) => (
            <group key={s.sessionId} position={s.offset}>
              <PhaseRailMesh rail={s.rail} materials={materials} />
              <DagLayer session={s} materials={materials} />
            </group>
          ))}
          <HoloPanels materials={materials} hud={hud} onExitToClassic={onExitToClassic} />
        </>
      )}
    </>
  )
}

/** Tracks pointerdown coords so onPointerMissed separates clicks from orbit drags. */
function PointerDownProbe(): null {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const el = gl.domElement
    const onDown = (e: PointerEvent) => {
      lastPointerDown.x = e.clientX
      lastPointerDown.y = e.clientY
    }
    el.addEventListener('pointerdown', onDown)
    return () => el.removeEventListener('pointerdown', onDown)
  }, [gl])
  return null
}

/** E2E debug bridge: projects zone center into viewport pixels. */
function TheaterDebugBridge(): null {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
    if (!env?.DEV && !window.__DEMO__) return
    const v = new THREE.Vector3()
    window.__theaterDebug = {
      zoneScreenPos(zone) {
        const spec = ZONES.find((z) => z.key === zone)
        if (!spec) return null
        v.set(spec.center[0], spec.center[1], spec.center[2]).project(camera)
        const rect = gl.domElement.getBoundingClientRect()
        return {
          x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
          y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
        }
      },
    }
    return () => {
      delete window.__theaterDebug
    }
  }, [camera, gl])
  return null
}
