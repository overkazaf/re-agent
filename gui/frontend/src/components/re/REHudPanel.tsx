// WS4 RE workflow HUD: nine-phase strip ▸TRI → STA → DYN → EVI → IFC →
// HYP → VER → AUD → WRI (current = ▸ + accent bold, past = muted, future = faint),
// H:N / E:N counters, phase progress bar. Mirrors internal/ui/rehud.go.
import type { CSSProperties } from 'react'
import type { LedgerDTO, ReDTO } from '../../lib/types'
import { useSessionStore } from '../../store/sessions'
import { GlowText, PanelBox } from '../crt'
import './re-pro.css'
import './controlLoop.css'

type ExtendedLedger = LedgerDTO & {
  auditVerdict?: 'accepted' | 'rejected' | 'needs_more_evidence' | string
}

// Glyphs match workflow.PhaseCodes / internal/ui/rehud.go exactly.
const PHASES = ['TRI', 'STA', 'DYN', 'EVI', 'IFC', 'HYP', 'VER', 'AUD', 'WRI']
const PHASE_GATES: Record<string, string> = {
  TRI: '样本指纹 / 格式 / 保护初筛',
  STA: '静态观测入账 (ev ≥ 1)',
  DYN: '可证伪假设建栈 (H ≥ 1)',
  EVI: '动静双视角证据采集',
  IFC: '核心接口 / 偏移定位',
  HYP: '冲突仲裁与置信度校准',
  VER: '动态追踪 ≥ 1 或静态观测 ≥ 3',
  AUD: 'verify_artifact 重放凭证 ≥ 1',
  WRI: 'audit_finding ≥ 1 + /goal 达标',
}
const BAR_W = 14

