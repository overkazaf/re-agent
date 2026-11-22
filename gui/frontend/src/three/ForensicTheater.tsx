// ForensicTheater — 3D Forensic Theater main component (sole public entry in index.ts).
// Renders the WebGL tactical stage + Geek Tactical Command Deck HUD:
// corner targeting reticles, top-left telemetry strip with zero-rerender live
// camera AZ/EL/D readout, top-right camera pilot & layer dock, collapsible left
// 3D Node Explorer drawer, rich right-side Forensic Node Inspector (Hypotheses,
// Evidence, and Zones with live ledger/sandbox/audit provenance), and HoloPanels.
//
// Preserves window.__theaterDebug.zoneScreenPos(zone) and data-fullscreen-stage="theater".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type {
  AuditVerdict,
  EvidenceRecord,
  FindingDTO,
  GoalSummaryDTO,
  Hypothesis,
  HypothesisExperiment,
  LedgerDTO,
  SandboxDTO,
} from '../lib/types'
import { sceneActions, useSceneStore } from '../store/scene'
import { useSessionStore, type SessionRuntime } from '../store/sessions'
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
import { useTheaterPerfGuard } from './useTheaterFallback'
import { ZoneMarker } from './ZoneMarker'
import { PhaseRailMesh } from './PhaseRailMesh'
import { DagLayer } from './DagLayer'
import { HoloPanels, type HoloHudData } from './HoloPanels'
import { classifyEvidenceShape, evidenceKindTag, truncateTelemetry } from './dagGeometry'
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

const ZONE_INDEX: Record<ZoneKey, string> = {
  TRI: '01',
  SCR: '02',
  HYP: '03',
  EXP: '04',
  VER: '05',
  AUD: '06',
  DEL: '07',
}

/** Last pointerdown page coords so onPointerMissed ignores orbit drags. */
const lastPointerDown = { x: Number.NaN, y: Number.NaN }

const INITIAL_TELEMETRY_TEXT = formatCameraTelemetry(computeCameraTelemetry(HOME_POS, HOME_TARGET))
const CANVAS_GL = { antialias: true, powerPreference: 'high-performance' as const }
const CANVAS_DPR_HD: [number, number] = [1, 1.5]

export function ForensicTheater({ hud = null, onExitToClassic }: ForensicTheaterProps) {
  const materials = useTheaterMaterials()
  const scene = useThrottledScene(250)
  const fs = useStageFullscreen()
  const perf = useTheaterPerfGuard()
  const { focus, wizard, cameraPreset, autoOrbit, showGrid, showHoloPanels, showLabels } =
    useSceneStore()
  const [explorerOpen, setExplorerOpen] = useState(false)
  const telemetryRef = useRef<HTMLSpanElement | null>(null)

  // Cooperate LIFO with global escStack: explorer pushes first, focus pushes above it so
  // Esc clears node/zone focus before closing explorer or exiting fullscreen.
  useEffect(() => {
    if (!explorerOpen) return
    return pushEsc(() => setExplorerOpen(false))
  }, [explorerOpen])

  useEffect(() => {
    if (focus.kind === 'global') return
    return pushEsc(() => sceneActions.setFocus({ kind: 'global' }))
  }, [focus.kind])

  // Single-key tactical camera pilot (1-4 presets, R reset, Space turntable, I node explorer).
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
      } else if (action.kind === 'toggle-explorer') {
        setExplorerOpen((open) => !open)
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
          dpr={perf.eco ? 1 : CANVAS_DPR_HD}
          frameloop={perf.tabHidden ? 'never' : 'always'}
          gl={CANVAS_GL}
          camera={{ position: [...HOME_POS], fov: 48, near: 0.5, far: 650 }}
          onPointerMissed={(e) => {
            const target = e.target as HTMLElement | null
            if (
              target?.closest?.(
                '[data-theater-interactive="true"], .thud-inspector, .thud-explorer, .thud-dock, .thud-telemetry',
              )
            ) {
              return
            }
            const dx = e.clientX - lastPointerDown.x
            const dy = e.clientY - lastPointerDown.y
            if (dx * dx + dy * dy > 36) return
            sceneActions.setFocus({ kind: 'global' })
          }}
        >
          <SceneRoot
            materials={materials}
            scene={scene}
            focus={focus}
            hud={hud}
            showGrid={showGrid}
            showHoloPanels={showHoloPanels}
            showLabels={showLabels}
            ecoMode={perf.eco}
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
          <button
            type="button"
            className={`thud-counts thud-counts--btn${explorerOpen ? ' thud-counts--open' : ''}`}
            onClick={() => setExplorerOpen((open) => !open)}
            aria-expanded={explorerOpen}
            aria-label={`节点浏览器：${hypCount} 条假设、${evCount} 条证据`}
            data-hint={`已载入 ${hypCount} 条假设、${evCount} 条证据 — 点击展开 3D 节点浏览器`}
            data-hint-kbd="I"
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
            <span className="thud-counts-caret" aria-hidden="true">
              {explorerOpen ? '▴' : '▾'}
            </span>
          </button>
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
              onClick={() => setExplorerOpen((open) => !open)}
              className={`thud-btn${explorerOpen ? ' thud-btn--active' : ''}`}
              aria-pressed={explorerOpen}
              data-hint={explorerOpen ? '收起 3D 节点浏览器' : '展开 3D 节点浏览器，快速聚焦假设/证据/工位'}
              data-hint-kbd="I"
              data-hint-side="bottom"
            >
              <span className="thud-btn-kbd">I</span>
              <span>节点</span>
            </button>
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

          <div className="thud-glass thud-group" role="group" aria-label="Render quality">
            <button
              type="button"
              onClick={perf.toggleQuality}
              className={`thud-btn${perf.eco ? ' thud-btn--orbit-on' : ' thud-btn--active'}`}
              aria-pressed={perf.eco}
              aria-label={perf.eco ? '3D 节能模式（点击切换高清）' : '3D 高清模式（点击切换节能）'}
              data-quality-tier={perf.tier}
              data-quality-pref={perf.preference}
              data-hint="切换 3D 渲染画质（高清 1.5x / 节能 1x 降粒子），低帧率时自动切换节能而不再强退 3D"
              data-hint-side="bottom"
            >
              {perf.eco ? '⚡ 节能' : '◈ 高清'}
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

        {/* Collapsible Left-Side 3D Node Explorer Drawer */}
        {explorerOpen && (
          <NodeExplorer
            scene={scene}
            focus={focus}
            activeZone={activeZone}
            archived={archived}
            onClose={() => setExplorerOpen(false)}
          />
        )}

        {/* Bottom-Left Micro Key Legend */}
        <div className="thud-legend" aria-hidden="true">
          DRAG 旋转 · SCROLL 缩放 · 1-4 视角 · I 节点 · SPACE 环绕 · R 复位
        </div>

        {/* Right-Side Rich 3D Forensic Node Inspector (only when focused) */}
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

// ---------- Shared pure helpers ----------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

function formatBytes(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function shortHash(sha: string | undefined): string {
  if (!sha) return ''
  return sha.length > 16 ? `${sha.slice(0, 12)}…${sha.slice(-4)}` : sha
}

function dedupeStrings(items: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function useCopyText() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const copy = useCallback((key: string, text: string) => {
    const finish = () => {
      setCopiedKey(key)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopiedKey(null), 1600)
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(finish, () => {
        fallbackCopy(text)
        finish()
      })
    } else {
      fallbackCopy(text)
      finish()
    }
  }, [])

  return { copiedKey, copy }
}

function fallbackCopy(text: string): void {
  if (typeof document === 'undefined') return
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    // ignore clipboard errors in restricted sandboxes
  }
}

