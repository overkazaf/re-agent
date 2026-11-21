// PLAN — task-list snapshot: completed runs collapse into a single
// `✔ N done` line (TUI parity), the live step gets `◈`, pending `○`, and a
// planKind change flashes the header (open=ok, write=accent, step=violet)
// via a plain timeout — no external animation deps.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PanelBox, ProgressChip } from '../crt'
import type { FlowDTO, PlanBadge, PlanSnapshot, TickDTO } from '../../lib/types'
import { evaluatePhaseGates } from '../re/forensics'
import '../re/re-pro.css'
import { fmtDuration } from './format'

type FlashTone = 'ok' | 'accent' | 'violet'
type PlanKind = Exclude<FlowDTO['planKind'], ''>

const KIND_TONE: Record<PlanKind, FlashTone> = { open: 'ok', write: 'accent', step: 'violet' }
const FLASH_MS = 700

function planRows(steps: PlanSnapshot['steps']): ReactNode[] {
  const rows: ReactNode[] = []
  let i = 0
  while (i < steps.length) {
    const step = steps[i]
    if (step.status === 'completed') {
      // collapse each run of consecutive completed steps into one row
      const texts: string[] = []
      let j = i
      while (j < steps.length && steps[j].status === 'completed') {
        texts.push(steps[j].text)
        j++
      }
      rows.push(
        <div key={`done-${i}`} className="plan-done t-ok" title={texts.join('\n')}>
          ✔ {texts.length} done
        </div>,
      )
      i = j
    } else if (step.status === 'in_progress') {
      rows.push(
        <div key={step.id !== '' ? step.id : `live-${i}`} className="plan-step plan-active">
          <span className="plan-glyph t-accent">◈</span>
          <span className="plan-text">{step.text}</span>
          {step.startedAt > 0 && (
            <span className="t-faint re-mono-num" style={{ marginLeft: 'auto', fontSize: 10 }}>
              {fmtDuration(Math.max(0, Date.now() - step.startedAt))}
            </span>
          )}
        </div>,
      )
      i++
    } else {
      rows.push(
        <div key={step.id !== '' ? step.id : `wait-${i}`} className="plan-step plan-pending">
          <span className="plan-glyph t-faint">○</span>
          <span className="plan-text">{step.text}</span>
        </div>,
      )
      i++
    }
  }
  return rows
}

export function PlanPanel({ plan, badge, planKind, tick }: {
  plan: PlanSnapshot | null
  badge: FlowDTO['plan']
  planKind: FlowDTO['planKind']
  tick?: TickDTO | null
}) {
  const [flash, setFlash] = useState<FlashTone | null>(null)
  const prevKind = useRef<FlowDTO['planKind']>(planKind)

  useEffect(() => {
    if (planKind === prevKind.current) return
    prevKind.current = planKind
    if (planKind === '') {
      setFlash(null)
      return
    }
    setFlash(KIND_TONE[planKind])
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [planKind])

  const steps = plan?.steps ?? []
  const counts: PlanBadge =
    badge ?? {
      done: steps.filter(s => s.status === 'completed').length,
      total: steps.length,
      source: plan?.source ?? '',
    }
  const pct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0
  const phaseGates = tick?.re ? evaluatePhaseGates(tick) : null
  const nextBlocked = phaseGates?.find((g) => g.ready === 'blocked') ?? null
  const wriReady = phaseGates ? phaseGates[phaseGates.length - 1]?.ready === 'pass' || tick?.re?.phase === 'writeup' : false

  return (
    <PanelBox title="plan" accent={flash ?? 'warn'} tier="primary" badge="任务路线">
      <div className="plan-head re-mono-num">
        {counts.total > 0 && (
          <>
            <ProgressChip done={counts.done} total={counts.total} />
            <span className="t-muted" style={{ fontSize: 10 }}>{pct}%</span>
            <span className="plan-src t-faint">{counts.source}</span>
          </>
        )}
        {phaseGates && (
          <span
            className="re-gate-pill"
            data-ready={wriReady ? 'pass' : nextBlocked ? 'blocked' : 'current'}
            title={nextBlocked ? `下一阶段 ${nextBlocked.code} 门禁: ${nextBlocked.criterion}` : '阶段门禁已达标'}
          >
            {wriReady ? '✓ WRI READY' : nextBlocked ? `🔒 ${nextBlocked.code}: ${nextBlocked.progress}` : '▸ GATE OK'}
          </span>
        )}
        {planKind !== '' && (
          <span
            className={flash !== null ? 'plan-kind plan-flash' : 'plan-kind'}
            style={{ color: `var(--${KIND_TONE[planKind]})` }}
          >
            ◈ {planKind}
          </span>
        )}
      </div>
      {plan !== null && plan.note !== '' && <div className="plan-note">{plan.note}</div>}
      {steps.length === 0 ? (
        <div className="panel-empty t-faint">(no task list yet)</div>
      ) : (
        <div className="plan-steps">{planRows(steps)}</div>
      )}
    </PanelBox>
  )
}
