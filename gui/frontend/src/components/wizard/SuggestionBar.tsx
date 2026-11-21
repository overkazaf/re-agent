// HUD 建议条 — 消费 scene store 的 suggestion，一键进入对应向导步骤。
// 常驻细条（Task D 摆放在 TopBar 下沿 / banner 槽）；action.kind === 'none'
// 或已 dismissed 时不渲染。「去处理 →」按 action kind 映射 openWizard + setFocus，
// ✕ 调 dismissSuggestion。sessionId 取当前 active session。
import type { CSSProperties } from 'react'
import type { ZoneKey } from '../../three/contract'
import { sceneActions, useSceneStore } from '../../store/scene'
import { useSessionStore } from '../../store/sessions'

export function SuggestionBar() {
  const { suggestion, suggestionDismissed } = useSceneStore()
  const { activeId } = useSessionStore()

  if (suggestion.action.kind === 'none' || suggestionDismissed || !activeId) return null

  const sessionId = activeId // 闭包内使用非空收窄后的引用
  const a = suggestion.action
  const targetZone: ZoneKey =
    a.kind === 'new-hypothesis'
      ? 'HYP'
      : a.kind === 'configure-experiment'
        ? 'EXP'
        : a.kind === 'run-verification'
          ? 'VER'
          : 'AUD'

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
    sceneActions.setFocus({ kind: 'zone', zone: targetZone })
  }

  return (
    <div style={barStyle}>
      <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 11 }}>▸</span>
      <span
        style={{
          color: 'var(--text)',
          fontSize: 11,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {suggestion.text}
      </span>
      <button type="button" onClick={go} style={goBtnStyle}>
        去处理 →
      </button>
      <button type="button" onClick={sceneActions.dismissSuggestion} style={xBtnStyle} title="本次忽略">
        ✕
      </button>
    </div>
  )
}

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 10px',
  border: '1px solid var(--accent-dim)',
  background: 'var(--bg-panel)',
  boxShadow: '0 0 12px var(--accent-dim)',
}

const goBtnStyle: CSSProperties = {
  border: '1px solid var(--accent)',
  background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
  color: 'var(--accent)',
  fontSize: 10.5,
  padding: '1px 9px',
  cursor: 'pointer',
  font: 'inherit',
  whiteSpace: 'nowrap',
}

const xBtnStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--faint)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  padding: '0 2px',
}
