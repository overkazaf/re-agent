// BinaryTerrainPanel — Route B: Reverse-engineer spatial visualization.
// Combines two genuinely actionable forensic views:
//   1) ▤ 二进制地形图 (Binary Forensic Terrain): pure-Go ELF/PE/Mach-O sections,
//      RWX & constructor markers, Shannon entropy profile (7.2 b/B threshold),
//      carved container hits, anti-analysis/packer hotspots, and binary patch
//      diff hunks — every click opens an exact offset inspector with 1-click
//      /hex, /anti, Agent prompt, and Hypothesis Wizard handoff.
//   2) ⇄ 动静证据对齐 (Static vs Dynamic Cross-Check): splits session evidence
//      into static vs dynamic/verification rails and flags single-view claims
//      and arbitrator contradictions with 1-click experiment/revise actions.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api'
import { useStageFullscreen } from '../../lib/fullscreen'
import type {
  BinaryTerrainDTO,
  EvidenceRecord,
  FindingDTO,
  Hypothesis,
  LedgerDTO,
  TerrainAntiDTO,
  TerrainBucketDTO,
  TerrainCarveDTO,
  TerrainDiffDTO,
  TerrainSectionDTO,
  WorkspaceFileDTO,
} from '../../lib/types'
import { actions } from '../../store/sessions'
import { sceneActions } from '../../store/scene'
import { PanelBox, ProSelect, type ProSelectOption } from '../crt'
import type { LedgerTab } from './LedgerPanel'
import {
  buildProvenanceChain,
  classifyEntropy,
  evaluateMitigationPosture,
  formatHypothesisCitation,
  resolveOffsetMapping,
  type AlignmentVerdict,
} from './forensics'
import { buildHypothesisArcs } from './cognitiveSynthesis'
import './re-pro.css'

export type TerrainSubTab = 'terrain' | 'alignment'

type SelectedItem =
  | { kind: 'section'; data: TerrainSectionDTO }
  | { kind: 'bucket'; data: TerrainBucketDTO }
  | { kind: 'carve'; data: TerrainCarveDTO }
  | { kind: 'anti'; data: TerrainAntiDTO }
  | { kind: 'diff'; data: TerrainDiffDTO }

