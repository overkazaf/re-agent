// WS3 dev page (dev-panels.html) — full-state showcase of the dashboard
// panels over src/dev/mock.ts: the live Dashboard driven by a looping stage
// player, the nine-stage FLOW matrix, and every panel pinned in its states.
// Demo-only: the timers here stand in for the tick/loop event stream that the
// integration layer will feed the panels later.
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/crt.css'
import '../components/panels/panels.css'

import {
  Dashboard,
  FlowPanel,
  PlanPanel,
  STAGES,
  TelePanel,
  ThinkPanel,
  ToolsPanel,
} from '../components/panels'
import { flow as mkFlow, hud as mkHud, planSnapshot, tick, tickIdle } from './mock'
import type { FlowDTO, FlowStage } from '../lib/types'

// ---------- demo data ----------

/** Per-stage FlowDTO overrides so each stage shows its telling detail. */
const STAGE_OVERRIDES: Partial<Record<FlowStage, Partial<FlowDTO>>> = {
  send: { packets: [[2, 6, 10], [1, 5], [0], [0]] },
  wait: { packets: [[4], [3], [], []] },
  think: { planKind: 'open', packets: [[3, 7, 11], [2, 6], [], []] },
  calls: { pendingCalls: 2, packets: [[], [1], [2, 6], [3, 8]] },
  tool: { activeTool: 'r2', toolMs: 3200, pendingCalls: 1, planKind: 'step', packets: [[], [], [1, 5], [2, 7, 12]] },
  write: { replyChars: 812, planKind: 'write', packets: [[], [2], [], []] },
  done: { packets: [[], [], [], []] },
  error: { error: 'provider 500: rate limited', packets: [[], [], [], []] },
  idle: { packets: [[], [], [], []] },
}

/** planKind cycle for the flash demo (open → write → step → quiet). */
const KIND_SEQ: Array<'open' | 'write' | 'step' | ''> = ['open', 'write', 'step', '']
const KIND_BADGE = { done: 3, total: 7, source: 'update_plan' }

const THINK_LINES = [
  'parsing turn — task: locate license check in the unpacked APK',
  'strings hit JNI_OnLoad + OpenSSL — native lib confirmed',
  'entropy 6.41 on .text suggests OLLVM flattening, not packing',
  'candidate dispatcher near entry0+0x8f4c — look for the switch table',
  'cross-referencing constants against the billing activity class',
  'plan update: static pass complete, pivoting to deobfuscation',
  'frida attach deferred until the device is online — static first',
  'dispatcher loop guarded by a checksum — need the unpacked .so',
  'comparing dispatcher state vars with the license string offset',
  'hypothesis: license compare lives in sub_8a20, hooking its caller',
]

// ---------- demo chrome (inline styles; page-local) ----------

const page: CSSProperties = {
  maxWidth: 1020,
  margin: '0 auto',
  padding: '18px 20px 60px',
  display: 'flex',
  flexDirection: 'column',
  gap: 22,
  color: 'var(--text)',
  fontSize: 12,
}

const title: CSSProperties = {
  margin: 0,
  fontSize: 14,
  letterSpacing: '0.14em',
  color: 'var(--accent)',
  textShadow: '0 0 8px var(--accent)',
  fontWeight: 700,
}

const subtitle: CSSProperties = {
  color: 'var(--faint)',
  fontSize: 11,
  margin: '4px 0 0',
}

const sectionLabel: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 11,
  letterSpacing: '0.12em',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--rule)',
  paddingBottom: 4,
}

const matrix: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 10,
}

const duo: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 10,
}

const btn = (active: boolean): CSSProperties => ({
  background: active ? 'var(--accent-dim)' : 'transparent',
  color: active ? 'var(--bg)' : 'var(--muted)',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--rule)'}`,
  font: 'inherit',
  fontSize: 11,
  padding: '2px 8px',
  cursor: 'pointer',
  borderRadius: 2,
})

const toolbar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--rule)',
  padding: '8px 10px',
  background: 'var(--bg-panel)',
}

// ---------- page ----------

