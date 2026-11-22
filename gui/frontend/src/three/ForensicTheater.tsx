// ForensicTheater — 3D Forensic Theater main component (sole public entry in index.ts).
// Renders the WebGL tactical stage + Geek Tactical Command Deck HUD:
// corner targeting reticles, top-left telemetry strip with zero-rerender live
// camera AZ/EL/D readout, top-right camera pilot & layer dock, sleek glassmorphic
// focus inspector drawer, and cyber-forensic HoloPanels.
//
// Preserves window.__theaterDebug.zoneScreenPos(zone) and data-fullscreen-stage="theater".
import { useEffect, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  PHASE_ZONE,
  ZONES,
  zoneOf,
  type EvNode,
  type FocusTarget,
  type HypNode,
  type SceneState,
  type SessionScene,
  type ZoneKey,
} from './contract'
import { sceneActions, useSceneStore } from '../store/scene'
import { useSessionStore } from '../store/sessions'
import { useStageFullscreen } from '../lib/fullscreen'
import { pushEsc } from '../lib/escStack'
import { ThemeSync, useTheaterMaterials, type TheaterMaterials } from './ThemeMaterials'
import { useThrottledScene } from './useThrottledScene'
import {
  CAMERA_PRESETS,
  CAMERA_PRESET_LIST,
  CameraRig,
  HOME_POS,
  HOME_TARGET,
  computeCameraTelemetry,
  formatCameraTelemetry,
  hasOpenModalDialog,
  isEditableEventTarget,
  resolveTheaterShortcut,
} from './CameraRig'
import { StageEnvironment } from './StageEnvironment'
import { ZoneMarker } from './ZoneMarker'
import { PhaseRailMesh } from './PhaseRailMesh'
import { DagLayer } from './DagLayer'
import { HoloPanels, type HoloHudData } from './HoloPanels'
import './theaterHud.css'

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

/** 9 workflow phases -> compact 3-letter telemetry code (mirrors internal/workflow/phase.go). */
const PHASE_CODES = ['TRI', 'STA', 'DYN', 'EVI', 'INT', 'HYP', 'VER', 'AUD', 'WRI'] as const

const ZONE_DESCRIPTIONS: Record<ZoneKey, string> = {
  TRI: '样本接入、格式识别、入口点探测与攻击面初筛。',
  SCR: '静态反汇编、符号恢复、字符串与接口边界勘查。',
  HYP: '可证伪逆向假设塔与证据因果 DAG 演化中枢。',
  EXP: '宿主受控动态实验台，实跑探针并铸造不可篡改证据。',
  VER: '产物确定性重放验证与 SHA256 凭证签发台。',
  AUD: '独立对抗审计门禁，引用实测证据校验零幻觉闭环。',
  DEL: '最终归档与结构化 Writeup 报告交付坞。',
}

/** Last pointerdown page coords so onPointerMissed ignores orbit drags. */
const lastPointerDown = { x: Number.NaN, y: Number.NaN }

const INITIAL_TELEMETRY_TEXT = formatCameraTelemetry(computeCameraTelemetry(HOME_POS, HOME_TARGET))

