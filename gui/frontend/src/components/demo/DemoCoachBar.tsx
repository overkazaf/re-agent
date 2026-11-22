// DemoCoachBar — ultra-clean single-line interactive walkthrough ribbon (~34px)
// mounted beneath TopBar while Demo Sandbox mode is active. Verbose per-step
// coaching copy is tucked into contextual hover hints (`data-hint`) and an
// optional click-to-pin detail strip so the workbench canvas stays calm.
import { useState, type CSSProperties } from 'react'
import { DEMO_SCENARIOS, getScenario } from '../../demo/scenarios'
import { demoActions, useDemoStore } from '../../demo/store'
import { GlowText } from '../crt'
import '../session/usability.css'

export function DemoCoachBar({
  graphOpen = false,
  onToggleGraph,
}: {
  graphOpen?: boolean
  onToggleGraph?: () => void
}) {
  const demo = useDemoStore()
  const [guideOpen, setGuideOpen] = useState(false)

  if (!demo.active) return null

  const scenario = getScenario(demo.scenarioId)
  const step = scenario.steps[demo.stepIndex] ?? scenario.steps[0]
  const doneCount = scenario.steps.filter((st) => demo.completedSteps[`${scenario.id}:${st.id}`]).length
  const allDone = doneCount === scenario.steps.length
  const stepDone = Boolean(demo.completedSteps[`${scenario.id}:${step.id}`])
  const progressPct = scenario.steps.length > 0 ? Math.round((doneCount / scenario.steps.length) * 100) : 0

  const stepHint = `${demo.stepIndex + 1}/${scenario.steps.length} · ${step.title} (${step.target}) — ${step.guide}`

  return (
    <div className="usa-coach-bar">
      <div className="usa-coach-ribbon" data-collapsed={demo.collapsed ? 'true' : undefined}>
        {/* Left: DEMO badge + CASE selector + compact numbered step pills */}
        <span style={badgeStyle}>
          <GlowText tone="accent">◈ DEMO</GlowText>
        </span>

        <button
          type="button"
          onClick={() => demoActions.setLauncherOpen(true)}
          className="usa-coach-case-btn"
          data-hint={`${scenario.title} — ${scenario.summary}（点击切换 5 个演示场景）`}
          data-hint-side="bottom"
        >
          <span style={{ color: 'var(--violet)', fontWeight: 700 }}>
            CASE {scenario.index}/{DEMO_SCENARIOS.length}
          </span>
          <span style={{ color: 'var(--faint)', fontSize: 9.5 }}>▾</span>
        </button>

        {!demo.collapsed && (
          <div className="usa-coach-steps" role="group" aria-label="Demo scenario steps">
            {scenario.steps.map((st, idx) => {
              const done = Boolean(demo.completedSteps[`${scenario.id}:${st.id}`])
              const current = idx === demo.stepIndex
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => demoActions.setStepIndex(idx)}
                  className="usa-coach-step-dot"
                  data-state={current ? 'current' : done ? 'done' : 'idle'}
                  aria-label={`${idx + 1}.${st.title}`}
                  aria-current={current ? 'step' : undefined}
                  data-hint={`${idx + 1}. ${st.title} (${st.target}) — ${st.guide}`}
                  data-hint-side="bottom"
                >
                  {done ? '✓' : idx + 1}
                </button>
              )
            })}
          </div>
        )}

        {/* Center: concise current-step title + subtle ? hint chip */}
        <span
          className="usa-coach-title"
          data-hint={stepDone && demo.lastHint ? demo.lastHint : stepHint}
          data-hint-side="bottom"
        >
          <span style={{ color: stepDone ? 'var(--ok)' : 'var(--text)', fontWeight: 500 }}>
            {stepDone ? '✓ ' : ''}
            {step.title}
          </span>
          {!demo.collapsed && (
            <span style={{ color: 'var(--faint)', marginLeft: 6, fontSize: 10.5 }}>
              {step.target}
            </span>
          )}
        </span>

        {!demo.collapsed && (
          <button
            type="button"
            className="usa-hint-dot"
            data-active={guideOpen ? 'true' : undefined}
            onClick={() => setGuideOpen((v) => !v)}
            aria-label="步骤说明"
            aria-expanded={guideOpen}
            data-hint={step.guide}
            data-hint-side="bottom"
          >
            ?
          </button>
        )}

        {/* Right: crisp CTA buttons + compact utility controls */}
        {!demo.collapsed && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            {step.fillText && (
              <button
                type="button"
                onClick={() => demoActions.fillCurrentStep()}
                disabled={demo.busy}
                className="usa-coach-btn"
                data-hint="将示例指令填入输入框（不自动发送，便于修改后亲手按 Enter）"
                data-hint-side="bottom"
              >
                ⚡ 填入
              </button>
            )}
            <button
              type="button"
              onClick={() => void demoActions.runCurrentStep()}
              disabled={demo.busy}
              className="usa-coach-btn"
              data-variant="primary"
              data-hint={`自动执行当前步骤：${step.title}`}
              data-hint-side="bottom"
            >
              ▶ {step.autoLabel ?? '自动演示'}
            </button>
            {allDone && (
              <button
                type="button"
                onClick={() => demoActions.nextScenario()}
                className="usa-coach-btn"
                data-variant="next"
                data-hint="进入下一个演示场景"
                data-hint-side="bottom"
              >
                下一场景 →
              </button>
            )}
          </span>
        )}

        <span style={sepStyle} />

        {onToggleGraph && !demo.collapsed && (
          <button
            type="button"
            onClick={onToggleGraph}
            className="usa-coach-btn"
            data-hint="切换协同机制图谱 / 五维仪表盘"
            data-hint-side="bottom"
            style={{
              borderColor: graphOpen ? 'var(--accent)' : 'color-mix(in srgb, var(--violet) 48%, var(--rule))',
              color: graphOpen ? 'var(--accent)' : 'var(--violet)',
            }}
          >
            {graphOpen ? '▣ 仪表' : '◈ 图谱'}
          </button>
        )}

        <button
          type="button"
          onClick={() => void demoActions.resetScenario()}
          disabled={demo.busy}
          className="usa-coach-btn"
          aria-label="重置演示场景"
          data-hint="重置当前演示场景到初始状态"
          data-hint-side="bottom"
          style={{ padding: '2px 6px' }}
        >
          ↻
        </button>

        <button
          type="button"
          onClick={() => demoActions.toggleCollapsed()}
          className="usa-coach-btn"
          aria-label={demo.collapsed ? '展开演示指引' : '收起演示指引'}
          data-hint={demo.collapsed ? '展开步骤与操作按钮' : '收起为极简状态条'}
          data-hint-side="bottom"
          style={{ padding: '2px 6px' }}
        >
          {demo.collapsed ? '▾' : '▴'}
        </button>

        {!demo.isStandaloneBrowser ? (
          <button
            type="button"
            onClick={() => demoActions.exitDemo()}
            className="usa-coach-btn"
            data-variant="warn"
            data-hint="退出演示沙盒并恢复真实桌面会话"
            data-hint-side="bottom"
          >
            ✕ 退出
          </button>
        ) : (
          <span
            style={sandboxTagStyle}
            data-hint="浏览器内存沙盒模式：无需 API Key、不触碰本地文件"
            data-hint-side="bottom"
          >
            WEB SANDBOX
          </span>
        )}
      </div>

      {/* Optional click-to-pin 1-line guidance strip (collapsed by default) */}
      {!demo.collapsed && guideOpen && (
        <div className="usa-coach-detail">
          <span style={{ color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {demo.stepIndex + 1}/{scenario.steps.length}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            {step.guide}
            {demo.lastHint && (
              <span style={{ color: 'var(--ok)', marginLeft: 8 }}>{demo.lastHint}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setGuideOpen(false)}
            aria-label="收起步骤说明"
            style={{ color: 'var(--faint)', fontSize: 10.5, cursor: 'pointer', padding: '0 3px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Subtle 2px scenario progress rail */}
      <div style={{ height: 2, background: 'color-mix(in srgb, var(--rule) 45%, transparent)', width: '100%' }}>
        <div
          style={{
            height: '100%',
            width: `${progressPct}%`,
            background: allDone ? 'var(--ok)' : 'var(--accent)',
            transition: 'width 240ms ease',
          }}
        />
      </div>
    </div>
  )
}

const badgeStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.1em',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const sepStyle: CSSProperties = {
  width: 1,
  height: 14,
  background: 'var(--border-subtle, var(--rule))',
  flexShrink: 0,
}

const sandboxTagStyle: CSSProperties = {
  color: 'var(--faint)',
  fontSize: 9.5,
  letterSpacing: '0.07em',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  cursor: 'help',
}