function PanelsDemo() {
  const [pin, setPin] = useState<FlowStage | 'loop'>('loop')
  const [step, setStep] = useState(0)
  const [kindIdx, setKindIdx] = useState(0)
  const [thinkOpen, setThinkOpen] = useState(true)

  // stage player: stand-in for the 90ms tick stream, slowed to watch
  useEffect(() => {
    if (pin !== 'loop') return
    const t = setInterval(() => setStep(v => (v + 1) % STAGES.length), 1400)
    return () => clearInterval(t)
  }, [pin])

  // planKind flash cycle, independent cadence
  useEffect(() => {
    if (pin !== 'loop') return
    const t = setInterval(() => setKindIdx(v => (v + 1) % KIND_SEQ.length), 1500)
    return () => clearInterval(t)
  }, [pin])

  const stage: FlowStage = pin === 'loop' ? STAGES[step] : pin
  const liveTick = tick(stage, STAGE_OVERRIDES[stage])

  const matrixCell = (s: FlowStage): ReactNode => (
    <FlowPanel flow={tick(s, STAGE_OVERRIDES[s]).flow} />
  )

  return (
    <div style={page}>
      <header>
        <h1 style={title}>▓▒░ 0xAF·RE :: dashboard panels</h1>
        <p style={subtitle}>WS3 dev page — five-panel dashboard over mock.ts; toolbar replays the turn loop.</p>
      </header>

      <div style={toolbar}>
        <button type="button" style={btn(pin === 'loop')} onClick={() => setPin('loop')}>
          ▶ loop
        </button>
        {STAGES.map(s => (
          <button key={s} type="button" style={btn(pin === s)} onClick={() => setPin(s)}>
            {s}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 11 }}>
          live stage: <span style={{ color: 'var(--accent)' }}>{stage}</span>
        </span>
      </div>

      {/* live dashboard */}
      <section>
        <h2 style={sectionLabel}>dashboard · live</h2>
        <Dashboard
          tick={liveTick}
          thinkLines={THINK_LINES}
          onThinkToggle={() => setThinkOpen(v => !v)}
        />
      </section>

      {/* the nine-stage FLOW matrix */}
      <section>
        <h2 style={sectionLabel}>flowpanel · stage matrix</h2>
        <div style={matrix}>
          {STAGES.map(matrixCell)}
        </div>
      </section>

      {/* tools: populated + empty */}
      <section>
        <h2 style={sectionLabel}>toolspanel</h2>
        <div style={duo}>
          <ToolsPanel flow={tick('tool').flow} />
          <ToolsPanel flow={tickIdle.flow} />
        </div>
      </section>

      {/* plan: static planKind references + cycling flash demo */}
      <section>
        <h2 style={sectionLabel}>planpanel · planKind flash</h2>
        <div style={duo}>
          <PlanPanel plan={planSnapshot} badge={KIND_BADGE} planKind={KIND_SEQ[kindIdx]} />
          <PlanPanel plan={planSnapshot} badge={KIND_BADGE} planKind="open" />
          <PlanPanel plan={planSnapshot} badge={KIND_BADGE} planKind="write" />
          <PlanPanel plan={planSnapshot} badge={KIND_BADGE} planKind="step" />
          <PlanPanel plan={null} badge={null} planKind="" />
        </div>
      </section>

      {/* think: uncontrolled collapsed + controlled expanded */}
      <section>
        <h2 style={sectionLabel}>thinkpanel</h2>
        <div style={duo}>
          <ThinkPanel lines={THINK_LINES} />
          <ThinkPanel lines={THINK_LINES} expanded={thinkOpen} onToggle={() => setThinkOpen(v => !v)} />
        </div>
      </section>

      {/* tele: mid-turn vs idle */}
      <section>
        <h2 style={sectionLabel}>telepanel</h2>
        <div style={duo}>
          <TelePanel hud={mkHud()} flow={mkFlow('think')} />
          <TelePanel hud={tickIdle.hud} flow={tickIdle.flow} />
        </div>
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<PanelsDemo />)