export function ForensicTheater({ hud = null, onExitToClassic }: ForensicTheaterProps) {
  const materials = useTheaterMaterials()
  const scene = useThrottledScene(250)
  const fs = useStageFullscreen()
  const { focus, wizard, cameraPreset, autoOrbit, showGrid, showHoloPanels, showLabels } =
    useSceneStore()
  const telemetryRef = useRef<HTMLSpanElement | null>(null)

  // Cooperate LIFO with global escStack so Esc clears focus before exiting fullscreen/modals.
  useEffect(() => {
    if (focus.kind === 'global') return
    return pushEsc(() => sceneActions.setFocus({ kind: 'global' }))
  }, [focus.kind])

  // Single-key tactical camera pilot (1-4 presets, R reset, Space turntable).
  // Automatically ignored when typing in inputs or when any modal/wizard dialog is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = resolveTheaterShortcut(e, {
        editable: isEditableEventTarget(e.target),
        modalOpen: wizard !== null || hasOpenModalDialog(document),
        hasFocus: focus.kind !== 'global',
      })
      if (!action || action.kind === 'clear-focus') return
      e.preventDefault()
      if (action.kind === 'preset') {
        sceneActions.setCameraPreset(action.preset)
      } else if (action.kind === 'reset') {
        sceneActions.resetCamera()
      } else if (action.kind === 'toggle-orbit') {
        sceneActions.toggleAutoOrbit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [wizard, focus.kind])

  const primary = scene.sessions[0] ?? null
  const activeIdx = primary?.rail.activeIndex ?? -1
  const archived = primary?.rail.archived ?? false
  const phaseCode = activeIdx >= 0 && activeIdx < PHASE_CODES.length ? PHASE_CODES[activeIdx] : null
  const activeZone: ZoneKey | null =
    primary && !archived && activeIdx >= 0 && activeIdx < PHASE_ZONE.length ? PHASE_ZONE[activeIdx] : null

  const hypCount = scene.sessions.reduce((sum, s) => sum + s.hyps.length, 0)
  const evCount = scene.sessions.reduce((sum, s) => sum + s.evs.length, 0)

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
          camera={{ position: [...HOME_POS], fov: 48, near: 0.5, far: 650 }}
          onPointerMissed={(e) => {
            const dx = e.clientX - lastPointerDown.x
            const dy = e.clientY - lastPointerDown.y
            if (dx * dx + dy * dy > 36) return
            sceneActions.setFocus({ kind: 'global' })
          }}
        >
          <SceneRoot
            materials={materials}
            scene={scene}
            hud={hud}
            showGrid={showGrid}
            showHoloPanels={showHoloPanels}
            showLabels={showLabels}
            telemetryRef={telemetryRef}
            onExitToClassic={onExitToClassic}
          />
        </Canvas>

        {/* Subtle 4-corner hairline targeting reticles */}
        <div className="thud-reticles" aria-hidden="true">
          <span className="thud-reticle thud-reticle--tl" />
          <span className="thud-reticle thud-reticle--tr" />
          <span className="thud-reticle thud-reticle--bl" />
          <span className="thud-reticle thud-reticle--br" />
        </div>

        {/* Top-Left Telemetry Strip */}
        <div className="thud-glass thud-telemetry" aria-label="3D Theater Telemetry">
          <span className="thud-brand">◈ 3D//DECK</span>
          <span className="thud-sep" aria-hidden="true" />
          <span
            className={`thud-phase${archived ? ' thud-phase--archived' : phaseCode ? '' : ' thud-phase--idle'}`}
            data-hint={
              archived
                ? '当前会话已完成归档'
                : phaseCode
                  ? `当前取证工作流相位：${phaseCode}`
                  : '等待取证会话激活'
            }
            data-hint-side="bottom"
          >
            {archived ? '✓' : '▸'}
            {phaseCode ?? 'IDLE'}
          </span>
          <span className="thud-sep" aria-hidden="true" />
          <span
            className="thud-counts"
            data-hint={`已载入 ${hypCount} 条假设、${evCount} 条证据`}
            data-hint-side="bottom"
          >
            <span>
              <span className="thud-counts-key">H:</span>
              {hypCount}
            </span>
            <span style={{ color: 'var(--faint)' }}>·</span>
            <span>
              <span className="thud-counts-key">E:</span>
              {evCount}
            </span>
          </span>
          <span className="thud-sep" aria-hidden="true" />
          <span
            ref={telemetryRef}
            className="thud-cam-readout"
            data-hint="实时镜头方位角 (AZ)、仰角 (EL) 与视距 (D)"
            data-hint-side="bottom"
          >
            {INITIAL_TELEMETRY_TEXT}
          </span>
        </div>

        {/* Top-Right Tactical Control Dock */}
        <div className="thud-dock">
          <div className="thud-glass thud-group" role="group" aria-label="Camera presets">
            {CAMERA_PRESET_LIST.map((preset) => {
              const active = cameraPreset === preset.key && focus.kind === 'global'
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => sceneActions.setCameraPreset(preset.key)}
                  className={`thud-btn${active ? ' thud-btn--active' : ''}`}
                  aria-pressed={active}
                  data-hint={`${preset.title} — ${preset.hint}`}
                  data-hint-kbd={preset.shortcut}
                  data-hint-side="bottom"
                >
                  <span className="thud-btn-kbd">{preset.shortcut}</span>
                  <span>{preset.label}</span>
                </button>
              )
            })}
          </div>

          <div className="thud-glass thud-group" role="group" aria-label="Camera controls">
            <button
              type="button"
              onClick={() => sceneActions.toggleAutoOrbit()}
              className={`thud-btn${autoOrbit ? ' thud-btn--orbit-on' : ''}`}
              aria-pressed={autoOrbit}
              aria-label="自动环绕"
              data-hint={autoOrbit ? '暂停自动环绕（拖拽画布也会自动暂停）' : '开启慢速电影感自动环绕'}
              data-hint-kbd="Space"
              data-hint-side="bottom"
            >
              <span className="thud-orbit-glyph" aria-hidden="true">
                ⟳
              </span>
            </button>
            <button
              type="button"
              onClick={() => sceneActions.resetCamera()}
              className="thud-btn"
              aria-label="复位视角"
              data-hint="复位至全局俯瞰视角并清除聚焦"
              data-hint-kbd="R"
              data-hint-side="bottom"
            >
              R
            </button>
          </div>

          <div className="thud-glass thud-group" role="group" aria-label="Layer toggles">
            <button
              type="button"
              onClick={() => sceneActions.toggleGrid()}
              className={`thud-btn${showGrid ? ' thud-btn--active' : ' thud-btn--layer-off'}`}
              aria-pressed={showGrid}
              data-hint={showGrid ? '隐藏地面雷达坐标网格' : '显示地面雷达坐标网格'}
              data-hint-side="bottom"
            >
              网格
            </button>
            <button
              type="button"
              onClick={() => sceneActions.toggleHoloPanels()}
              className={`thud-btn${showHoloPanels ? ' thud-btn--active' : ' thud-btn--layer-off'}`}
              aria-pressed={showHoloPanels}
              data-hint={showHoloPanels ? '隐藏 3D 全息浮窗，纯粹欣赏几何拓扑' : '显示 3D 全息浮窗（转录/遥测/队列）'}
              data-hint-side="bottom"
            >
              浮窗
            </button>
            <button
              type="button"
              onClick={() => sceneActions.toggleLabels()}
              className={`thud-btn${showLabels ? ' thud-btn--active' : ' thud-btn--layer-off'}`}
              aria-pressed={showLabels}
              data-hint="显示/隐藏 3D 节点 ID 标签"
              data-hint-side="bottom"
            >
              标签
            </button>
          </div>

          {fs.open && (
            <span className="thud-fs-badge">
              {fs.nativeActive ? '● OS FULLSCREEN' : '● 100% VIEWPORT'}
            </span>
          )}
          <button
            type="button"
            onClick={fs.toggle}
            title={fs.open ? '退出 3D 剧场全屏 (Esc)' : '将 3D 剧场铺满整个屏幕（系统真全屏）'}
            data-hint={fs.open ? '退出 3D 剧场全屏' : '将 3D 剧场铺满整个屏幕（系统真全屏）'}
            data-hint-kbd={fs.open ? 'Esc' : undefined}
            data-hint-side="bottom"
            className={`thud-fs-btn${fs.open ? ' thud-fs-btn--exit' : ''}`}
          >
            {fs.open ? '✕ 退出全屏' : '⛶ 全屏剧场'}
          </button>
        </div>

        {/* Bottom-Left Micro Key Legend */}
        <div className="thud-legend" aria-hidden="true">
          DRAG 旋转 · SCROLL 缩放 · 1-4 视角 · SPACE 环绕 · R 复位
        </div>

        {/* Bottom-Right Tactical Inspector Drawer (only when focused) */}
        {focus.kind !== 'global' && (
          <TacticalInspector
            focus={focus}
            scene={scene}
            activeZone={activeZone}
            archived={archived}
            onExitToClassic={onExitToClassic}
          />
        )}
      </div>
    </>
  )
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