export function REHudPanel({
  re,
  ledger: ledgerProp,
  onInspect,
  onOpenGraph,
  onOpenWriteup,
  style,
}: {
  re: ReDTO | null
  ledger?: LedgerDTO | null
  onInspect?: (tab: 'hypotheses' | 'evidence') => void
  onOpenGraph?: () => void
  onOpenWriteup?: () => void
  style?: CSSProperties
}) {
  const storeSnap = useSessionStore()
  const activeLedger = (ledgerProp ??
    (storeSnap.activeId ? storeSnap.sessions.get(storeSnap.activeId)?.latestTick?.ledger : null) ??
    null) as ExtendedLedger | null

  const defenses = computeDefenseStatus(re, activeLedger)
  const deliveryVerdict = computeDeliveryVerdict(re, activeLedger)

  return (
    <div style={style}>
      <PanelBox title="re workflow" accent="violet" tier="primary" badge={re ? `${re.phaseIndex + 1}/${re.phaseCount}` : undefined}>
        {!re ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--faint)', fontSize: 11.5, padding: '3px 0' }}>
            <span>○ RE workflow off</span>
            <span
              className="re-hint-dot"
              data-hint="运行 /workflow reverse|ctf|research 启用 9 阶段硬门禁逆向流"
            >
              ?
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11 }}>
              <span
                data-hint={`当前样本类型：${re.sampleType || '未指定'}`}
                style={{
                  color: 'var(--violet)',
                  border: '1px solid color-mix(in srgb, var(--violet) 55%, var(--rule))',
                  background: 'var(--violet-soft)',
                  borderRadius: 'var(--radius-xs)',
                  padding: '0 6px',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                }}
              >
                {re.sampleType || '—'}
              </span>
              <GlowText tone="accent">
                <span style={{ fontWeight: 700 }}>{(re.phase || '').toUpperCase()}</span>
              </GlowText>
              <span className="re-mono-num" style={{ color: 'var(--faint)' }}>
                [{re.phaseIndex + 1}/{re.phaseCount}]
              </span>
              <span
                className="re-hint-dot"
                style={{ marginLeft: 'auto' }}
                data-hint={
                  re.phaseIndex >= PHASES.length - 1
                    ? '✓ WRI 交付门禁已全部达标，可导出完整取证 Writeup'
                    : `下一阶段门禁 ${PHASES[re.phaseIndex + 1]}：${PHASE_GATES[PHASES[re.phaseIndex + 1]] ?? ''}`
                }
              >
                ?
              </span>
            </div>

            <div className="re-mono-num" style={{ display: 'flex', alignItems: 'baseline', gap: 3, fontSize: 11, flexWrap: 'wrap' }}>
              {PHASES.map((p, i) => (
                <span key={p} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3 }}>
                  {i > 0 && <span style={{ color: 'var(--rule)' }}>→</span>}
                  <span
                    data-hint={`${p} 门禁：${PHASE_GATES[p] ?? ''}`}
                    style={
                      i === re.phaseIndex
                        ? { color: 'var(--accent)', fontWeight: 700 }
                        : i < re.phaseIndex
                          ? { color: 'var(--muted)' }
                          : { color: 'var(--faint)' }
                    }
                  >
                    {i === re.phaseIndex ? `▸${p}` : p}
                  </span>
                </span>
              ))}
            </div>

            <div
              className="re-mono-num"
              style={{ fontSize: 11.5, letterSpacing: 1 }}
              data-hint={
                re.phaseIndex >= PHASES.length - 1
                  ? '✓ WRI 交付门禁就绪 (9/9)'
                  : `阶段进度 ${re.phaseIndex + 1}/${re.phaseCount} · NEXT → ${PHASES[re.phaseIndex + 1]}: ${PHASE_GATES[PHASES[re.phaseIndex + 1]] ?? ''}`
              }
            >
              <span style={{ color: 'var(--accent)' }}>{'▰'.repeat(filled(re))}</span>
              <span style={{ color: 'var(--rule)' }}>{'▱'.repeat(BAR_W - filled(re))}</span>
            </div>

            <div className="re-mono-num" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
              <button
                type="button"
                onClick={() => onInspect?.('hypotheses')}
                title="点击查看假设栈明细"
                data-hint="点击打开假设栈明细，检视置信度与证据连线"
                style={{
                  padding: 0,
                  cursor: onInspect ? 'pointer' : 'default',
                  borderBottom: onInspect ? '1px dashed var(--accent-dim)' : 'none',
                }}
              >
                <GlowText tone="accent">H:{re.hypotheses}</GlowText>
              </button>
              <button
                type="button"
                onClick={() => onInspect?.('evidence')}
                title="点击查看证据账本明细"
                data-hint="点击打开不可篡改证据账本明细 (ev_NNN)"
                style={{
                  padding: 0,
                  cursor: onInspect ? 'pointer' : 'default',
                  borderBottom: onInspect ? '1px dashed var(--ok)' : 'none',
                }}
              >
                <GlowText tone="ok">E:{re.evidence}</GlowText>
              </button>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5 }}>
                {onOpenGraph && (
                  <button
                    type="button"
                    onClick={onOpenGraph}
                    data-hint="打开多席位协同与因果证据图谱"
                    style={{
                      padding: '1px 6px',
                      fontSize: 10,
                      color: 'var(--violet)',
                      border: '1px solid color-mix(in srgb, var(--violet) 50%, var(--rule))',
                      borderRadius: 'var(--radius-xs)',
                      background: 'var(--violet-soft)',
                      cursor: 'pointer',
                    }}
                  >
                    ◈ 图谱
                  </button>
                )}
                {onOpenWriteup && (
                  <button
                    type="button"
                    onClick={onOpenWriteup}
                    data-hint="打开完整推理叙事与证据锚定 Writeup 报告工坊"
                    style={{
                      padding: '1px 6px',
                      fontSize: 10,
                      color: re.phase === 'writeup' ? 'var(--ok)' : 'var(--muted)',
                      border: `1px solid ${re.phase === 'writeup' ? 'color-mix(in srgb, var(--ok) 55%, var(--rule))' : 'var(--border-subtle)'}`,
                      borderRadius: 'var(--radius-xs)',
                      background: re.phase === 'writeup' ? 'var(--ok-soft)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    ✎ 报告
                  </button>
                )}
              </span>
            </div>

            {/* Compact single-line 5-Defense dots + 3-state delivery verdict chip */}
            <div className="cl-hud-def-row re-mono-num" data-testid="re-hud-defenses">
              {defenses.map((d) => (
                <span
                  key={d.code}
                  className="cl-def-dot"
                  data-state={d.state}
                  data-hint={d.hint}
                >
                  {d.code}
                </span>
              ))}
              <span style={{ flex: 1 }} />
              <span
                className="cl-verdict-chip"
                data-verdict={deliveryVerdict.verdict}
                data-hint={deliveryVerdict.hint}
              >
                {deliveryVerdict.label}
              </span>
            </div>
          </div>
        )}
      </PanelBox>
    </div>
  )
}

function filled(re: ReDTO): number {
  if (re.phaseCount <= 0) return 0
  return Math.min(BAR_W, Math.max(0, Math.round(((re.phaseIndex + 1) * BAR_W) / re.phaseCount)))
}

