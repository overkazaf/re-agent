// DemoCoachBar — compact, CRT-native interactive walkthrough banner mounted
// directly beneath TopBar while Demo Sandbox mode is active. Keeps step
// guidance visible across both the Agent Dashboard and the embedded Shell view.
import type { CSSProperties } from 'react'
import { DEMO_SCENARIOS, getScenario } from '../../demo/scenarios'
import { demoActions, useDemoStore } from '../../demo/store'
import { GlowText } from '../crt'

export function DemoCoachBar({
  graphOpen = false,
  onToggleGraph,
}: {
  graphOpen?: boolean
  onToggleGraph?: () => void
}) {
  const demo = useDemoStore()
  if (!demo.active) return null

  const scenario = getScenario(demo.scenarioId)
  const step = scenario.steps[demo.stepIndex] ?? scenario.steps[0]
  const doneCount = scenario.steps.filter((st) => demo.completedSteps[`${scenario.id}:${st.id}`]).length
  const allDone = doneCount === scenario.steps.length
  const stepDone = Boolean(demo.completedSteps[`${scenario.id}:${step.id}`])

  return (
    <div style={barOuter}>
      {/* Row 1: scenario picker, step progress pills, controls */}
      <div style={row1Style}>
        <span style={badgeStyle}>
          <GlowText tone="accent">◈ DEMO</GlowText>
        </span>

        <button
          type="button"
          onClick={() => demoActions.setLauncherOpen(true)}
          title="切换演示场景（共 5 个常见 Case）"
          style={caseBtnStyle}
        >
          <span style={{ color: 'var(--violet)' }}>
            CASE {scenario.index}/{DEMO_SCENARIOS.length}
          </span>
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{scenario.title}</span>
          <span style={{ color: 'var(--faint)' }}>▾</span>
        </button>

        <div style={stepsRowStyle}>
          {scenario.steps.map((st, idx) => {
            const done = Boolean(demo.completedSteps[`${scenario.id}:${st.id}`])
            const current = idx === demo.stepIndex
            return (
              <button
                key={st.id}
                type="button"
                onClick={() => demoActions.setStepIndex(idx)}
                title={st.guide}
                style={{
                  ...stepPillStyle,
                  borderColor: current
                    ? 'var(--accent)'
                    : done
                      ? 'color-mix(in srgb, var(--ok) 55%, var(--rule))'
                      : 'var(--rule)',
                  color: current ? 'var(--accent)' : done ? 'var(--ok)' : 'var(--faint)',
                  background: current ? 'rgba(34, 211, 238, 0.08)' : 'transparent',
                }}
              >
                <span>{done ? '✓' : current ? '▸' : '○'}</span>
                <span>
                  {idx + 1}.{st.title}
                </span>
              </button>
            )
          })}
        </div>

        <span style={{ flex: 1 }} />

        <span style={{ color: allDone ? 'var(--ok)' : 'var(--faint)', fontSize: 11, whiteSpace: 'nowrap' }}>
          {doneCount}/{scenario.steps.length}
        </span>

        {onToggleGraph && (
          <button
            type="button"
            onClick={onToggleGraph}
            title="切换协同机制图谱 / 五维仪表盘（边跑边看 codex sol · ds · glm-5.3 与假设证据演化）"
            style={{
              ...ctrlBtnStyle,
              borderColor: graphOpen ? 'var(--accent)' : 'var(--violet-dim)',
              color: graphOpen ? 'var(--accent)' : 'var(--violet)',
              background: graphOpen ? 'rgba(34, 211, 238, 0.1)' : 'rgba(139, 92, 246, 0.08)',
            }}
          >
            {graphOpen ? '▣ 返回仪表' : '◈ 协同图谱'}
          </button>
        )}

        <button
          type="button"
          onClick={() => void demoActions.resetScenario()}
          disabled={demo.busy}
          title="重置当前演示场景"
          style={ctrlBtnStyle}
        >
          ↻ 重置
        </button>
        <button
          type="button"
          onClick={() => demoActions.toggleCollapsed()}
          title={demo.collapsed ? '展开操作指引' : '折叠指引条'}
          style={ctrlBtnStyle}
        >
          {demo.collapsed ? '▾ 指引' : '▴ 折叠'}
        </button>
        {!demo.isStandaloneBrowser ? (
          <button
            type="button"
            onClick={() => demoActions.exitDemo()}
            title="退出演示模式，恢复真实桌面会话"
            style={{ ...ctrlBtnStyle, borderColor: 'var(--warn)', color: 'var(--warn)' }}
          >
            ✕ 退出
          </button>
        ) : (
          <span style={{ color: 'var(--faint)', fontSize: 10, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
            WEB SANDBOX
          </span>
        )}
      </div>

      {/* Row 2: active step instruction + one-click fill / auto-run actions */}
      {!demo.collapsed && (
        <div style={row2Style}>
          <span style={targetTagStyle}>{step.target}</span>
          <span style={guideTextStyle}>
            {stepDone && demo.lastHint ? (
              <span style={{ color: 'var(--ok)' }}>{demo.lastHint}</span>
            ) : (
              <>
                <span style={{ color: 'var(--text)' }}>{step.guide}</span>
                {demo.lastHint && (
                  <span style={{ color: 'var(--ok)', marginLeft: 10 }}>{demo.lastHint}</span>
                )}
              </>
            )}
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {step.fillText && (
              <button
                type="button"
                onClick={() => demoActions.fillCurrentStep()}
                disabled={demo.busy}
                title="填入下方输入框（不自动发送，便于修改或亲手按 Enter）"
                style={fillBtnStyle}
              >
                ⚡ 填入
              </button>
            )}
            <button
              type="button"
              onClick={() => void demoActions.runCurrentStep()}
              disabled={demo.busy}
              title="自动演示当前步骤"
              style={runBtnStyle}
            >
              ▶ {step.autoLabel ?? '自动演示'}
            </button>
            {allDone && (
              <button
                type="button"
                onClick={() => demoActions.nextScenario()}
                style={nextCaseBtnStyle}
              >
                下一场景 →
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

const barOuter: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--accent) 42%, var(--rule))',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, var(--accent) 8%)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--accent) 22%, transparent)',
  display: 'flex',
  flexDirection: 'column',
}

const row1Style: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  minWidth: 0,
  flexWrap: 'wrap',
}

const row2Style: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 10px',
  borderTop: '1px solid var(--rule)',
  background: 'rgba(5, 8, 12, 0.35)',
  minWidth: 0,
  flexWrap: 'wrap',
}

const badgeStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.12em',
  whiteSpace: 'nowrap',
}

const caseBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  border: '1px solid var(--violet-dim)',
  background: 'rgba(139, 92, 246, 0.08)',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const stepsRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  flexWrap: 'wrap',
}

const stepPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '1px 7px',
  border: '1px solid var(--rule)',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const ctrlBtnStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  color: 'var(--muted)',
  padding: '1px 7px',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const targetTagStyle: CSSProperties = {
  border: '1px solid var(--accent-dim)',
  color: 'var(--accent)',
  fontSize: 10,
  letterSpacing: '0.08em',
  padding: '1px 6px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const guideTextStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--muted)',
  flex: '1 1 320px',
  minWidth: 0,
}

const fillBtnStyle: CSSProperties = {
  border: '1px solid var(--rule)',
  color: 'var(--text)',
  padding: '2px 9px',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const runBtnStyle: CSSProperties = {
  border: '1px solid var(--accent)',
  color: 'var(--accent)',
  background: 'rgba(34, 211, 238, 0.08)',
  padding: '2px 10px',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const nextCaseBtnStyle: CSSProperties = {
  border: '1px solid var(--ok)',
  color: 'var(--ok)',
  background: 'rgba(74, 222, 128, 0.1)',
  padding: '2px 10px',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