function findNodeInScene(
  scene: SceneState,
  nodeId: string,
):
  | { kind: 'hyp'; session: SessionScene; hyp: HypNode }
  | { kind: 'ev'; session: SessionScene; ev: EvNode }
  | null {
  for (const session of scene.sessions) {
    const hyp = session.hyps.find((h) => h.id === nodeId)
    if (hyp) return { kind: 'hyp', session, hyp }
    const ev = session.evs.find((e) => e.id === nodeId)
    if (ev) return { kind: 'ev', session, ev }
  }
  return null
}

function TacticalInspector({
  focus,
  scene,
  activeZone,
  archived,
  onExitToClassic,
}: {
  focus: Exclude<FocusTarget, { kind: 'global' }>
  scene: SceneState
  activeZone: ZoneKey | null
  archived: boolean
  onExitToClassic?: () => void
}) {
  const { sessions: runtimeSessions } = useSessionStore()
  const close = () => sceneActions.setFocus({ kind: 'global' })

  if (focus.kind === 'zone') {
    const spec = zoneOf(focus.zone)
    const isActive = activeZone === spec.key
    const primary = scene.sessions[0] ?? null
    return (
      <aside
        className={`thud-glass thud-inspector${isActive ? ' thud-inspector--ok' : ''}`}
        aria-label="Zone inspector"
      >
        <div className="thud-insp-head">
          <div className="thud-insp-title-wrap">
            <span className="thud-insp-code">{spec.key} //</span>
            <span className="thud-insp-sub">{spec.label}</span>
          </div>
          <span
            className={`thud-insp-badge ${
              isActive
                ? 'thud-insp-badge--ok'
                : archived && spec.key === 'DEL'
                  ? 'thud-insp-badge--accent'
                  : ''
            }`}
          >
            {isActive ? '● ACTIVE' : archived && spec.key === 'DEL' ? '✓ ARCHIVED' : 'STANDBY'}
          </span>
          <button
            type="button"
            className="thud-insp-close"
            onClick={close}
            aria-label="关闭检查器"
            data-hint="关闭聚焦检查器"
            data-hint-kbd="Esc"
            data-hint-side="top"
          >
            ✕
          </button>
        </div>
        <p className="thud-insp-body">{ZONE_DESCRIPTIONS[spec.key]}</p>
        <div className="thud-insp-metrics">
          <span className="thud-insp-pill">
            POS [{spec.center[0]}, {spec.center[1]}, {spec.center[2]}]
          </span>
          {spec.key === 'HYP' && primary && (
            <span className="thud-insp-pill">
              H:{primary.hyps.length} · E:{primary.evs.length}
            </span>
          )}
        </div>
        <div className="thud-insp-actions">
          {spec.key === 'HYP' && (
            <button
              type="button"
              className="thud-insp-cta"
              onClick={() => sceneActions.setCameraPreset('hyp')}
              data-hint={`切换至${CAMERA_PRESETS.hyp.title}`}
              data-hint-kbd="3"
              data-hint-side="top"
            >
              特写假设塔
            </button>
          )}
          {onExitToClassic && (
            <button
              type="button"
              className="thud-insp-cta thud-insp-cta--muted"
              onClick={onExitToClassic}
              data-hint="切换至经典 2D 工作台查看详情"
              data-hint-side="top"
            >
              经典工作台 ↗
            </button>
          )}
        </div>
      </aside>
    )
  }

  if (focus.kind === 'node') {
    const found = findNodeInScene(scene, focus.nodeId)
    if (found?.kind === 'hyp') {
      const { hyp, session } = found
      const pct = Math.round(clamp01(hyp.confidence) * 100)
      let supportCount = 0
      let contradictCount = 0
      for (const edge of session.edges) {
        if (edge.to !== hyp.id) continue
        if (edge.kind === 'support' || edge.kind === 'audit') supportCount++
        else if (edge.kind === 'contradict') contradictCount++
      }
      const toneClass =
        hyp.status === 'revised'
          ? 'violet'
          : hyp.status === 'reevaluate'
            ? 'warn'
            : hyp.status === 'rejected'
              ? 'err'
              : 'accent'
      const barColor =
        toneClass === 'violet'
          ? 'var(--violet)'
          : toneClass === 'warn'
            ? 'var(--warn)'
            : toneClass === 'err'
              ? 'var(--err)'
              : 'var(--accent)'
      return (
        <aside
          className={`thud-glass thud-inspector thud-inspector--${toneClass}`}
          aria-label="Hypothesis inspector"
        >
          <div className="thud-insp-head">
            <div className="thud-insp-title-wrap">
              <span className="thud-insp-code" style={{ color: barColor }}>
                {hyp.id}
              </span>
              <span className="thud-insp-sub">假设节点</span>
            </div>
            <span className={`thud-insp-badge thud-insp-badge--${toneClass}`}>{hyp.status}</span>
            <button
              type="button"
              className="thud-insp-close"
              onClick={close}
              aria-label="关闭检查器"
              data-hint="关闭聚焦检查器"
              data-hint-kbd="Esc"
              data-hint-side="top"
            >
              ✕
            </button>
          </div>

          <div className="thud-insp-bar-row">
            <span>CONF</span>
            <div className="thud-insp-track" aria-hidden="true">
              <div className="thud-insp-fill" style={{ width: `${pct}%`, background: barColor }} />
            </div>
            <span style={{ color: 'var(--text)', fontWeight: 700 }}>{pct}%</span>
          </div>

          <div className="thud-insp-metrics">
            <span className="thud-insp-pill" style={{ color: 'var(--ok)' }}>
              +{supportCount} 支持
            </span>
            <span
              className="thud-insp-pill"
              style={{ color: contradictCount > 0 ? 'var(--err)' : 'var(--faint)' }}
            >
              -{contradictCount} 反证
            </span>
            <span className="thud-insp-pill">实验 {hyp.experiments.length}</span>
          </div>

          <p className="thud-insp-body" title={hyp.claim}>
            {hyp.claim || '（无假设声明）'}
          </p>

          <div className="thud-insp-actions">
            <button
              type="button"
              className="thud-insp-cta"
              onClick={() =>
                sceneActions.openWizard({
                  sessionId: session.sessionId,
                  stage: 'experiment',
                  hypId: hyp.id,
                })
              }
              data-hint="打开该假设的实验配置向导（也可双击 3D 棱柱）"
              data-hint-side="top"
            >
              配置实验 →
            </button>
            {onExitToClassic && (
              <button
                type="button"
                className="thud-insp-cta thud-insp-cta--muted"
                onClick={onExitToClassic}
                data-hint="返回经典工作台查看假设栈"
                data-hint-side="top"
              >
                经典工作台 ↗
              </button>
            )}
          </div>
        </aside>
      )
    }

    if (found?.kind === 'ev') {
      const { ev, session } = found
      const fullEv = runtimeSessions
        .get(session.sessionId)
        ?.latestTick?.ledger?.evidence.find((item) => item.id === ev.id)
      const toneClass = ev.isError ? 'err' : ev.verified ? 'ok' : 'accent'
      const badgeLabel = ev.isError ? '✗ ERROR' : ev.verified ? '✓ VERIFIED' : 'RECORDED'
      return (
        <aside
          className={`thud-glass thud-inspector thud-inspector--${toneClass}`}
          aria-label="Evidence inspector"
        >
          <div className="thud-insp-head">
            <div className="thud-insp-title-wrap">
              <span
                className="thud-insp-code"
                style={{
                  color: ev.isError ? 'var(--err)' : ev.verified ? 'var(--ok)' : 'var(--accent)',
                }}
              >
                {ev.id}
              </span>
              <span className="thud-insp-sub">证据节点</span>
            </div>
            <span className={`thud-insp-badge thud-insp-badge--${toneClass}`}>{badgeLabel}</span>
            <button
              type="button"
              className="thud-insp-close"
              onClick={close}
              aria-label="关闭检查器"
              data-hint="关闭聚焦检查器"
              data-hint-kbd="Esc"
              data-hint-side="top"
            >
              ✕
            </button>
          </div>

          <div className="thud-insp-metrics">
            <span className="thud-insp-pill">KIND: {ev.kind}</span>
            {fullEv?.view && <span className="thud-insp-pill">VIEW: {fullEv.view}</span>}
          </div>

          <p className="thud-insp-body" title={ev.summary}>
            {ev.summary || '（无摘要）'}
          </p>

          {onExitToClassic && (
            <div className="thud-insp-actions">
              <button
                type="button"
                className="thud-insp-cta"
                onClick={onExitToClassic}
                data-hint="一键跳转经典 2D 工作台查看完整证据原文"
                data-hint-side="top"
              >
                在经典工作台查看 ↗
              </button>
            </div>
          )}
        </aside>
      )
    }

    return (
      <aside className="thud-glass thud-inspector" aria-label="Node inspector">
        <div className="thud-insp-head">
          <div className="thud-insp-title-wrap">
            <span className="thud-insp-code">{focus.nodeId}</span>
            <span className="thud-insp-sub">节点已离开视图</span>
          </div>
          <button
            type="button"
            className="thud-insp-close"
            onClick={close}
            aria-label="关闭检查器"
          >
            ✕
          </button>
        </div>
      </aside>
    )
  }

  // focus.kind === 'session'
  const session = scene.sessions.find((s) => s.sessionId === focus.sessionId)
  return (
    <aside className="thud-glass thud-inspector" aria-label="Session inspector">
      <div className="thud-insp-head">
        <div className="thud-insp-title-wrap">
          <span className="thud-insp-code">SESSION //</span>
          <span className="thud-insp-sub">{focus.sessionId}</span>
        </div>
        <button
          type="button"
          className="thud-insp-close"
          onClick={close}
          aria-label="关闭检查器"
          data-hint="关闭聚焦检查器"
          data-hint-kbd="Esc"
          data-hint-side="top"
        >
          ✕
        </button>
      </div>
      {session && (
        <div className="thud-insp-metrics">
          <span className="thud-insp-pill">H:{session.hyps.length}</span>
          <span className="thud-insp-pill">E:{session.evs.length}</span>
          <span className="thud-insp-pill">EDGES:{session.edges.length}</span>
        </div>
      )}
    </aside>
  )
}

function SceneRoot({
  materials,
  scene,
  hud,
  showGrid,
  showHoloPanels,
  showLabels,
  telemetryRef,
  onExitToClassic,
}: {
  materials: TheaterMaterials
  scene: SceneState
  hud: HoloHudData | null
  showGrid: boolean
  showHoloPanels: boolean
  showLabels: boolean
  telemetryRef: React.RefObject<HTMLSpanElement | null>
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
      <StageEnvironment materials={materials} showGrid={showGrid} />
      <CameraRig telemetryRef={telemetryRef} />
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
              <DagLayer session={s} materials={materials} showLabels={showLabels} />
            </group>
          ))}
          <HoloPanels
            materials={materials}
            hud={hud}
            visible={showHoloPanels}
            onExitToClassic={onExitToClassic}
          />
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