function computeDefenseStatus(
  re: ReDTO | null,
  ledger: ExtendedLedger | null,
): Array<{ code: 'CAP' | 'LED' | 'HYP' | 'VER' | 'AUD'; state: 'ok' | 'active' | 'warn' | 'idle'; hint: string }> {
  const evs = ledger?.evidence ?? []
  const hyps = ledger?.hypotheses ?? []
  const sandbox = ledger?.sandbox
  const verEvs = evs.filter((e) => !e.isError && e.kind === 'verification_result')
  const audEvs = evs.filter((e) => e.kind === 'audit_finding')
  const hasConflict = hyps.some((h) => h.status === 'reevaluate')

  const capState: 'ok' | 'active' | 'warn' | 'idle' = sandbox?.deniedCount
    ? 'warn'
    : sandbox?.active
      ? 'ok'
      : 'idle'
  const ledState: 'ok' | 'active' | 'warn' | 'idle' =
    (evs.length || re?.evidence || 0) > 0 ? 'ok' : 'idle'
  const hypState: 'ok' | 'active' | 'warn' | 'idle' = hasConflict
    ? 'warn'
    : (hyps.length || re?.hypotheses || 0) > 0
      ? 'active'
      : 'idle'
  const verState: 'ok' | 'active' | 'warn' | 'idle' = verEvs.length > 0
    ? 'ok'
    : re?.phase === 'verify'
      ? 'active'
      : 'idle'
  const audState: 'ok' | 'active' | 'warn' | 'idle' = audEvs.length > 0
    ? 'ok'
    : re?.phase === 'audit'
      ? 'active'
      : 'idle'

  return [
    {
      code: 'CAP',
      state: capState,
      hint: `防线① Capability Sandbox：${sandbox?.active ? `任务级最小权限已启用（放行 ${sandbox.grantedCount} · 拦截越权 ${sandbox.deniedCount}）` : '基础策略守护中（声明 /goal 激活硬沙箱）'}`,
    },
    {
      code: 'LED',
      state: ledState,
      hint: `防线② Evidence Ledger：只追加实测账本 E:${evs.length || re?.evidence || 0}（原始样本输出按 UNTRUSTED DATA 隔离）`,
    },
    {
      code: 'HYP',
      state: hypState,
      hint: `防线③ Hypothesis Manager：显式可证伪假设栈 H:${hyps.length || re?.hypotheses || 0}${hasConflict ? '（含待重审冲突假设）' : ''}`,
    },
    {
      code: 'VER',
      state: verState,
      hint: `防线④ Execution Verifier：${verEvs.length > 0 ? `已签发 ${verEvs.length} 条 verify_artifact 行为重放凭证` : '待运行 verify_artifact 正反例与差分校验（区分 candidate / verified）'}`,
    },
    {
      code: 'AUD',
      state: audState,
      hint: `防线⑤ Adversarial Auditor：${audEvs.length > 0 ? `隔离对抗审计已签发 ${audEvs.length} 条核查记录` : '待触发独立隔离上下文 5 项对抗审计 (/audit)'}`,
    },
  ]
}

function computeDeliveryVerdict(
  re: ReDTO | null,
  ledger: ExtendedLedger | null,
): { verdict: 'accepted' | 'pending' | 'needs_more_evidence' | 'rejected'; label: string; hint: string } {
  const explicit = ledger?.auditVerdict
  if (explicit === 'accepted') {
    return {
      verdict: 'accepted',
      label: 'ACCEPTED',
      hint: '交付裁定：accepted — 已通过行为回放、差分验证与隔离对抗审计，可输出可复现报告',
    }
  }
  if (explicit === 'rejected') {
    return {
      verdict: 'rejected',
      label: 'REJECTED',
      hint: '交付裁定：rejected — 存在未消除反证或越权违规，结论已被审计拒收',
    }
  }
  if (explicit === 'needs_more_evidence') {
    return {
      verdict: 'needs_more_evidence',
      label: 'NEEDS EV',
      hint: '交付裁定：needs_more_evidence — 覆盖不足、单样本命中或存在冲突，退回补证',
    }
  }

  const evs = ledger?.evidence ?? []
  const hyps = ledger?.hypotheses ?? []
  const findings = ledger?.findings ?? []
  const hasVer = evs.some((e) => !e.isError && e.kind === 'verification_result')
  const hasAud = evs.some((e) => e.kind === 'audit_finding')
  const goalOk = !ledger?.goal || ledger.goal.criteria.every((c) => c.pass)
  const hasUnresolved = hyps.some((h) => h.status === 'reevaluate')

  if ((hasAud && hasVer && goalOk && !hasUnresolved) || re?.phase === 'writeup') {
    return {
      verdict: 'accepted',
      label: 'ACCEPTED',
      hint: '交付裁定：accepted — 重放验证、/goal 指标与隔离审计均达标，可交付可复现报告',
    }
  }
  if (hasUnresolved || findings.some((f) => f.action === 'challenge' || f.rule === 'runtime-contradiction')) {
    return {
      verdict: 'needs_more_evidence',
      label: 'NEEDS EV',
      hint: '交付裁定：needs_more_evidence — 检出证据冲突或覆盖盲区，需补充实验/反例后重审',
    }
  }
  return {
    verdict: 'pending',
    label: 'PENDING',
    hint: '交付裁定：candidate/pending — 分析进行中，需完成 verify_artifact 与隔离 /audit 验收',
  }
}