function hypToneClass(status: HypNode['status']): 'accent' | 'violet' | 'warn' | 'err' {
  switch (status) {
    case 'revised':
      return 'violet'
    case 'reevaluate':
      return 'warn'
    case 'rejected':
      return 'err'
    default:
      return 'accent'
  }
}

function toneCssColor(tone: 'accent' | 'violet' | 'warn' | 'err' | 'ok'): string {
  switch (tone) {
    case 'violet':
      return 'var(--violet)'
    case 'warn':
      return 'var(--warn)'
    case 'err':
      return 'var(--err)'
    case 'ok':
      return 'var(--ok)'
    default:
      return 'var(--accent)'
  }
}

function verdictMeta(verdict: AuditVerdict | undefined): {
  label: string
  tone: 'ok' | 'warn' | 'err' | 'accent'
} {
  switch (verdict) {
    case 'accepted':
      return { label: '✓ ACCEPTED', tone: 'ok' }
    case 'rejected':
      return { label: '✗ REJECTED', tone: 'err' }
    case 'needs_more_evidence':
      return { label: '⚠ NEEDS MORE EVIDENCE', tone: 'warn' }
    default:
      return { label: 'PENDING AUDIT', tone: 'accent' }
  }
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

function resolveRuntime(
  runtimeSessions: ReadonlyMap<string, SessionRuntime>,
  activeId: string | null,
  preferredSessionId?: string | null,
): SessionRuntime | null {
  if (preferredSessionId) {
    const exact = runtimeSessions.get(preferredSessionId)
    if (exact) return exact
  }
  if (activeId) {
    const act = runtimeSessions.get(activeId)
    if (act) return act
  }
  for (const rt of runtimeSessions.values()) return rt
  return null
}

function extractWriteupSummary(rt: SessionRuntime | null, ledger: LedgerDTO | null): string | null {
  if (rt) {
    for (let i = rt.loopBuffer.length - 1; i >= 0; i--) {
      const ev = rt.loopBuffer[i]
      if (ev && ev.type === 'reply' && ev.text && ev.text.trim().length > 0) {
        return ev.text.trim()
      }
    }
  }
  const activeHyps = (ledger?.hypotheses ?? []).filter((h) => h.status !== 'rejected')
  if (activeHyps.length > 0) {
    return activeHyps.map((h) => `${h.id} (${Math.round(clamp01(h.confidence) * 100)}%): ${h.claim}`).join('\n')
  }
  return null
}

// ---------- Collapsible Left-Side 3D Node Explorer Drawer ----------

function NodeExplorer({
  scene,
  focus,
  activeZone,
  archived,
  onClose,
}: {
  scene: SceneState
  focus: FocusTarget
  activeZone: ZoneKey | null
  archived: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const allHyps = useMemo(() => scene.sessions.flatMap((s) => s.hyps), [scene.sessions])
  const allEvs = useMemo(() => scene.sessions.flatMap((s) => s.evs), [scene.sessions])
  const totalNodes = allHyps.length + allEvs.length
  const showFilter = totalNodes > 6
  const q = query.trim().toLowerCase()

  const filteredHyps = useMemo(() => {
    if (!q) return allHyps
    return allHyps.filter(
      (h) =>
        h.id.toLowerCase().includes(q) ||
        h.claim.toLowerCase().includes(q) ||
        h.status.toLowerCase().includes(q),
    )
  }, [allHyps, q])

  const filteredEvs = useMemo(() => {
    if (!q) return allEvs
    return allEvs.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.kind.toLowerCase().includes(q) ||
        e.summary.toLowerCase().includes(q),
    )
  }, [allEvs, q])

  return (
    <aside className="thud-glass thud-explorer" aria-label="3D Node Explorer">
      <div className="thud-exp-head">
        <div className="thud-insp-title-wrap">
          <span className="thud-insp-code">◈ 节点</span>
          <span className="thud-exp-counts">
            H:{allHyps.length} · E:{allEvs.length}
          </span>
        </div>
        <button
          type="button"
          className="thud-insp-close"
          onClick={onClose}
          aria-label="关闭节点浏览器"
          data-hint="关闭节点浏览器"
          data-hint-kbd="I"
          data-hint-side="right"
        >
          ✕
        </button>
      </div>

      {showFilter && (
        <div className="thud-exp-search-wrap">
          <input
            type="text"
            className="thud-exp-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选 H-NNN / ev_NNN / 关键词…"
            aria-label="筛选 3D 节点"
          />
          {query && (
            <button
              type="button"
              className="thud-exp-search-clear"
              onClick={() => setQuery('')}
              aria-label="清空筛选"
            >
              ✕
            </button>
          )}
        </div>
      )}

      <div className="thud-exp-scroll">
        {/* Hypotheses */}
        <section className="thud-exp-section">
          <div className="thud-exp-sec-title">
            <span>假设 HYPOTHESES</span>
            <span className="thud-exp-sec-count">{filteredHyps.length}</span>
          </div>
          {filteredHyps.length === 0 ? (
            <div className="thud-exp-empty">{allHyps.length === 0 ? '暂无假设节点' : '无匹配假设'}</div>
          ) : (
            <div className="thud-exp-list">
              {filteredHyps.map((h) => {
                const selected = focus.kind === 'node' && focus.nodeId === h.id
                const tone = hypToneClass(h.status)
                const dotColor = toneCssColor(tone)
                const pct = Math.round(clamp01(h.confidence) * 100)
                return (
                  <button
                    key={h.id}
                    type="button"
                    className={`thud-exp-row${selected ? ' thud-exp-row--selected' : ''}`}
                    onClick={() => sceneActions.setFocus({ kind: 'node', nodeId: h.id })}
                  >
                    <span className="thud-exp-dot" style={{ background: dotColor }} />
                    <span className="thud-exp-id" style={{ color: dotColor }}>
                      {h.id}
                    </span>
                    <span className="thud-exp-text">{truncateTelemetry(h.claim || '（无声明）', 26)}</span>
                    <span className="thud-exp-meta">{pct}%</span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* Evidence */}
        <section className="thud-exp-section">
          <div className="thud-exp-sec-title">
            <span>证据 EVIDENCE</span>
            <span className="thud-exp-sec-count">{filteredEvs.length}</span>
          </div>
          {filteredEvs.length === 0 ? (
            <div className="thud-exp-empty">{allEvs.length === 0 ? '暂无证据节点' : '无匹配证据'}</div>
          ) : (
            <div className="thud-exp-list">
              {filteredEvs.map((ev) => {
                const selected = focus.kind === 'node' && focus.nodeId === ev.id
                const shape = classifyEvidenceShape(ev.kind)
                const dotColor = ev.isError
                  ? 'var(--err)'
                  : shape === 'audit'
                    ? 'var(--warn)'
                    : ev.verified
                      ? 'var(--ok)'
                      : 'var(--accent)'
                return (
                  <button
                    key={ev.id}
                    type="button"
                    className={`thud-exp-row${selected ? ' thud-exp-row--selected' : ''}`}
                    onClick={() => sceneActions.setFocus({ kind: 'node', nodeId: ev.id })}
                  >
                    <span className="thud-exp-dot" style={{ background: dotColor }} />
                    <span className="thud-exp-id" style={{ color: dotColor }}>
                      {ev.id}
                    </span>
                    <span className="thud-exp-text">{truncateTelemetry(ev.summary || ev.kind, 24)}</span>
                    <span className="thud-exp-tag">{evidenceKindTag(ev.kind)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* Zones */}
        <section className="thud-exp-section">
          <div className="thud-exp-sec-title">
            <span>工位 STATIONS</span>
            <span className="thud-exp-sec-count">{ZONES.length}</span>
          </div>
          <div className="thud-exp-zone-grid">
            {ZONES.map((z) => {
              const selected = focus.kind === 'zone' && focus.zone === z.key
              const isActive = activeZone === z.key
              const isDone = archived && z.key === 'DEL'
              return (
                <button
                  key={z.key}
                  type="button"
                  className={`thud-exp-zone${selected ? ' thud-exp-zone--selected' : ''}${isActive ? ' thud-exp-zone--active' : ''}`}
                  onClick={() => sceneActions.setFocus({ kind: 'zone', zone: z.key })}
                >
                  <span className="thud-exp-zone-code">
                    {ZONE_INDEX[z.key]}·{z.key}
                  </span>
                  <span className="thud-exp-zone-label">{z.label}</span>
                  {(isActive || isDone) && (
                    <span
                      className="thud-exp-dot"
                      style={{ background: isDone ? 'var(--accent)' : 'var(--ok)' }}
                    />
                  )}
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </aside>
  )
}

// ---------- Rich Right-Side Forensic Node Inspector ----------

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
  const { sessions: runtimeSessions, activeId } = useSessionStore()
  const { copiedKey, copy } = useCopyText()
  const close = () => sceneActions.setFocus({ kind: 'global' })
  const jumpNode = (nodeId: string) => sceneActions.setFocus({ kind: 'node', nodeId })

  if (focus.kind === 'zone') {
    const spec = zoneOf(focus.zone)
    const isActive = activeZone === spec.key
    const primary = scene.sessions[0] ?? null
    const runtime = resolveRuntime(runtimeSessions, activeId, primary?.sessionId)
    const ledger = runtime?.latestTick?.ledger ?? null

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

        <div className="thud-insp-scroll">
          <p className="thud-insp-desc">{ZONE_DESCRIPTIONS[spec.key]}</p>
          <div className="thud-insp-metrics">
            <span className="thud-insp-pill">
              POS [{spec.center[0]}, {spec.center[1]}, {spec.center[2]}]
            </span>
            {primary && (
              <span className="thud-insp-pill">
                H:{primary.hyps.length} · E:{primary.evs.length}
              </span>
            )}
          </div>

          <ZoneContextualContent
            zoneKey={spec.key}
            primary={primary}
            runtime={runtime}
            ledger={ledger}
            copiedKey={copiedKey}
            onCopy={copy}
            onJumpNode={jumpNode}
          />
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
      const runtime = resolveRuntime(runtimeSessions, activeId, session.sessionId)
      const ledger = runtime?.latestTick?.ledger ?? null
      const fullHyp: Hypothesis | undefined = ledger?.hypotheses.find((h) => h.id === hyp.id)
      const evMap = new Map<string, EvidenceRecord>(
        (ledger?.evidence ?? []).map((item) => [item.id, item]),
      )
      const hypFindings: FindingDTO[] = (ledger?.findings ?? []).filter(
        (f) => f.hypothesisId === hyp.id,
      )

      const pct = Math.round(clamp01(fullHyp?.confidence ?? hyp.confidence) * 100)
      const toneClass = hypToneClass(hyp.status)
      const barColor = toneCssColor(toneClass)

      const supportingIds = dedupeStrings([
        ...(fullHyp?.supporting ?? []),
        ...session.edges
          .filter((e) => e.to === hyp.id && (e.kind === 'support' || e.kind === 'audit'))
          .map((e) => e.from),
      ])
      const contradictingIds = dedupeStrings([
        ...(fullHyp?.contradicting ?? []),
        ...session.edges
          .filter((e) => e.to === hyp.id && e.kind === 'contradict')
          .map((e) => e.from),
      ])
      const dependsOnIds = dedupeStrings([
        ...(fullHyp?.dependsOn ?? []),
        ...session.edges.filter((e) => e.to === hyp.id && e.kind === 'derive').map((e) => e.from),
      ])
      const derivedIds = dedupeStrings([
        ...(fullHyp?.derived ?? []),
        ...session.edges.filter((e) => e.from === hyp.id && e.kind === 'derive').map((e) => e.to),
      ])

      const experiments: HypothesisExperiment[] =
        fullHyp?.experiments && fullHyp.experiments.length > 0
          ? fullHyp.experiments
          : hyp.experiments.map((e) => ({
              id: e.id,
              title: e.title,
              command: '',
              status: e.status,
              evidenceId: e.evidenceId,
            }))

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
              +{supportingIds.length} 支持
            </span>
            <span
              className="thud-insp-pill"
              style={{ color: contradictingIds.length > 0 ? 'var(--err)' : 'var(--faint)' }}
            >
              -{contradictingIds.length} 反证
            </span>
            <span className="thud-insp-pill">实验 {experiments.length}</span>
            {dependsOnIds.length > 0 && (
              <span className="thud-insp-pill" style={{ color: 'var(--violet)' }}>
                依赖 {dependsOnIds.length}
              </span>
            )}
          </div>

          <div className="thud-insp-scroll">
            {/* Full untruncated claim */}
            <div className="thud-insp-block">
              <div className="thud-insp-label">假设声明 CLAIM</div>
              <p className="thud-insp-claim">{fullHyp?.claim || hyp.claim || '（无假设声明）'}</p>
            </div>

            {/* Structured re-agent §8.3 fields */}
            {fullHyp?.scope && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">适用范围 SCOPE</div>
                <div className="thud-insp-text">{fullHyp.scope}</div>
              </div>
            )}

            {fullHyp?.falsifiers && fullHyp.falsifiers.length > 0 && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">可证伪反例 FALSIFIERS</div>
                <ul className="thud-insp-list">
                  {fullHyp.falsifiers.map((f, idx) => (
                    <li key={idx}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {fullHyp?.nextTest && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">下一步实验 NEXT TEST</div>
                <div className="thud-insp-callout">{fullHyp.nextTest}</div>
              </div>
            )}

            {fullHyp?.note && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">仲裁备注 NOTE</div>
                <div className="thud-insp-text thud-insp-text--muted">{fullHyp.note}</div>
              </div>
            )}

            {/* Audit findings linked to this hypothesis */}
            {hypFindings.length > 0 && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">审计发现 FINDINGS ({hypFindings.length})</div>
                <div className="thud-insp-stack">
                  {hypFindings.map((f, idx) => (
                    <div key={idx} className="thud-insp-card thud-insp-card--warn">
                      <div className="thud-insp-card-head">
                        <span className="thud-insp-card-id">{f.rule}</span>
                        {f.evidenceId && (
                          <button
                            type="button"
                            className="thud-link-chip thud-link-chip--warn"
                            onClick={() => jumpNode(f.evidenceId!)}
                          >
                            {f.evidenceId}
                          </button>
                        )}
                      </div>
                      <div className="thud-insp-text">{f.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Interactive Provenance Links */}
            {(supportingIds.length > 0 ||
              contradictingIds.length > 0 ||
              dependsOnIds.length > 0 ||
              derivedIds.length > 0) && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">因果血缘 PROVENANCE（点击跳转 3D 节点）</div>
                <div className="thud-link-chips">
                  {supportingIds.map((evId) => (
                    <button
                      key={`sup-${evId}`}
                      type="button"
                      className="thud-link-chip thud-link-chip--ok"
                      title={evMap.get(evId)?.summary ?? evMap.get(evId)?.excerpt ?? evId}
                      onClick={() => jumpNode(evId)}
                    >
                      +{evId}
                    </button>
                  ))}
                  {contradictingIds.map((evId) => (
                    <button
                      key={`con-${evId}`}
                      type="button"
                      className="thud-link-chip thud-link-chip--err"
                      title={evMap.get(evId)?.summary ?? evMap.get(evId)?.excerpt ?? evId}
                      onClick={() => jumpNode(evId)}
                    >
                      -{evId}
                    </button>
                  ))}
                  {dependsOnIds.map((hId) => (
                    <button
                      key={`dep-${hId}`}
                      type="button"
                      className="thud-link-chip thud-link-chip--violet"
                      onClick={() => jumpNode(hId)}
                    >
                      ↳ {hId}
                    </button>
                  ))}
                  {derivedIds.map((hId) => (
                    <button
                      key={`der-${hId}`}
                      type="button"
                      className="thud-link-chip thud-link-chip--violet"
                      onClick={() => jumpNode(hId)}
                    >
                      → {hId}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Experiments */}
            {experiments.length > 0 && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">实验记录 EXPERIMENTS ({experiments.length})</div>
                <div className="thud-insp-stack">
                  {experiments.map((exp) => {
                    const expTone =
                      exp.status === 'passed'
                        ? 'ok'
                        : exp.status === 'falsified' || exp.status === 'error'
                          ? 'err'
                          : 'accent'
                    return (
                      <div key={exp.id} className={`thud-insp-card thud-insp-card--${expTone}`}>
                        <div className="thud-insp-card-head">
                          <span className="thud-insp-card-id">{exp.id}</span>
                          <span className={`thud-insp-badge thud-insp-badge--${expTone}`}>
                            {exp.status.toUpperCase()}
                          </span>
                          {exp.evidenceId && (
                            <button
                              type="button"
                              className="thud-link-chip thud-link-chip--accent"
                              onClick={() => jumpNode(exp.evidenceId!)}
                            >
                              {exp.evidenceId}
                            </button>
                          )}
                        </div>
                        {exp.title && <div className="thud-insp-card-title">{exp.title}</div>}
                        {exp.command && <code className="thud-insp-cmd">$ {exp.command}</code>}
                        {exp.actual ? (
                          <pre className="thud-insp-mini-out">{exp.actual}</pre>
                        ) : exp.expected ? (
                          <div className="thud-insp-text thud-insp-text--muted">
                            预期：{exp.expected}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

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
              data-hint="打开该假设的实验配置向导（也可双击 3D 棱柱或标签）"
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
      const runtime = resolveRuntime(runtimeSessions, activeId, session.sessionId)
      const ledger = runtime?.latestTick?.ledger ?? null
      const fullEv: EvidenceRecord | undefined = ledger?.evidence.find((item) => item.id === ev.id)

      const isErr = Boolean(ev.isError || fullEv?.isError)
      const ver = fullEv?.verification ?? null
      const isVerified =
        Boolean(ev.verified) ||
        ver?.status === 'verified' ||
        (ver != null && ver.total > 0 && ver.passed >= ver.total)
      const isCandidate = !isErr && !isVerified && (ver?.status === 'candidate' || ver != null)

      const toneClass = isErr ? 'err' : isVerified ? 'ok' : isCandidate ? 'warn' : 'accent'
      const badgeLabel = isErr
        ? '✗ ERROR'
        : isVerified
          ? '✓ VERIFIED'
          : isCandidate
            ? 'CANDIDATE'
            : 'RECORDED'

      // Linked hypotheses (supports / contradicts / audit)
      const supportHyps = dedupeStrings([
        ...(fullEv?.supports ?? []),
        ...(ledger?.hypotheses ?? [])
          .filter((h) => (h.supporting ?? []).includes(ev.id))
          .map((h) => h.id),
        ...session.edges
          .filter((e) => e.from === ev.id && (e.kind === 'support' || e.kind === 'audit'))
          .map((e) => e.to),
      ])
      const contradictHyps = dedupeStrings([
        ...(fullEv?.contradicts ?? []),
        ...(ledger?.hypotheses ?? [])
          .filter((h) => (h.contradicting ?? []).includes(ev.id))
          .map((h) => h.id),
        ...session.edges
          .filter((e) => e.from === ev.id && e.kind === 'contradict')
          .map((e) => e.to),
      ])

      const rawExcerpt = fullEv?.excerpt ?? ''
      const summaryText = fullEv?.summary || ev.summary || ''

      return (
        <aside
          className={`thud-glass thud-inspector thud-inspector--${toneClass}`}
          aria-label="Evidence inspector"
        >
          <div className="thud-insp-head">
            <div className="thud-insp-title-wrap">
              <span className="thud-insp-code" style={{ color: toneCssColor(toneClass) }}>
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
            {fullEv?.source && <span className="thud-insp-pill">SRC: {fullEv.source}</span>}
            <span className="thud-insp-pill">KIND: {fullEv?.kind ?? ev.kind}</span>
            {fullEv?.view && <span className="thud-insp-pill">VIEW: {fullEv.view.toUpperCase()}</span>}
            {fullEv?.untrustedInput && (
              <span className="thud-insp-badge thud-insp-badge--warn">⚠ UNTRUSTED DATA</span>
            )}
            {ver && (
              <span
                className={`thud-insp-badge ${
                  ver.passed >= ver.total && ver.total > 0
                    ? 'thud-insp-badge--ok'
                    : 'thud-insp-badge--warn'
                }`}
              >
                {ver.passed}/{ver.total} passed{ver.build ? ' · build ✓' : ''}
              </span>
            )}
            {fullEv?.bytes != null && (
              <span className="thud-insp-pill">{formatBytes(fullEv.bytes)}</span>
            )}
          </div>

          <div className="thud-insp-scroll">
            {summaryText && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">证据摘要 SUMMARY</div>
                <p className="thud-insp-claim">{summaryText}</p>
              </div>
            )}

            {/* Artifact & copyable SHA-256 */}
            {(fullEv?.artifact || fullEv?.sha256) && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">产物与校验 ARTIFACT &amp; SHA-256</div>
                <div className="thud-insp-kv">
                  {fullEv.artifact && (
                    <div className="thud-insp-kv-row">
                      <span className="thud-insp-kv-key">ARTIFACT</span>
                      <code className="thud-insp-kv-val">{fullEv.artifact}</code>
                    </div>
                  )}
                  {fullEv.sha256 && (
                    <div className="thud-insp-kv-row">
                      <span className="thud-insp-kv-key">SHA256</span>
                      <code className="thud-insp-kv-val" title={fullEv.sha256}>
                        {shortHash(fullEv.sha256)}
                      </code>
                      <button
                        type="button"
                        className="thud-mini-copy"
                        onClick={() => copy(`sha-${ev.id}`, fullEv.sha256!)}
                      >
                        {copiedKey === `sha-${ev.id}` ? '✓ 已复制' : '复制'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Scrollable raw excerpt with 1-click copy */}
            {rawExcerpt && (
              <div className="thud-insp-block">
                <div className="thud-insp-label-row">
                  <span className="thud-insp-label">原始摘录 RAW EXCERPT</span>
                  <button
                    type="button"
                    className="thud-mini-copy"
                    onClick={() => copy(`excerpt-${ev.id}`, rawExcerpt)}
                  >
                    {copiedKey === `excerpt-${ev.id}` ? '✓ 已复制' : '复制'}
                  </button>
                </div>
                <pre className="thud-insp-codeblock">{rawExcerpt}</pre>
              </div>
            )}

            {/* Interactive Linked Hypotheses */}
            {(supportHyps.length > 0 || contradictHyps.length > 0) && (
              <div className="thud-insp-block">
                <div className="thud-insp-label">关联假设 LINKED HYPOTHESES（点击跳转）</div>
                <div className="thud-link-chips">
                  {supportHyps.map((hId) => (
                    <button
                      key={`sup-${hId}`}
                      type="button"
                      className="thud-link-chip thud-link-chip--ok"
                      onClick={() => jumpNode(hId)}
                    >
                      + {hId}
                    </button>
                  ))}
                  {contradictHyps.map((hId) => (
                    <button
                      key={`con-${hId}`}
                      type="button"
                      className="thud-link-chip thud-link-chip--err"
                      onClick={() => jumpNode(hId)}
                    >
                      - {hId}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

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

// ---------- Zone Contextual Live Data Panel ----------

function ZoneContextualContent({
  zoneKey,
  primary,
  runtime,
  ledger,
  copiedKey,
  onCopy,
  onJumpNode,
}: {
  zoneKey: ZoneKey
  primary: SessionScene | null
  runtime: SessionRuntime | null
  ledger: LedgerDTO | null
  copiedKey: string | null
  onCopy: (key: string, text: string) => void
  onJumpNode: (nodeId: string) => void
}) {
  const goal: GoalSummaryDTO | null = ledger?.goal ?? null
  const sandbox: SandboxDTO | null = ledger?.sandbox ?? null
  const evidenceList = ledger?.evidence ?? []
  const sceneEvs = primary?.evs ?? []

  if (zoneKey === 'TRI') {
    const sampleType = runtime?.latestTick?.re?.sampleType
    const targetFile = goal?.targetFile
    const targetSha = goal?.targetSha256
    const archFormat = [goal?.targetFormat, goal?.targetArch, goal?.targetVersion]
      .filter(Boolean)
      .join(' · ')
    return (
      <>
        <div className="thud-insp-block">
          <div className="thud-insp-label">目标样本 TARGET</div>
          <div className="thud-insp-kv">
            {targetFile && (
              <div className="thud-insp-kv-row">
                <span className="thud-insp-kv-key">FILE</span>
                <code className="thud-insp-kv-val">{targetFile}</code>
              </div>
            )}
            {(archFormat || sampleType) && (
              <div className="thud-insp-kv-row">
                <span className="thud-insp-kv-key">FORMAT</span>
                <span className="thud-insp-kv-val">{archFormat || sampleType}</span>
              </div>
            )}
            {targetSha && (
              <div className="thud-insp-kv-row">
                <span className="thud-insp-kv-key">SHA256</span>
                <code className="thud-insp-kv-val" title={targetSha}>
                  {shortHash(targetSha)}
                </code>
                <button
                  type="button"
                  className="thud-mini-copy"
                  onClick={() => onCopy('tri-sha', targetSha)}
                >
                  {copiedKey === 'tri-sha' ? '✓ 已复制' : '复制'}
                </button>
              </div>
            )}
            {runtime?.info.workspace && (
              <div className="thud-insp-kv-row">
                <span className="thud-insp-kv-key">DIR</span>
                <code className="thud-insp-kv-val">{runtime.info.workspace}</code>
              </div>
            )}
          </div>
        </div>
        {goal?.primary && (
          <div className="thud-insp-block">
            <div className="thud-insp-label">核心目标 OBJECTIVE</div>
            <p className="thud-insp-claim">{goal.primary}</p>
          </div>
        )}
        {goal?.criteria && goal.criteria.length > 0 && (
          <div className="thud-insp-block">
            <div className="thud-insp-label">验收判据 CRITERIA</div>
            <div className="thud-insp-stack">
              {goal.criteria.map((c, idx) => (
                <div key={idx} className="thud-insp-check-row">
                  <span style={{ color: c.pass ? 'var(--ok)' : 'var(--faint)', fontWeight: 700 }}>
                    {c.pass ? '✓' : '○'}
                  </span>
                  <span>{c.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    )
  }

  if (zoneKey === 'SCR') {
    const staticEvs = sceneEvs.filter((ev) => {
      const full = evidenceList.find((x) => x.id === ev.id)
      const view = (full?.view ?? '').toLowerCase()
      return view === 'static' || (!view && classifyEvidenceShape(ev.kind) === 'static')
    })
    return (
      <ZoneEvidenceList
        title={`静态勘查证据 STATIC (${staticEvs.length})`}
        emptyText="尚未采集静态分析证据"
        evs={staticEvs}
        fullEvidence={evidenceList}
        onJumpNode={onJumpNode}
      />
    )
  }

  if (zoneKey === 'HYP') {
    const hyps = primary?.hyps ?? []
    return (
      <div className="thud-insp-block">
        <div className="thud-insp-label">假设塔清单 HYPOTHESES ({hyps.length})</div>
        {hyps.length === 0 ? (
          <div className="thud-exp-empty">尚未建立逆向假设</div>
        ) : (
          <div className="thud-insp-stack">
            {hyps.map((h) => {
              const tone = hypToneClass(h.status)
              const pct = Math.round(clamp01(h.confidence) * 100)
              return (
                <button
                  key={h.id}
                  type="button"
                  className="thud-zone-item"
                  onClick={() => onJumpNode(h.id)}
                >
                  <div className="thud-zone-item-head">
                    <span className="thud-insp-card-id" style={{ color: toneCssColor(tone) }}>
                      {h.id}
                    </span>
                    <span className={`thud-insp-badge thud-insp-badge--${tone}`}>{h.status}</span>
                    <span className="thud-exp-meta">{pct}%</span>
                  </div>
                  <div className="thud-zone-item-sub">{truncateTelemetry(h.claim || '（无声明）', 68)}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  if (zoneKey === 'EXP') {
    const dynEvs = sceneEvs.filter((ev) => {
      const full = evidenceList.find((x) => x.id === ev.id)
      const view = (full?.view ?? '').toLowerCase()
      return view === 'dynamic' || (!view && classifyEvidenceShape(ev.kind) === 'dynamic')
    })
    const networkGranted = sandbox?.granted.some((g) => g.toLowerCase().includes('net')) ?? false
    const networkConstraint = goal?.constraints?.network ?? (networkGranted ? 'allow' : 'deny')

    return (
      <>
        <div className="thud-insp-block">
          <div className="thud-insp-label">能力沙箱 SANDBOX</div>
          <div className="thud-insp-metrics">
            <span
              className={`thud-insp-badge ${
                sandbox?.active ? 'thud-insp-badge--ok' : 'thud-insp-badge--accent'
              }`}
            >
              {sandbox?.active ? '● SANDBOX ACTIVE' : 'STANDBY'}
            </span>
            <span
              className={`thud-insp-badge ${
                networkConstraint === 'deny' ? 'thud-insp-badge--warn' : 'thud-insp-badge--ok'
              }`}
            >
              network={networkConstraint}
            </span>
            {sandbox && (
              <>
                <span className="thud-insp-pill" style={{ color: 'var(--ok)' }}>
                  ✓ {sandbox.grantedCount} granted
                </span>
                <span
                  className="thud-insp-pill"
                  style={{ color: sandbox.deniedCount > 0 ? 'var(--err)' : 'var(--faint)' }}
                >
                  ✗ {sandbox.deniedCount} denied
                </span>
              </>
            )}
          </div>
          {sandbox?.granted && sandbox.granted.length > 0 && (
            <div className="thud-insp-text thud-insp-text--muted" style={{ marginTop: 4 }}>
              授权能力：{sandbox.granted.join(', ')}
            </div>
          )}
        </div>

        {sandbox?.recentActions && sandbox.recentActions.length > 0 && (
          <div className="thud-insp-block">
            <div className="thud-insp-label">
              近期沙箱动作 RECENT ACTIONS ({sandbox.recentActions.length})
            </div>
            <div className="thud-insp-stack">
              {sandbox.recentActions.slice(-6).reverse().map((act, idx) => {
                const decTone =
                  act.decision === 'granted' ? 'ok' : act.decision === 'denied' ? 'err' : 'warn'
                return (
                  <div key={idx} className={`thud-insp-card thud-insp-card--${decTone}`}>
                    <div className="thud-insp-card-head">
                      <span className="thud-insp-card-id">{act.tool}</span>
                      <span className={`thud-insp-badge thud-insp-badge--${decTone}`}>
                        {act.decision.toUpperCase()}
                      </span>
                      {act.hypothesisId && (
                        <button
                          type="button"
                          className="thud-link-chip thud-link-chip--accent"
                          onClick={() => onJumpNode(act.hypothesisId!)}
                        >
                          {act.hypothesisId}
                        </button>
                      )}
                    </div>
                    <div className="thud-insp-text thud-insp-text--muted">
                      {truncateTelemetry(act.subject, 64)}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {dynEvs.length > 0 && (
          <ZoneEvidenceList
            title={`动态实验证据 DYNAMIC (${dynEvs.length})`}
            emptyText=""
            evs={dynEvs}
            fullEvidence={evidenceList}
            onJumpNode={onJumpNode}
          />
        )}
      </>
    )
  }

  if (zoneKey === 'VER') {
    const verEvs = sceneEvs.filter((ev) => {
      const full = evidenceList.find((x) => x.id === ev.id)
      const view = (full?.view ?? '').toLowerCase()
      return (
        view === 'verification' ||
        full?.verification != null ||
        classifyEvidenceShape(ev.kind) === 'verification'
      )
    })
    return (
      <ZoneEvidenceList
        title={`验证台记录 VERIFICATION (${verEvs.length})`}
        emptyText="尚未运行确定性重放验证"
        evs={verEvs}
        fullEvidence={evidenceList}
        onJumpNode={onJumpNode}
      />
    )
  }

  if (zoneKey === 'AUD') {
    const verdict = verdictMeta(ledger?.auditVerdict)
    const checks = ledger?.auditChecks ?? []
    const findings = ledger?.findings ?? []
    const auditEvs = sceneEvs.filter((ev) => {
      const full = evidenceList.find((x) => x.id === ev.id)
      const view = (full?.view ?? '').toLowerCase()
      return view === 'audit' || classifyEvidenceShape(ev.kind) === 'audit'
    })
    return (
      <>
        <div className="thud-insp-block">
          <div className="thud-insp-label">审计裁决 VERDICT</div>
          <div className="thud-insp-metrics">
            <span className={`thud-insp-badge thud-insp-badge--${verdict.tone}`}>
              {verdict.label}
            </span>
            {ledger?.auditorProvider && (
              <span className="thud-insp-pill">AUDITOR: {ledger.auditorProvider}</span>
            )}
          </div>
        </div>

        {checks.length > 0 && (
          <div className="thud-insp-block">
            <div className="thud-insp-label">审计清单 CHECKLIST ({checks.length})</div>
            <div className="thud-insp-stack">
              {checks.map((chk) => (
                <div key={chk.id} className="thud-insp-check-row">
                  <span style={{ color: chk.pass ? 'var(--ok)' : 'var(--err)', fontWeight: 700 }}>
                    {chk.pass ? '✓' : '✗'}
                  </span>
                  <span>{chk.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {findings.length > 0 && (
          <div className="thud-insp-block">
            <div className="thud-insp-label">对抗发现 FINDINGS ({findings.length})</div>
            <div className="thud-insp-stack">
              {findings.map((f, idx) => (
                <div key={idx} className="thud-insp-card thud-insp-card--warn">
                  <div className="thud-insp-card-head">
                    <span className="thud-insp-card-id">{f.rule}</span>
                    {f.hypothesisId && (
                      <button
                        type="button"
                        className="thud-link-chip thud-link-chip--accent"
                        onClick={() => onJumpNode(f.hypothesisId)}
                      >
                        {f.hypothesisId}
                      </button>
                    )}
                    {f.evidenceId && (
                      <button
                        type="button"
                        className="thud-link-chip thud-link-chip--warn"
                        onClick={() => onJumpNode(f.evidenceId!)}
                      >
                        {f.evidenceId}
                      </button>
                    )}
                  </div>
                  <div className="thud-insp-text">{f.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <ZoneEvidenceList
          title={`审计证据 AUDIT (${auditEvs.length})`}
          emptyText="尚无独立审计证据入账"
          evs={auditEvs}
          fullEvidence={evidenceList}
          onJumpNode={onJumpNode}
        />
      </>
    )
  }

  // DEL — Audit verdict + Writeup summary
  const verdict = verdictMeta(ledger?.auditVerdict)
  const writeup = extractWriteupSummary(runtime, ledger)
  return (
    <>
      <div className="thud-insp-block">
        <div className="thud-insp-label">交付状态 DELIVERY &amp; VERDICT</div>
        <div className="thud-insp-metrics">
          <span className={`thud-insp-badge thud-insp-badge--${verdict.tone}`}>{verdict.label}</span>
          {goal && (
            <span
              className={`thud-insp-badge ${
                goal.accepted ? 'thud-insp-badge--ok' : 'thud-insp-badge--warn'
              }`}
            >
              {goal.accepted ? '✓ GOAL ACCEPTED' : 'IN PROGRESS'}
            </span>
          )}
        </div>
        {goal?.deliverables && goal.deliverables.length > 0 && (
          <ul className="thud-insp-list" style={{ marginTop: 4 }}>
            {goal.deliverables.map((d, idx) => (
              <li key={idx}>{d}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="thud-insp-block">
        <div className="thud-insp-label">WRITEUP 摘要</div>
        {writeup ? (
          <pre className="thud-insp-codeblock thud-insp-codeblock--wrap">{writeup}</pre>
        ) : (
          <div className="thud-exp-empty">等待生成最终取证 Writeup 报告</div>
        )}
      </div>
    </>
  )
}

function ZoneEvidenceList({
  title,
  emptyText,
  evs,
  fullEvidence,
  onJumpNode,
}: {
  title: string
  emptyText: string
  evs: readonly EvNode[]
  fullEvidence: readonly EvidenceRecord[]
  onJumpNode: (nodeId: string) => void
}) {
  const fullById = new Map(fullEvidence.map((item) => [item.id, item]))
  return (
    <div className="thud-insp-block">
      <div className="thud-insp-label">{title}</div>
      {evs.length === 0 ? (
        emptyText ? <div className="thud-exp-empty">{emptyText}</div> : null
      ) : (
        <div className="thud-insp-stack">
          {evs.map((ev) => {
            const full = fullById.get(ev.id)
            const ver = full?.verification
            const tone: 'err' | 'ok' | 'warn' | 'accent' = ev.isError
              ? 'err'
              : ev.verified
                ? 'ok'
                : classifyEvidenceShape(ev.kind) === 'audit'
                  ? 'warn'
                  : 'accent'
            return (
              <button
                key={ev.id}
                type="button"
                className="thud-zone-item"
                onClick={() => onJumpNode(ev.id)}
              >
                <div className="thud-zone-item-head">
                  <span className="thud-insp-card-id" style={{ color: toneCssColor(tone) }}>
                    {ev.id}
                  </span>
                  <span className="thud-exp-tag">{full?.source ?? evidenceKindTag(ev.kind)}</span>
                  {ver && (
                    <span className={`thud-insp-badge thud-insp-badge--${ver.passed >= ver.total && ver.total > 0 ? 'ok' : 'warn'}`}>
                      {ver.passed}/{ver.total}
                    </span>
                  )}
                  {full?.untrustedInput && (
                    <span className="thud-insp-badge thud-insp-badge--warn">UNTRUSTED</span>
                  )}
                </div>
                <div className="thud-zone-item-sub">
                  {truncateTelemetry(full?.summary || ev.summary || ev.kind, 72)}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- 3D Scene Root & Bridges ----------

function SceneRoot({
  materials,
  scene,
  focus,
  hud,
  showGrid,
  showHoloPanels,
  showLabels,
  ecoMode,
  telemetryRef,
  onExitToClassic,
}: {
  materials: TheaterMaterials
  scene: SceneState
  focus: FocusTarget
  hud: HoloHudData | null
  showGrid: boolean
  showHoloPanels: boolean
  showLabels: boolean
  ecoMode: boolean
  telemetryRef: React.RefObject<HTMLSpanElement | null>
  onExitToClassic?: () => void
}) {
  const primary = scene.sessions[0] ?? null
  let activeZone: ZoneKey | null = null
  if (primary && !primary.rail.archived) {
    const i = primary.rail.activeIndex
    if (i >= 0 && i < PHASE_ZONE.length) activeZone = PHASE_ZONE[i]
  }
  const focusedZone: ZoneKey | null = focus.kind === 'zone' ? focus.zone : null

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
      <StageEnvironment materials={materials} showGrid={showGrid} ecoMode={ecoMode} />
      <CameraRig telemetryRef={telemetryRef} />
      <PointerDownProbe />
      <TheaterDebugBridge />
      {scene.empty ? (
        <ZoneMarker
          zone={zoneOf('TRI')}
          materials={materials}
          focused={focusedZone === 'TRI'}
          breathing
        />
      ) : (
        <>
          {ZONES.map((z) => (
            <ZoneMarker
              key={z.key}
              zone={z}
              materials={materials}
              active={activeZone === z.key}
              focused={focusedZone === z.key}
            />
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