function fmtHex(n: number): string {
  return `0x${Math.max(0, Math.floor(n)).toString(16).padStart(6, '0')}`
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function entropyColor(e: number): string {
  if (e >= 7.2) return 'var(--err)'
  if (e >= 6.4) return 'var(--warn)'
  if (e >= 4.0) return 'var(--accent)'
  return 'var(--muted)'
}

function sectionFill(sec: TerrainSectionDTO): string {
  if (sec.rwx) return 'rgba(248, 113, 113, 0.34)'
  if (sec.isConstructor) return 'rgba(251, 191, 36, 0.30)'
  if (sec.flags.includes('X')) return 'rgba(34, 211, 238, 0.25)'
  return 'rgba(148, 163, 184, 0.16)'
}

function sectionStroke(sec: TerrainSectionDTO): string {
  if (sec.rwx) return 'var(--err)'
  if (sec.isConstructor) return 'var(--warn)'
  if (sec.flags.includes('X')) return 'var(--accent)'
  return 'var(--faint)'
}

export function BinaryTerrainPanel({
  sessionId,
  ledger,
  onOpenLedger,
}: {
  sessionId: string | null
  ledger?: LedgerDTO | null
  onOpenLedger?: (tab: LedgerTab, highlightId?: string) => void
}) {
  const [subTab, setSubTab] = useState<TerrainSubTab>('terrain')
  const [files, setFiles] = useState<WorkspaceFileDTO[]>([])
  const [targetPath, setTargetPath] = useState('')
  const [comparePath, setComparePath] = useState('')
  const [terrain, setTerrain] = useState<BinaryTerrainDTO | null>(null)
  const [loading, setLoading] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [hoverOff, setHoverOff] = useState<number | null>(null)
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copyToken = useCallback((key: string, value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {})
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1400)
  }, [])

  // Load workspace files when session changes.
  useEffect(() => {
    if (!sessionId) {
      setFiles([])
      setTargetPath('')
      setTerrain(null)
      return
    }
    let cancelled = false
    api
      .listWorkspaceFiles(sessionId)
      .then((list) => {
        if (cancelled) return
        setFiles(list)
        if (list.length > 0) {
          setTargetPath((prev) => (prev && list.some((f) => f.path === prev) ? prev : list[0].path))
          // Auto-pair *_patched* when baseline is selected for immediate diff demo utility.
          setComparePath((prev) => {
            if (prev && list.some((f) => f.path === prev)) return prev
            const first = list[0].path
            const stem = first.replace(/\.[^.]+$/, '')
            const patched = list.find(
              (f) => f.path !== first && f.path.toLowerCase().includes('patched') && f.path.startsWith(stem),
            )
            return patched ? patched.path : ''
          })
        }
      })
      .catch((e) => {
        if (!cancelled) setErrMsg(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const loadTerrain = useCallback(async () => {
    if (!sessionId || !targetPath) return
    setLoading(true)
    setErrMsg('')
    try {
      const data = await api.analyzeBinaryTerrain(sessionId, targetPath, comparePath)
      setTerrain(data)
      setZoomRange(null)
      // Pre-select the highest-signal forensic item so the inspector is immediately useful.
      if (data.diffs.length > 0) setSelected({ kind: 'diff', data: data.diffs[0] })
      else if (data.anti.length > 0) setSelected({ kind: 'anti', data: data.anti[0] })
      else if (data.carves.length > 0) setSelected({ kind: 'carve', data: data.carves[0] })
      else if (data.sections.length > 0) setSelected({ kind: 'section', data: data.sections[0] })
      else if (data.entropy.length > 0) setSelected({ kind: 'bucket', data: data.entropy[0] })
      else setSelected(null)
    } catch (e) {
      setErrMsg(String(e))
      setTerrain(null)
    } finally {
      setLoading(false)
    }
  }, [sessionId, targetPath, comparePath])

  useEffect(() => {
    void loadTerrain()
  }, [loadTerrain])

  const viewStart = zoomRange ? zoomRange[0] : 0
  const viewEnd = zoomRange ? zoomRange[1] : Math.max(1, terrain?.sampled ?? terrain?.size ?? 1)
  const viewSpan = Math.max(1, viewEnd - viewStart)

  // SVG layout geometry
  const W = 920
  const PAD_L = 52
  const PAD_R = 16
  const PLOT_W = W - PAD_L - PAD_R
  const xOf = (off: number) => PAD_L + ((off - viewStart) / viewSpan) * PLOT_W

  const visibleBuckets = useMemo(() => {
    if (!terrain) return []
    return terrain.entropy.filter((b) => b.offset + b.size >= viewStart && b.offset <= viewEnd)
  }, [terrain, viewStart, viewEnd])

  const entropyPolyline = useMemo(() => {
    if (visibleBuckets.length === 0) return { line: '', area: '' }
    const TOP = 82
    const H = 104
    const pts = visibleBuckets.map((b) => {
      const cx = Math.max(PAD_L, Math.min(PAD_L + PLOT_W, xOf(b.offset + b.size / 2)))
      const cy = TOP + H - (Math.min(8, Math.max(0, b.entropy)) / 8) * H
      return `${cx.toFixed(1)},${cy.toFixed(1)}`
    })
    const firstX = pts[0].split(',')[0]
    const lastX = pts[pts.length - 1].split(',')[0]
    return {
      line: pts.join(' '),
      area: `${firstX},${TOP + H} ${pts.join(' ')} ${lastX},${TOP + H}`,
    }
  }, [visibleBuckets, viewStart, viewSpan])

  const hoverBucket = useMemo(() => {
    if (hoverOff === null || !terrain || terrain.entropy.length === 0) return null
    let best = terrain.entropy[0]
    let bestDist = Math.abs(best.offset - hoverOff)
    for (const b of terrain.entropy) {
      const d = Math.abs(b.offset + b.size / 2 - hoverOff)
      if (d < bestDist) {
        best = b
        bestDist = d
      }
    }
    return best
  }, [hoverOff, terrain])

  const highEntropyPeaks = useMemo(() => {
    if (!terrain) return []
    return terrain.entropy.filter((b) => b.entropy >= 7.2).slice(0, 6)
  }, [terrain])

  const selectedOffset = useMemo(() => {
    if (!selected) return 0
    return selected.data.offset
  }, [selected])

  const posture = useMemo(() => (terrain ? evaluateMitigationPosture(terrain) : null), [terrain])
  const offsetMap = useMemo(
    () => (terrain && selected ? resolveOffsetMapping(terrain, selectedOffset) : null),
    [terrain, selected, selectedOffset],
  )

  const selectedSummary = useMemo(() => {
    if (!selected || !terrain) return ''
    switch (selected.kind) {
      case 'section':
        return `${terrain.path} 区段 ${selected.data.name} (${fmtHex(selected.data.offset)}, flags=${selected.data.flags}, entropy=${selected.data.entropy.toFixed(2)})`
      case 'diff':
        return `${terrain.path} vs ${terrain.comparePath ?? ''} 补丁点 ${fmtHex(selected.data.offset)} (${selected.data.bytesA} → ${selected.data.bytesB}${selected.data.classification?.length ? ', ' + selected.data.classification.join('; ') : ''})`
      case 'anti':
        return `${terrain.path} 反分析特征 ${selected.data.description} @ ${fmtHex(selected.data.offset)}`
      case 'carve':
        return `${terrain.path} 内嵌载荷 ${selected.data.kind} @ ${fmtHex(selected.data.offset)} (${selected.data.signature})`
      case 'bucket':
        return `${terrain.path} 偏移 ${fmtHex(selected.data.offset)} (熵值 ${selected.data.entropy.toFixed(2)} b/B, 可打印率 ${Math.round(selected.data.printable * 100)}%)`
    }
  }, [selected, terrain])

  const runDirectCmd = (cmd: string) => {
    if (!sessionId) return
    void actions.sendCommand(sessionId, cmd)
  }

  const askAgentAboutSelection = () => {
    if (!sessionId || !terrain) return
    const desc = selectedSummary || `${terrain.path} 偏移 ${fmtHex(selectedOffset)}`
    void actions.sendPrompt(
      sessionId,
      `请深入分析 ${desc}：检查该偏移附近的指令/数据结构、验证加壳或补丁行为，并将客观结果记入证据账本与假设栈。`,
    )
  }

  const openHypothesisFromSelection = () => {
    if (!sessionId || !terrain) return
    sceneActions.openWizard({
      sessionId,
      stage: 'hypothesis',
      prefillClaim: selectedSummary
        ? `${selectedSummary} 对应关键校验/保护逻辑，需动态实测验证`
        : `${terrain.path} 高熵/异常区段包含核心算法或隐藏载荷`,
    })
  }

  const hypCount = ledger?.hypotheses.length ?? 0
  const evCount = ledger?.evidence.length ?? 0
  const findingCount = ledger?.findings?.length ?? 0
  const fs = useStageFullscreen()

  const targetOptions = useMemo<ProSelectOption[]>(() => {
    if (files.length === 0) {
      return [{ value: '', label: '（无工作区文件）' }]
    }
    return files.map((f) => ({
      value: f.path,
      label: f.path,
      badge: `${f.format} · ${fmtBytes(f.size)}`,
      keywords: `${f.path} ${f.format}`,
    }))
  }, [files])

  const compareOptions = useMemo<ProSelectOption[]>(
    () => [
      { value: '', label: '（无对比）', description: '单文件二进制地形分析' },
      ...files
        .filter((f) => f.path !== targetPath)
        .map((f) => ({
          value: f.path,
          label: `vs ${f.path}`,
          badge: `${f.format} · ${fmtBytes(f.size)}`,
          keywords: `${f.path} ${f.format}`,
        })),
    ],
    [files, targetPath],
  )

  const panelContent = (
    <div
      data-fullscreen-stage={fs.open ? 'terrain' : undefined}
      style={
        fs.open
          ? {
              position: 'fixed',
              inset: 0,
              width: '100vw',
              height: '100vh',
              zIndex: 38,
              background: 'var(--bg)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }
          : { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }
      }
    >
      <PanelBox
        title="BINARY FORENSIC RADAR · 二进制解剖与动静对齐"
        accent="accent"
        collapsible={false}
        badge={fs.open ? (fs.nativeActive ? 'OS FULLSCREEN' : '100% VIEWPORT') : undefined}
      >
      {/* Top sub-tabs */}
      <div style={headerRow}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button
            type="button"
            onClick={() => setSubTab('terrain')}
            style={subTab === 'terrain' ? tabActive : tabIdle}
          >
            ▤ 二进制地形图
          </button>
          <button
            type="button"
            onClick={() => setSubTab('alignment')}
            style={subTab === 'alignment' ? tabActive : tabIdle}
          >
            ⇄ 动静证据对齐 ({evCount} ev · {hypCount} H{findingCount > 0 ? ` · ${findingCount} 裁定` : ''})
          </button>
        </div>

        <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {subTab === 'terrain' && (
            <>
              <label style={selectLabel}>
                目标
                <ProSelect
                  ariaLabel="binary target"
                  size="sm"
                  value={targetPath}
                  options={targetOptions}
                  onChange={setTargetPath}
                  popoverMinWidth={260}
                  style={{ maxWidth: 230 }}
                />
              </label>
              <label style={selectLabel}>
                Diff 对比
                <ProSelect
                  ariaLabel="diff compare target"
                  size="sm"
                  value={comparePath}
                  options={compareOptions}
                  onChange={setComparePath}
                  popoverMinWidth={240}
                  align="right"
                  style={{ maxWidth: 210 }}
                />
              </label>
              {zoomRange && (
                <button type="button" onClick={() => setZoomRange(null)} style={chipBtn}>
                  ↺ 全景 1×
                </button>
              )}
              <button type="button" onClick={() => void loadTerrain()} disabled={loading} style={chipBtn}>
                {loading ? '扫描中…' : '↻ 重扫'}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={fs.toggle}
            title={fs.open ? '退出全屏 (Esc)' : '进入系统真全屏检视二进制地形与动静对齐'}
            style={fs.open ? { ...chipBtn, border: '1px solid var(--warn)', color: 'var(--warn)' } : { ...chipBtn, border: '1px solid var(--accent-dim)', color: 'var(--accent)' }}
          >
            {fs.open ? '✕ 退出全屏' : '⛶ 全屏放大'}
          </button>
        </div>
      </div>

      {subTab === 'terrain' ? (
        <div style={scrollBody}>
          {errMsg && <div style={errBanner}>✗ {errMsg}</div>}
          {!sessionId ? (
            <div style={emptyBox}>请先在左侧启动或选择一个逆向 Session，即可自动扫描工作区二进制。</div>
          ) : !terrain ? (
            <div style={emptyBox}>{loading ? '正在通过纯 Go 解析器构建区段/熵值/反调试/补丁地形…' : '工作区暂无可解析文件。'}</div>
          ) : (
            <>
              {/* Security Mitigation Posture & Forensic Telemetry Bar */}
              <div className="re-posture-bar re-mono-num" data-testid="mitigation-posture-bar">
                <span style={badgeAccent}>
                  {terrain.format}
                  {terrain.arch ? ` · ${terrain.arch}` : ''}
                </span>
                {posture && (
                  <span
                    className="re-posture-grade"
                    data-tone={posture.tone}
                    title={`Hardening Score ${posture.score}/100 · Entropy ${posture.entropyVerdict}`}
                  >
                    {posture.grade} {posture.score}
                  </span>
                )}
                <span style={metaItem}>{fmtBytes(terrain.size)}</span>
                {terrain.entryPoint && (
                  <button
                    type="button"
                    className="re-copy-chip"
                    data-copied={copiedKey === 'entry' ? '1' : undefined}
                    onClick={() => copyToken('entry', terrain.entryPoint!)}
                    title="点击复制入口虚拟地址 (Entry VA)"
                  >
                    <span className="re-copy-chip-k">EP</span>
                    {copiedKey === 'entry' ? '✓ COPIED' : terrain.entryPoint}
                  </button>
                )}
                <button
                  type="button"
                  className="re-copy-chip"
                  data-copied={copiedKey === 'sha256' ? '1' : undefined}
                  onClick={() => copyToken('sha256', terrain.sha256)}
                  title={`点击复制完整 SHA256: ${terrain.sha256}`}
                >
                  <span className="re-copy-chip-k">SHA256</span>
                  {copiedKey === 'sha256' ? '✓ COPIED' : `${terrain.sha256.slice(0, 12)}…`}
                </button>
                <span style={{ ...metaItem, color: entropyColor(terrain.maxEntropy) }}>
                  H avg {terrain.overallEntropy.toFixed(2)} / max {terrain.maxEntropy.toFixed(2)} b/B
                </span>
                {posture?.pills.map((pill) => (
                  <span
                    key={pill.key}
                    className="re-mit-pill"
                    data-status={pill.status}
                    title={`${pill.label}: ${pill.raw} — ${pill.detail}`}
                  >
                    <span>{pill.label}</span>
                    <b>{pill.value}</b>
                  </span>
                ))}
              </div>

              {/* Interactive 3-track Binary Forensic Terrain SVG */}
              <div style={svgWrap}>
                <svg
                  viewBox={`0 0 ${W} 252`}
                  style={{ width: '100%', height: 'auto', display: 'block', userSelect: 'none' }}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const svgX = ((e.clientX - rect.left) / rect.width) * W
                    if (svgX >= PAD_L && svgX <= PAD_L + PLOT_W) {
                      const ratio = (svgX - PAD_L) / PLOT_W
                      setHoverOff(Math.floor(viewStart + ratio * viewSpan))
                    } else {
                      setHoverOff(null)
                    }
                  }}
                  onMouseLeave={() => setHoverOff(null)}
                  onClick={(e) => {
                    if (hoverBucket) {
                      const target = e.target as Element
                      if (target.tagName === 'svg' || target.getAttribute('data-bg') === '1') {
                        setSelected({ kind: 'bucket', data: hoverBucket })
                      }
                    }
                  }}
                >
                  <rect data-bg="1" x={0} y={0} width={W} height={252} fill="rgba(4, 10, 18, 0.55)" rx={4} />

                  {/* Track 1: Sections & RWX Map */}
                  <text x={8} y={24} fill="var(--faint)" fontSize={10}>
                    区段
                  </text>
                  <text x={8} y={38} fill="var(--faint)" fontSize={9}>
                    SECTIONS
                  </text>
                  <rect
                    data-bg="1"
                    x={PAD_L}
                    y={12}
                    width={PLOT_W}
                    height={42}
                    fill="rgba(15,23,42,0.55)"
                    stroke="var(--rule)"
                    strokeWidth={0.8}
                    rx={3}
                  />
                  {terrain.sections
                    .filter((s) => s.offset + s.size >= viewStart && s.offset <= viewEnd)
                    .map((sec, idx) => {
                      const x1 = Math.max(PAD_L, xOf(sec.offset))
                      const x2 = Math.min(PAD_L + PLOT_W, xOf(sec.offset + sec.size))
                      const bw = Math.max(4, x2 - x1)
                      const isSel = selected?.kind === 'section' && selected.data.name === sec.name && selected.data.offset === sec.offset
                      return (
                        <g
                          key={`${sec.name}-${idx}`}
                          style={{ cursor: 'pointer' }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setSelected({ kind: 'section', data: sec })
                          }}
                          onDoubleClick={(ev) => {
                            ev.stopPropagation()
                            setZoomRange([sec.offset, Math.min(terrain.size, sec.offset + Math.max(256, sec.size))])
                          }}
                        >
                          <rect
                            x={x1}
                            y={15}
                            width={bw}
                            height={36}
                            fill={sectionFill(sec)}
                            stroke={isSel ? '#ffffff' : sectionStroke(sec)}
                            strokeWidth={isSel ? 1.8 : sec.rwx ? 1.4 : 1}
                            rx={2}
                          />
                          {bw >= 38 && (
                            <text
                              x={x1 + bw / 2}
                              y={31}
                              textAnchor="middle"
                              fill="var(--text)"
                              fontSize={9.5}
                              fontWeight={600}
                            >
                              {sec.name.length > 14 ? sec.name.slice(0, 13) + '…' : sec.name}
                            </text>
                          )}
                          {bw >= 44 && (
                            <text
                              x={x1 + bw / 2}
                              y={44}
                              textAnchor="middle"
                              fill={sec.rwx ? 'var(--err)' : 'var(--faint)'}
                              fontSize={8.5}
                            >
                              {sec.rwx ? 'RWX!' : sec.isConstructor ? 'CTOR' : sec.flags} · {sec.entropy.toFixed(1)}
                            </text>
                          )}
                        </g>
                      )
                    })}

                  {/* Track 2: Shannon Entropy Curve */}
                  <text x={8} y={96} fill="var(--faint)" fontSize={10}>
                    熵值
                  </text>
                  <text x={8} y={110} fill="var(--faint)" fontSize={9}>
                    0-8 b/B
                  </text>
                  <rect
                    data-bg="1"
                    x={PAD_L}
                    y={82}
                    width={PLOT_W}
                    height={104}
                    fill="rgba(15,23,42,0.5)"
                    stroke="var(--rule)"
                    strokeWidth={0.8}
                    rx={3}
                  />
                  {/* Horizontal gridlines: 7.2 packed threshold + 4.0 */}
                  <line
                    x1={PAD_L}
                    x2={PAD_L + PLOT_W}
                    y1={82 + 104 * (1 - 7.2 / 8)}
                    y2={82 + 104 * (1 - 7.2 / 8)}
                    stroke="var(--err)"
                    strokeWidth={0.9}
                    strokeDasharray="4 4"
                    opacity={0.75}
                  />
                  <text x={PAD_L + 4} y={82 + 104 * (1 - 7.2 / 8) - 3} fill="var(--err)" fontSize={8.5}>
                    7.2 加壳/加密警戒线
                  </text>
                  <line
                    x1={PAD_L}
                    x2={PAD_L + PLOT_W}
                    y1={82 + 52}
                    y2={82 + 52}
                    stroke="var(--rule)"
                    strokeWidth={0.6}
                    strokeDasharray="2 4"
                  />
                  {entropyPolyline.area && (
                    <polygon data-bg="1" points={entropyPolyline.area} fill="rgba(34, 211, 238, 0.14)" />
                  )}
                  {entropyPolyline.line && (
                    <polyline
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={1.6}
                      points={entropyPolyline.line}
                      pointerEvents="none"
                    />
                  )}
                  {/* Highlight high-entropy buckets (>=7.2) in crimson */}
                  {visibleBuckets
                    .filter((b) => b.entropy >= 7.2)
                    .map((b, idx) => {
                      const cx = Math.max(PAD_L, Math.min(PAD_L + PLOT_W, xOf(b.offset + b.size / 2)))
                      const cy = 82 + 104 - (Math.min(8, b.entropy) / 8) * 104
                      return (
                        <circle
                          key={`hi-${idx}`}
                          cx={cx}
                          cy={cy}
                          r={3.2}
                          fill="var(--err)"
                          style={{ cursor: 'pointer' }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setSelected({ kind: 'bucket', data: b })
                          }}
                        />
                      )
                    })}

                  {/* Track 3: Forensic Hotspots (Carve / Anti-Analysis / Diff Patches) */}
                  <text x={8} y={214} fill="var(--faint)" fontSize={10}>
                    热点
                  </text>
                  <text x={8} y={226} fill="var(--faint)" fontSize={8.5}>
                    MARKERS
                  </text>
                  <rect
                    data-bg="1"
                    x={PAD_L}
                    y={196}
                    width={PLOT_W}
                    height={34}
                    fill="rgba(15,23,42,0.55)"
                    stroke="var(--rule)"
                    strokeWidth={0.8}
                    rx={3}
                  />
                  {/* Carve markers (violet diamonds) */}
                  {terrain.carves
                    .filter((c) => c.offset >= viewStart && c.offset <= viewEnd)
                    .map((c, idx) => {
                      const x = xOf(c.offset)
                      const isSel = selected?.kind === 'carve' && selected.data.offset === c.offset
                      return (
                        <g
                          key={`carve-${idx}`}
                          transform={`translate(${x}, 213)`}
                          style={{ cursor: 'pointer' }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setSelected({ kind: 'carve', data: c })
                          }}
                        >
                          <polygon
                            points="0,-6 6,0 0,6 -6,0"
                            fill="var(--violet)"
                            stroke={isSel ? '#fff' : 'none'}
                            strokeWidth={1.5}
                          />
                          <text y={15} textAnchor="middle" fill="var(--violet)" fontSize={8}>
                            {c.kind}
                          </text>
                        </g>
                      )
                    })}
                  {/* Anti-analysis markers (amber/crimson triangles) */}
                  {terrain.anti
                    .filter((a) => a.offset >= viewStart && a.offset <= viewEnd)
                    .map((a, idx) => {
                      const x = xOf(a.offset)
                      const isSel = selected?.kind === 'anti' && selected.data.description === a.description
                      const col = a.confidence === 'high' ? 'var(--err)' : 'var(--warn)'
                      return (
                        <g
                          key={`anti-${idx}`}
                          transform={`translate(${x}, 210)`}
                          style={{ cursor: 'pointer' }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setSelected({ kind: 'anti', data: a })
                          }}
                        >
                          <line x1={0} y1={-128} x2={0} y2={-6} stroke={col} strokeWidth={0.7} strokeDasharray="2 3" opacity={0.45} />
                          <polygon
                            points="0,-7 6,5 -6,5"
                            fill={col}
                            stroke={isSel ? '#fff' : 'none'}
                            strokeWidth={1.5}
                          />
                        </g>
                      )
                    })}
                  {/* Binary diff patch hunks (ok green glowing pins) */}
                  {terrain.diffs
                    .filter((d) => d.offset >= viewStart && d.offset <= viewEnd)
                    .map((d, idx) => {
                      const x = xOf(d.offset)
                      const isSel = selected?.kind === 'diff' && selected.data.offset === d.offset
                      return (
                        <g
                          key={`diff-${idx}`}
                          transform={`translate(${x}, 213)`}
                          style={{ cursor: 'pointer' }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setSelected({ kind: 'diff', data: d })
                          }}
                        >
                          <line x1={0} y1={-196} x2={0} y2={-6} stroke="var(--ok)" strokeWidth={1.2} opacity={0.7} />
                          <rect
                            x={-5}
                            y={-5}
                            width={10}
                            height={10}
                            fill="var(--ok)"
                            stroke={isSel ? '#fff' : '#041019'}
                            strokeWidth={1.4}
                            rx={2}
                          />
                        </g>
                      )
                    })}

                  {/* Selected offset vertical cursor */}
                  {selected && selectedOffset >= viewStart && selectedOffset <= viewEnd && (
                    <line
                      x1={xOf(selectedOffset)}
                      x2={xOf(selectedOffset)}
                      y1={12}
                      y2={230}
                      stroke="#ffffff"
                      strokeWidth={1}
                      strokeDasharray="3 2"
                      opacity={0.75}
                      pointerEvents="none"
                    />
                  )}

                  {/* Hover crosshair */}
                  {hoverOff !== null && hoverOff >= viewStart && hoverOff <= viewEnd && (
                    <g pointerEvents="none">
                      <line
                        x1={xOf(hoverOff)}
                        x2={xOf(hoverOff)}
                        y1={12}
                        y2={230}
                        stroke="var(--accent)"
                        strokeWidth={0.9}
                        opacity={0.65}
                      />
                      <text
                        x={Math.min(W - 180, Math.max(PAD_L + 4, xOf(hoverOff) + 6))}
                        y={74}
                        fill="var(--text)"
                        fontSize={9.5}
                      >
                        {fmtHex(hoverOff)}
                        {hoverBucket ? ` · ${hoverBucket.entropy.toFixed(2)} b/B` : ''}
                      </text>
                    </g>
                  )}

                  {/* Offset axis ticks */}
                  {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                    const off = Math.floor(viewStart + t * viewSpan)
                    const x = PAD_L + t * PLOT_W
                    return (
                      <text
                        key={t}
                        x={x}
                        y={246}
                        textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'}
                        fill="var(--faint)"
                        fontSize={9}
                      >
                        {fmtHex(off)}
                      </text>
                    )
                  })}
                </svg>

                {/* Legend */}
                <div style={legendRow}>
                  <span>
                    <span style={{ color: 'var(--accent)' }}>■</span> 可执行段 (.text)
                  </span>
                  <span>
                    <span style={{ color: 'var(--warn)' }}>■</span> 构造函数 (.init_array/ctor)
                  </span>
                  <span>
                    <span style={{ color: 'var(--err)' }}>■</span> RWX / 高熵 ≥7.2
                  </span>
                  <span>
                    <span style={{ color: 'var(--violet)' }}>◆</span> 雕刻载荷 ({terrain.carves.length})
                  </span>
                  <span>
                    <span style={{ color: 'var(--err)' }}>▲</span> 反分析 ({terrain.anti.length})
                  </span>
                  <span>
                    <span style={{ color: 'var(--ok)' }}>■</span> Patch 差分 ({terrain.diffs.length})
                  </span>
                  <span style={{ marginLeft: 'auto', color: 'var(--faint)' }}>
                    提示：点击任意区段/热点检视，双击区段放大
                  </span>
                </div>
              </div>

              {/* Quick jump hotspot chips */}
              {(terrain.diffs.length > 0 ||
                terrain.anti.length > 0 ||
                terrain.carves.length > 0 ||
                highEntropyPeaks.length > 0) && (
                <div style={hotspotBar}>
                  <span style={{ color: 'var(--faint)', fontSize: 10, letterSpacing: '0.08em' }}>快速跳转:</span>
                  {terrain.diffs.map((d, i) => (
                    <button
                      key={`jd-${i}`}
                      type="button"
                      onClick={() => setSelected({ kind: 'diff', data: d })}
                      style={{ ...jumpChip, borderColor: 'var(--ok)', color: 'var(--ok)' }}
                    >
                      ✦ PATCH #{i + 1} @ {fmtHex(d.offset)}
                    </button>
                  ))}
                  {terrain.anti.map((a, i) => (
                    <button
                      key={`ja-${i}`}
                      type="button"
                      onClick={() => setSelected({ kind: 'anti', data: a })}
                      style={{ ...jumpChip, borderColor: 'var(--err)', color: 'var(--err)' }}
                    >
                      ▲ {a.detail || a.category} @ {fmtHex(a.offset)}
                    </button>
                  ))}
                  {terrain.carves.map((c, i) => (
                    <button
                      key={`jc-${i}`}
                      type="button"
                      onClick={() => setSelected({ kind: 'carve', data: c })}
                      style={{ ...jumpChip, borderColor: 'var(--violet)', color: 'var(--violet)' }}
                    >
                      ◆ {c.kind} @ {fmtHex(c.offset)}
                    </button>
                  ))}
                  {highEntropyPeaks.slice(0, 3).map((b, i) => (
                    <button
                      key={`je-${i}`}
                      type="button"
                      onClick={() => setSelected({ kind: 'bucket', data: b })}
                      style={{ ...jumpChip, borderColor: 'var(--warn)', color: 'var(--warn)' }}
                    >
                      ● 高熵 {b.entropy.toFixed(2)} @ {fmtHex(b.offset)}
                    </button>
                  ))}
                </div>
              )}

              {/* Active Offset Inspector + 1-click RE Actions */}
              {selected && (
                <div style={inspectorCard}>
                  <div style={inspectorHead}>
                    <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 12 }}>
                      {selected.kind === 'diff' && `✦ BINARY PATCH @ ${fmtHex(selected.data.offset)} (${selected.data.length} B)`}
                      {selected.kind === 'anti' && `▲ ANTI-ANALYSIS [${selected.data.category}] @ ${fmtHex(selected.data.offset)}`}
                      {selected.kind === 'carve' && `◆ CARVED ${selected.data.kind} @ ${fmtHex(selected.data.offset)}`}
                      {selected.kind === 'section' && `▤ SECTION ${selected.data.name} @ ${fmtHex(selected.data.offset)} (${fmtBytes(selected.data.size)})`}
                      {selected.kind === 'bucket' && `● ENTROPY WINDOW @ ${fmtHex(selected.data.offset)} (${selected.data.entropy.toFixed(3)} b/B)`}
                    </span>
                    <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => runDirectCmd(`/hex ${terrain.path} ${fmtHex(selectedOffset)} 256`)}
                        style={actionBtn}
                      >
                        HEX 查看 (/hex)
                      </button>
                      <button
                        type="button"
                        onClick={() => runDirectCmd(`/anti ${terrain.path}`)}
                        style={actionBtn}
                      >
                        反调试扫描 (/anti)
                      </button>
                      <button type="button" onClick={openHypothesisFromSelection} style={actionBtnViolet}>
                        ✦ 带入假设向导 (H+)
                      </button>
                      <button type="button" onClick={askAgentAboutSelection} style={actionBtnPrimary}>
                        ▶ 让 Agent 分析该偏移
                      </button>
                    </div>
                  </div>

                  {/* One-click VA / File Offset / RVA / Citation copy bar */}
                  {offsetMap && (
                    <div
                      className="re-mono-num"
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 6,
                        paddingBottom: 6,
                        borderBottom: '1px dashed var(--rule)',
                      }}
                    >
                      <button
                        type="button"
                        className="re-copy-chip"
                        data-copied={copiedKey === 'off' ? '1' : undefined}
                        onClick={() => copyToken('off', offsetMap.fileOffsetHex)}
                        title="复制文件偏移 (File Offset)"
                      >
                        <span className="re-copy-chip-k">OFF</span>
                        {copiedKey === 'off' ? '✓ COPIED' : offsetMap.fileOffsetHex}
                      </button>
                      {offsetMap.vaddrHex && (
                        <button
                          type="button"
                          className="re-copy-chip"
                          data-copied={copiedKey === 'va' ? '1' : undefined}
                          onClick={() => copyToken('va', offsetMap.vaddrHex!)}
                          title="复制虚拟地址 (Virtual Address)"
                        >
                          <span className="re-copy-chip-k">VA</span>
                          {copiedKey === 'va' ? '✓ COPIED' : offsetMap.vaddrHex}
                        </button>
                      )}
                      {offsetMap.rvaHex && (
                        <button
                          type="button"
                          className="re-copy-chip"
                          data-copied={copiedKey === 'rva' ? '1' : undefined}
                          onClick={() => copyToken('rva', offsetMap.rvaHex!)}
                          title="复制相对虚拟地址 (RVA)"
                        >
                          <span className="re-copy-chip-k">RVA</span>
                          {copiedKey === 'rva' ? '✓ COPIED' : offsetMap.rvaHex}
                        </button>
                      )}
                      {offsetMap.section && (
                        <span style={{ color: 'var(--faint)', fontSize: 10 }}>
                          {offsetMap.section.name}
                          {offsetMap.sectionDeltaHex ? ` ${offsetMap.sectionDeltaHex}` : ''} · {offsetMap.section.flags}
                        </span>
                      )}
                      <button
                        type="button"
                        className="re-copy-chip"
                        data-copied={copiedKey === 'cite' ? '1' : undefined}
                        onClick={() => copyToken('cite', offsetMap.citation)}
                        style={{ marginLeft: 'auto' }}
                        title={`复制取证坐标引用: ${offsetMap.citation}`}
                      >
                        {copiedKey === 'cite' ? '✓ 已复制坐标' : '⎘ 复制取证坐标'}
                      </button>
                    </div>
                  )}

                  <div style={inspectorBody}>
                    {selected.kind === 'diff' && (
                      <>
                        <div>
                          <span style={dimLbl}>原字节 (A):</span>{' '}
                          <code style={{ color: 'var(--err)' }}>{selected.data.bytesA}</code>
                          {'   →   '}
                          <span style={dimLbl}>补丁字节 (B):</span>{' '}
                          <code style={{ color: 'var(--ok)' }}>{selected.data.bytesB}</code>
                        </div>
                        {selected.data.classification && selected.data.classification.length > 0 && (
                          <div style={{ color: 'var(--ok)', marginTop: 4 }}>
                            指令语义识别：{selected.data.classification.join(' · ')}
                          </div>
                        )}
                      </>
                    )}
                    {selected.kind === 'anti' && (
                      <>
                        <div style={{ color: 'var(--text)' }}>{selected.data.description}</div>
                        <div style={{ color: 'var(--muted)', marginTop: 2 }}>
                          命中特征：<code>{selected.data.detail}</code> · 置信度：{selected.data.confidence}
                        </div>
                        {selected.data.bypass && (
                          <div style={{ color: 'var(--ok)', marginTop: 4 }}>绕过建议：{selected.data.bypass}</div>
                        )}
                      </>
                    )}
                    {selected.kind === 'carve' && (
                      <div style={{ color: 'var(--text)' }}>
                        容器类型：<strong>{selected.data.kind}</strong> · 签名特征：<code>{selected.data.signature}</code>
                        （可使用 <code>/carve {terrain.path}</code> 提取落地）
                      </div>
                    )}
                    {selected.kind === 'section' && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                        <span>VAddr: <code>{selected.data.vaddr || '—'}</code></span>
                        <span>Flags: <code>{selected.data.flags}</code></span>
                        <span>Entropy: <strong style={{ color: entropyColor(selected.data.entropy) }}>{selected.data.entropy.toFixed(3)} b/B</strong></span>
                        {selected.data.rwx && <span style={{ color: 'var(--err)', fontWeight: 700 }}>⚠ RWX 可写可执行（疑似运行时脱壳桩）</span>}
                        {selected.data.isConstructor && <span style={{ color: 'var(--warn)' }}>★ Pre-main 构造函数表（早于 main/JNI_OnLoad 执行）</span>}
                        <button
                          type="button"
                          onClick={() =>
                            setZoomRange([
                              selected.data.offset,
                              Math.min(terrain.size, selected.data.offset + Math.max(256, selected.data.size)),
                            ])
                          }
                          style={chipBtn}
                        >
                          ⊕ 放大此区段
                        </button>
                      </div>
                    )}
                    {selected.kind === 'bucket' && (
                      <div>
                        <span>可打印字符占比: {Math.round(selected.data.printable * 100)}%</span>
                        {' · '}
                        <span>Hex: <code style={{ color: 'var(--accent)' }}>{selected.data.hexPreview}</code></span>
                        {' · '}
                        <span>ASCII: <code>{selected.data.asciiPreview}</code></span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Section / Entropy / Anti-Analysis Forensic Breakdown Grid */}
              <div className="re-forensic-grid">
                <div className="re-forensic-card">
                  <div className="re-forensic-card-title">
                    <span>▤ Section &amp; Entropy Matrix</span>
                    <span className="re-mono-num" style={{ color: 'var(--faint)', fontWeight: 400 }}>
                      {terrain.sections.length} sections
                    </span>
                  </div>
                  {terrain.sections.length === 0 ? (
                    <div style={{ color: 'var(--faint)', fontSize: 10.5 }}>无区段头（原始二进制流）</div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="re-sec-table">
                        <thead>
                          <tr>
                            <th>Section</th>
                            <th>VAddr</th>
                            <th>Offset</th>
                            <th>Size</th>
                            <th>Flags</th>
                            <th>Entropy</th>
                          </tr>
                        </thead>
                        <tbody>
                          {terrain.sections.map((sec, idx) => {
                            const isSel =
                              selected?.kind === 'section' &&
                              selected.data.name === sec.name &&
                              selected.data.offset === sec.offset
                            const entInfo = classifyEntropy(sec.entropy)
                            const pct = Math.min(100, Math.round((sec.entropy / 8) * 100))
                            return (
                              <tr
                                key={`${sec.name}-${idx}`}
                                className="re-sec-row"
                                data-selected={isSel ? '1' : undefined}
                                onClick={() => setSelected({ kind: 'section', data: sec })}
                                onDoubleClick={() =>
                                  setZoomRange([sec.offset, Math.min(terrain.size, sec.offset + Math.max(256, sec.size))])
                                }
                                title="单击检视 · 双击放大此区段"
                              >
                                <td style={{ color: sec.rwx ? 'var(--err)' : sec.isConstructor ? 'var(--warn)' : 'var(--text)', fontWeight: 600 }}>
                                  {sec.name}
                                </td>
                                <td style={{ color: 'var(--accent)' }}>{sec.vaddr || '—'}</td>
                                <td style={{ color: 'var(--muted)' }}>{fmtHex(sec.offset)}</td>
                                <td style={{ color: 'var(--muted)' }}>{fmtBytes(sec.size)}</td>
                                <td style={{ color: sec.rwx ? 'var(--err)' : 'var(--faint)' }}>
                                  {sec.rwx ? 'RWX!' : sec.isConstructor ? `${sec.flags}·CTOR` : sec.flags}
                                </td>
                                <td>
                                  <span className="re-entropy-meter">
                                    <span
                                      className="re-entropy-fill"
                                      style={{ width: `${pct}%`, background: `var(--${entInfo.tone})` }}
                                    />
                                  </span>
                                  <span style={{ color: `var(--${entInfo.tone})` }}>{sec.entropy.toFixed(2)}</span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="re-forensic-card">
                  <div className="re-forensic-card-title">
                    <span>▲ Anti-Analysis, Carve &amp; Patch Risk</span>
                    <span className="re-mono-num" style={{ color: 'var(--faint)', fontWeight: 400 }}>
                      {terrain.anti.length} anti · {terrain.carves.length} carve · {terrain.diffs.length} patch
                    </span>
                  </div>
                  {terrain.anti.length === 0 && terrain.carves.length === 0 && terrain.diffs.length === 0 ? (
                    <div style={{ color: 'var(--faint)', fontSize: 10.5 }}>
                      ○ 未检出显著反分析、内嵌容器或补丁差分特征
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {terrain.anti.map((a, i) => (
                        <button
                          key={`risk-anti-${i}`}
                          type="button"
                          onClick={() => setSelected({ kind: 'anti', data: a })}
                          style={{
                            textAlign: 'left',
                            background: 'color-mix(in srgb, var(--err) 6%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--err) 40%, var(--rule))',
                            padding: '4px 7px',
                            cursor: 'pointer',
                            font: 'inherit',
                            fontSize: 10.5,
                          }}
                        >
                          <div className="re-mono-num" style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                            <span style={{ color: a.confidence === 'high' ? 'var(--err)' : 'var(--warn)', fontWeight: 700 }}>
                              [{a.category.toUpperCase()}] {a.detail}
                            </span>
                            <span style={{ color: 'var(--faint)' }}>{fmtHex(a.offset)}</span>
                          </div>
                          <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 2 }}>{a.description}</div>
                        </button>
                      ))}
                      {terrain.carves.map((c, i) => (
                        <button
                          key={`risk-carve-${i}`}
                          type="button"
                          onClick={() => setSelected({ kind: 'carve', data: c })}
                          style={{
                            textAlign: 'left',
                            background: 'color-mix(in srgb, var(--violet) 6%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--violet) 40%, var(--rule))',
                            padding: '4px 7px',
                            cursor: 'pointer',
                            font: 'inherit',
                            fontSize: 10.5,
                          }}
                        >
                          <div className="re-mono-num" style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                            <span style={{ color: 'var(--violet)', fontWeight: 700 }}>[CARVE · {c.kind}]</span>
                            <span style={{ color: 'var(--faint)' }}>{fmtHex(c.offset)}</span>
                          </div>
                          <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 2 }}>{c.signature}</div>
                        </button>
                      ))}
                      {terrain.diffs.map((d, i) => (
                        <button
                          key={`risk-diff-${i}`}
                          type="button"
                          onClick={() => setSelected({ kind: 'diff', data: d })}
                          style={{
                            textAlign: 'left',
                            background: 'color-mix(in srgb, var(--ok) 6%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--ok) 45%, var(--rule))',
                            padding: '4px 7px',
                            cursor: 'pointer',
                            font: 'inherit',
                            fontSize: 10.5,
                          }}
                        >
                          <div className="re-mono-num" style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                            <span style={{ color: 'var(--ok)', fontWeight: 700 }}>
                              [PATCH #{i + 1}] {d.bytesA} → {d.bytesB}
                            </span>
                            <span style={{ color: 'var(--faint)' }}>{fmtHex(d.offset)} ({d.length}B)</span>
                          </div>
                          {d.classification && d.classification.length > 0 && (
                            <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 2 }}>
                              {d.classification.join(' · ')}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      ) : (
        <StaticDynamicAlignmentView
          sessionId={sessionId}
          ledger={ledger}
          onOpenLedger={onOpenLedger}
        />
      )}
      </PanelBox>
    </div>
  )

  return fs.open && typeof document !== 'undefined' ? createPortal(panelContent, document.body) : panelContent
}

// ---------- Tab 2: Static vs Dynamic Evidence Cross-Check ----------

function StaticDynamicAlignmentView({
  sessionId,
  ledger,
  onOpenLedger,
}: {
  sessionId: string | null
  ledger?: LedgerDTO | null
  onOpenLedger?: (tab: LedgerTab, highlightId?: string) => void
}) {
  const [verdictFilter, setVerdictFilter] = useState<'ALL' | AlignmentVerdict>('ALL')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const hyps: Hypothesis[] = ledger?.hypotheses ?? []
  const evs: EvidenceRecord[] = ledger?.evidence ?? []
  const findings: FindingDTO[] = ledger?.findings ?? []

  const evMap = useMemo(() => new Map(evs.map((e) => [e.id, e])), [evs])
  const staticEvs = useMemo(
    () => evs.filter((e) => e.view === 'static' || (!e.view && e.kind === 'tool_observation')),
    [evs],
  )
  const dynamicEvs = useMemo(
    () =>
      evs.filter(
        (e) =>
          e.view === 'dynamic' ||
          e.kind === 'runtime_trace' ||
          e.kind === 'verification_result' ||
          e.kind === 'audit_finding',
      ),
    [evs],
  )

  const chains = useMemo(
    () => hyps.map((h) => ({ hyp: h, chain: buildProvenanceChain(h, evs, findings) })),
    [hyps, evs, findings],
  )

  const arcsById = useMemo(
    () =>
      new Map(
        buildHypothesisArcs(evs, hyps, findings, ledger?.auditorProvider).map((arc) => [arc.id, arc]),
      ),
    [evs, hyps, findings, ledger?.auditorProvider],
  )

  const counts = useMemo(() => {
    const tally: Record<AlignmentVerdict, number> = {
      VERIFIED: 0,
      DIVERGED: 0,
      UNCOVERED: 0,
      ANTI_ANALYSIS: 0,
    }
    for (const item of chains) tally[item.chain.verdict] += 1
    return tally
  }, [chains])

  const filteredChains = useMemo(
    () => (verdictFilter === 'ALL' ? chains : chains.filter((item) => item.chain.verdict === verdictFilter)),
    [chains, verdictFilter],
  )

  const copyCite = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400)
  }

  if (hyps.length === 0 && evs.length === 0) {
    return (
      <div style={emptyBox}>
        当前会话暂无入账证据或假设。运行 <code>/workflow reverse</code>、<code>/inspect</code> 或发送逆向任务后，此处将自动按「静态推断 vs 动态实测」双轨对齐并标记仲裁冲突。
      </div>
    )
  }

  return (
    <div style={scrollBody}>
      {/* Hypothesis Dual-View Cross-Check Matrix + Verdict Filter */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div style={sectionTitle}>◈ 假设双视角交叉核验（静态推断 ↔ 动态实测）</div>
        <div className="re-filter-strip re-mono-num">
          {(
            [
              ['ALL', `全部 ${chains.length}`],
              ['VERIFIED', `Verified ${counts.VERIFIED}`],
              ['DIVERGED', `Diverged ${counts.DIVERGED}`],
              ['UNCOVERED', `Uncovered ${counts.UNCOVERED}`],
              ['ANTI_ANALYSIS', `Anti-Analysis ${counts.ANTI_ANALYSIS}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="re-filter-chip"
              data-active={verdictFilter === key ? '1' : undefined}
              onClick={() => setVerdictFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
        {filteredChains.map(({ hyp: h, chain }) => {
          const arc = arcsById.get(h.id)
          const sup = (h.supporting ?? []).map((id) => evMap.get(id)).filter((x): x is EvidenceRecord => Boolean(x))
          const con = (h.contradicting ?? []).map((id) => evMap.get(id)).filter((x): x is EvidenceRecord => Boolean(x))
          const hasStatic = chain.staticEvs.length > 0
          const hasDynamic = chain.dynamicEvs.length > 0 || chain.verifyEvs.length > 0
          const hasConflict = chain.verdict === 'DIVERGED'
          const statusBadge = hasConflict
            ? { text: '✗ 动静冲突 / 待重查', style: badgeErr }
            : hasStatic && hasDynamic
              ? { text: '✓ 双视角交叉确认', style: badgeOk }
              : hasStatic
                ? { text: '⚠ 仅静态推断 · 缺动态验证', style: badgeWarn }
                : { text: '○ 待补充证据', style: badgeMuted }

          return (
            <div
              key={h.id}
              style={{
                ...alignCard,
                borderColor: hasConflict ? 'var(--err)' : hasStatic && hasDynamic ? 'var(--ok)' : 'var(--rule)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong className="re-mono-num" style={{ color: 'var(--accent)', fontSize: 12 }}>{h.id}</strong>
                <span className="re-mono-num" style={{ color: 'var(--faint)', fontSize: 11 }}>
                  {Math.round(h.confidence * 100)}% · {h.status}
                </span>
                <span className="re-verdict-badge" data-verdict={chain.verdict}>
                  {chain.verdict === 'ANTI_ANALYSIS' ? 'ANTI-ANALYSIS' : chain.verdict}
                </span>
                <span style={statusBadge.style}>{statusBadge.text}</span>
                <span
                  className="re-calib-pill"
                  data-tone={chain.calibration.tone}
                  title={chain.calibration.reason}
                >
                  {chain.calibration.status}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="re-copy-chip"
                  data-copied={copiedId === h.id ? '1' : undefined}
                  onClick={() => copyCite(h.id, formatHypothesisCitation(h))}
                  title="复制取证引用编号"
                >
                  {copiedId === h.id ? '✓ 已复制' : '⎘ 引用'}
                </button>
                {sessionId && !hasDynamic && !hasConflict && (
                  <button
                    type="button"
                    onClick={() => sceneActions.openWizard({ sessionId, stage: 'experiment', hypId: h.id })}
                    style={actionBtnPrimary}
                  >
                    ▶ 去配动态实验
                  </button>
                )}
                {sessionId && hasConflict && (
                  <button
                    type="button"
                    onClick={() =>
                      sceneActions.openWizard({
                        sessionId,
                        stage: 'revise',
                        hypId: h.id,
                        prefillClaim: h.claim,
                      })
                    }
                    style={actionBtn}
                  >
                    ✎ 修正假设
                  </button>
                )}
              </div>
              <div style={{ color: 'var(--text)', fontSize: 11.5, marginTop: 4 }}>{h.claim}</div>

              {/* Explicit Provenance Chain: Static -> Dynamic -> Verification Oracle -> Audit */}
              <div className="re-chain" style={{ marginTop: 5 }}>
                <span className="re-chain-step" data-hit={chain.staticEvs.length > 0 ? 'static' : undefined}>
                  Static ({chain.staticEvs.length})
                </span>
                <span className="re-chain-arrow">→</span>
                <span
                  className="re-chain-step"
                  data-hit={
                    chain.contradictEvs.length > 0
                      ? 'conflict'
                      : chain.dynamicEvs.length > 0
                        ? '1'
                        : undefined
                  }
                >
                  Dynamic ({chain.dynamicEvs.length}{chain.contradictEvs.length > 0 ? ` / ✗${chain.contradictEvs.length}` : ''})
                </span>
                <span className="re-chain-arrow">→</span>
                <span className="re-chain-step" data-hit={chain.verifyEvs.length > 0 ? '1' : undefined}>
                  Oracle ({chain.verifyEvs.length})
                </span>
                <span className="re-chain-arrow">→</span>
                <span className="re-chain-step" data-hit={chain.auditEvs.length > 0 ? 'audit' : undefined}>
                  Audit ({chain.auditEvs.length})
                </span>
                {chain.falsificationCriteria && (
                  <span style={{ color: 'var(--faint)', fontSize: 10, marginLeft: 4 }}>
                    · 证伪判据: {chain.falsificationCriteria}
                  </span>
                )}
              </div>

              {/* Readable Causal Narrative: Basis -> Dynamic Check -> Verdict */}
              {arc && (
                <div
                  className="re-causal-strip"
                  data-tone={arc.tone === 'err' ? 'err' : arc.tone === 'ok' ? 'ok' : arc.tone === 'warn' ? 'warn' : undefined}
                  style={{ marginTop: 6 }}
                >
                  <div className="re-causal-row">
                    <span className="re-causal-k">提出依据</span>
                    <span>{arc.triggerClues}</span>
                  </div>
                  <div className="re-causal-row">
                    <span className="re-causal-k">动态验证</span>
                    <span>{arc.testAndObservation}</span>
                  </div>
                  <div className="re-causal-row">
                    <span className="re-causal-k">结论裁定</span>
                    <span>{arc.deductionVerdict}</span>
                  </div>
                  {arc.contrast && (
                    <div className="re-causal-row" style={{ color: 'var(--err)' }}>
                      <span className="re-causal-k" style={{ color: 'var(--err)' }}>预期冲突</span>
                      <span>
                        预期「{arc.contrast.expected}」↔ 实测「{arc.contrast.observed}」
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5, fontSize: 10.5 }}>
                {sup.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onOpenLedger?.('evidence', e.id)}
                    style={{
                      ...chipBtn,
                      borderColor: e.view === 'dynamic' || e.kind === 'verification_result' ? 'var(--ok)' : 'var(--accent)',
                      color: e.view === 'dynamic' || e.kind === 'verification_result' ? 'var(--ok)' : 'var(--accent)',
                    }}
                  >
                    +{e.id} ({e.view || e.kind})
                  </button>
                ))}
                {con.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onOpenLedger?.('evidence', e.id)}
                    style={{ ...chipBtn, borderColor: 'var(--err)', color: 'var(--err)' }}
                  >
                    ✗{e.id} 矛盾 ({e.source})
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Arbitrator / Audit conflict bridges */}
      {findings.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={sectionTitle}>⚖ 仲裁器与对抗审计冲突记录 ({findings.length})</div>
          <div style={{ display: 'grid', gap: 5 }}>
            {findings.map((f, i) => (
              <div
                key={`${f.rule}-${f.hypothesisId}-${i}`}
                style={{
                  ...alignCard,
                  borderColor: f.action === 'challenge' ? 'var(--err)' : 'var(--violet)',
                  padding: '6px 10px',
                }}
              >
                <span style={{ color: f.action === 'challenge' ? 'var(--err)' : 'var(--ok)', fontWeight: 700, fontSize: 11 }}>
                  [{f.rule} · {f.action || 'advisory'}] {f.hypothesisId}
                  {f.evidenceId ? ` ↔ ${f.evidenceId}` : ''}
                </span>
                <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>{f.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dual-rail Static vs Dynamic Evidence Timeline */}
      <div style={dualGrid}>
        <div>
          <div style={sectionTitle}>▤ 静态观测轨 ({staticEvs.length})</div>
          <div style={{ display: 'grid', gap: 5 }}>
            {staticEvs.length === 0 ? (
              <div style={dimBox}>暂无静态工具记录</div>
            ) : (
              staticEvs.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onOpenLedger?.('evidence', e.id)}
                  style={evCardBtn}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
                    <strong style={{ color: 'var(--accent)' }}>{e.id}</strong>
                    <span style={{ color: 'var(--faint)' }}>{e.source}</span>
                  </div>
                  <div style={evExcerpt}>{e.excerpt}</div>
                </button>
              ))
            )}
          </div>
        </div>

        <div>
          <div style={sectionTitle}>⚡ 动态实测 / 验证 / 审计轨 ({dynamicEvs.length})</div>
          <div style={{ display: 'grid', gap: 5 }}>
            {dynamicEvs.length === 0 ? (
              <div style={dimBox}>暂无动态运行、verify_artifact 或 /audit 记录</div>
            ) : (
              dynamicEvs.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onOpenLedger?.('evidence', e.id)}
                  style={{
                    ...evCardBtn,
                    borderColor: e.isError ? 'var(--err)' : e.kind === 'verification_result' ? 'var(--ok)' : 'var(--violet)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
                    <strong style={{ color: e.isError ? 'var(--err)' : 'var(--ok)' }}>
                      {e.id} {e.isError ? '✗' : '✓'}
                    </strong>
                    <span style={{ color: 'var(--faint)' }}>
                      {e.kind} · {e.source}
                    </span>
                  </div>
                  <div style={evExcerpt}>{e.excerpt}</div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- styles ----------

const headerRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  paddingBottom: 8,
  borderBottom: '1px solid var(--rule)',
  marginBottom: 8,
}

const scrollBody: CSSProperties = {
  flex: '1 1 0',
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const tabIdle: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--rule)',
  color: 'var(--muted)',
  fontSize: 11,
  padding: '4px 10px',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const tabActive: CSSProperties = {
  ...tabIdle,
  border: '1px solid var(--accent)',
  color: 'var(--accent)',
  background: 'rgba(34, 211, 238, 0.1)',
  fontWeight: 600,
}

const selectLabel: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  color: 'var(--faint)',
  fontSize: 10.5,
}

const chipBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--rule)',
  color: 'var(--muted)',
  fontSize: 10.5,
  padding: '2px 7px',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const metaItem: CSSProperties = { color: 'var(--muted)' }

const badgeBase: CSSProperties = {
  padding: '1px 6px',
  fontSize: 10,
  border: '1px solid var(--rule)',
  letterSpacing: '0.04em',
}
const badgeAccent: CSSProperties = { ...badgeBase, borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 700 }
const badgeOk: CSSProperties = { ...badgeBase, borderColor: 'var(--ok)', color: 'var(--ok)' }
const badgeWarn: CSSProperties = { ...badgeBase, borderColor: 'var(--warn)', color: 'var(--warn)' }
const badgeErr: CSSProperties = { ...badgeBase, borderColor: 'var(--err)', color: 'var(--err)', fontWeight: 700 }
const badgeMuted: CSSProperties = { ...badgeBase, color: 'var(--faint)' }

const svgWrap: CSSProperties = {
  border: '1px solid var(--rule)',
  padding: 6,
  background: 'rgba(2, 6, 23, 0.55)',
}

const legendRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  fontSize: 10,
  color: 'var(--muted)',
  marginTop: 5,
  paddingTop: 4,
  borderTop: '1px dashed var(--rule)',
}

const hotspotBar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
}

const jumpChip: CSSProperties = {
  background: 'rgba(15, 23, 42, 0.55)',
  border: '1px solid var(--rule)',
  fontSize: 10.5,
  padding: '2px 8px',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const inspectorCard: CSSProperties = {
  border: '1px solid var(--accent-dim)',
  background: 'rgba(8, 22, 34, 0.65)',
  padding: '8px 10px',
}

const inspectorHead: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  paddingBottom: 6,
  borderBottom: '1px solid var(--rule)',
}

const inspectorBody: CSSProperties = {
  marginTop: 6,
  fontSize: 11.5,
  color: 'var(--muted)',
  lineHeight: 1.5,
}

const dimLbl: CSSProperties = { color: 'var(--faint)' }

const actionBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--rule)',
  color: 'var(--text)',
  fontSize: 10.5,
  padding: '3px 8px',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const actionBtnPrimary: CSSProperties = {
  ...actionBtn,
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  background: 'rgba(34, 211, 238, 0.1)',
  fontWeight: 600,
}

const actionBtnViolet: CSSProperties = {
  ...actionBtn,
  borderColor: 'var(--violet)',
  color: 'var(--violet)',
  background: 'rgba(139, 92, 246, 0.1)',
}

const errBanner: CSSProperties = {
  color: 'var(--err)',
  border: '1px solid var(--err)',
  padding: '6px 10px',
  fontSize: 11.5,
}

const emptyBox: CSSProperties = {
  color: 'var(--faint)',
  fontSize: 12,
  padding: '24px 12px',
  textAlign: 'center',
}

const sectionTitle: CSSProperties = {
  color: 'var(--accent)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  marginBottom: 4,
}

const alignCard: CSSProperties = {
  border: '1px solid var(--rule)',
  padding: '8px 10px',
  background: 'rgba(15, 23, 42, 0.45)',
}

const dualGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 10,
}

const dimBox: CSSProperties = {
  color: 'var(--faint)',
  fontSize: 11,
  padding: '10px',
  border: '1px dashed var(--rule)',
}

const evCardBtn: CSSProperties = {
  textAlign: 'left',
  background: 'rgba(15, 23, 42, 0.5)',
  border: '1px solid var(--rule)',
  padding: '6px 8px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: 'var(--text)',
}

const evExcerpt: CSSProperties = {
  color: 'var(--muted)',
  fontSize: 10.5,
  marginTop: 3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
}
