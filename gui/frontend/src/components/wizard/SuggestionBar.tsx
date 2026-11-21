// HUD 建议条 — 消费 scene store 的 suggestion，一键进入对应向导步骤。
// 常驻细条（摆放在 TopBar 下沿 / banner 槽）；action.kind === 'none'
// 或已 dismissed 时不渲染。带清晰阶段标签（HYP/EXP/VER/AUD）与高对比度
// 主 CTA（「去处理 →」），✕ 调 dismissSuggestion。
import type { CSSProperties } from 'react'
import type { ZoneKey } from '../../three/contract'
import { sceneActions, useSceneStore } from '../../store/scene'
import { useSessionStore } from '../../store/sessions'
import '../session/usability.css'

const ZONE_META: Record<'HYP' | 'EXP' | 'VER' | 'AUD', { label: string; tone: 'accent' | 'warn' | 'ok' | 'violet' }> = {
  HYP: { label: '① HYP', tone: 'accent' },
  EXP: { label: '② EXP', tone: 'warn' },
  VER: { label: '③ VER', tone: 'ok' },
  AUD: { label: '④ AUD', tone: 'violet' },
}

export function SuggestionBar() {
  const { suggestion, suggestionDismissed } = useSceneStore()
  const { activeId } = useSessionStore()

  if (suggestion.action.kind === 'none' || suggestionDismissed || !activeId) return null

  const sessionId = activeId // 闭包内使用非空收窄后的引用
  const a = suggestion.action
  const targetZone: 'HYP' | 'EXP' | 'VER' | 'AUD' =
    a.kind === 'new-hypothesis'
      ? 'HYP'
      : a.kind === 'configure-experiment'
        ? 'EXP'
        : a.kind === 'run-verification'
          ? 'VER'
          : 'AUD'
  const meta = ZONE_META[targetZone]

  function go() {
    if (a.kind === 'new-hypothesis') {
      sceneActions.openWizard({ sessionId, stage: 'hypothesis' })
    } else if (a.kind === 'configure-experiment') {
      sceneActions.openWizard({ sessionId, stage: 'experiment', hypId: a.hypId })
    } else if (a.kind === 'run-verification') {
      sceneActions.openWizard({ sessionId, stage: 'verification', hypId: a.hypId, artifact: a.artifact })
    } else if (a.kind === 'submit-review') {
      sceneActions.openWizard({ sessionId, stage: 'review', hypId: a.hypId })
    }
    sceneActions.setFocus({ kind: 'zone', zone: targetZone as ZoneKey })
  }

  return (
    <div className="usa-suggestion-bar" role="region" aria-label="Recommended next forensic step">
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          padding: '1px 6px',
          border: `1px solid var(--${meta.tone})`,
          color: `var(--${meta.tone})`,
          background: `color-mix(in srgb, var(--${meta.tone}) 14%, transparent)`,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {meta.label}
      </span>
      <span
        style={{
          color: 'var(--faint)',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        next
      </span>
      <span
        style={{
          color: 'var(--text)',
          fontSize: 11.5,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={suggestion.text}
      >
        {suggestion.text}
      </span>
      <button type="button" onClick={go} className="usa-suggestion-cta">
        去处理 →
      </button>
      <button
        type="button"
        onClick={sceneActions.dismissSuggestion}
        style={xBtnStyle}
        title="本次会话忽略此建议"
        aria-label="Dismiss suggestion"
      >
        ✕
      </button>
    </div>
  )
}

const xBtnStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--faint)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  padding: '0 3px',
}
