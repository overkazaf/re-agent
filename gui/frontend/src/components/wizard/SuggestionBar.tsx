// SuggestionBar — quiet, breathable single-line forensic next-step strip.
// Consumes scene store's suggestion and opens the matching wizard stage in one click.
import type { CSSProperties } from 'react'
import type { ZoneKey } from '../../three/contract'
import { sceneActions, useSceneStore } from '../../store/scene'
import { useSessionStore } from '../../store/sessions'
import '../session/usability.css'

const ZONE_META: Record<
  'HYP' | 'EXP' | 'VER' | 'AUD',
  { label: string; tone: 'accent' | 'warn' | 'ok' | 'violet'; why: string }
> = {
  HYP: {
    label: '① HYP',
    tone: 'accent',
    why: '建立可证伪假设与预期输出，作为后续取证与反证折半的基准。',
  },
  EXP: {
    label: '② EXP',
    tone: 'warn',
    why: '由宿主实跑可证伪实验并铸造不可篡改证据 ev_NNN。',
  },
  VER: {
    label: '③ VER',
    tone: 'ok',
    why: '运行 verify_artifact 确定性重放并计算 SHA256，解锁审计门禁。',
  },
  AUD: {
    label: '④ AUD',
    tone: 'violet',
    why: '引用实测证据完成审查签章或独立对抗审计，形成零幻觉闭环。',
  },
}

export function SuggestionBar() {
  const { suggestion, suggestionDismissed } = useSceneStore()
  const { activeId } = useSessionStore()

  if (suggestion.action.kind === 'none' || suggestionDismissed || !activeId) return null

  const sessionId = activeId
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
          letterSpacing: '0.07em',
          padding: '1px 6px',
          border: `1px solid color-mix(in srgb, var(--${meta.tone}) 55%, var(--rule))`,
          borderRadius: 'var(--radius-xs, 2px)',
          color: `var(--${meta.tone})`,
          background: `color-mix(in srgb, var(--${meta.tone}) 10%, transparent)`,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
        data-hint={meta.why}
        data-hint-side="bottom"
      >
        {meta.label}
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
        data-hint={suggestion.text}
        data-hint-side="bottom"
      >
        {suggestion.text}
      </span>

      <span
        className="usa-hint-dot"
        tabIndex={0}
        data-hint={`推荐原因：${meta.why}`}
        data-hint-side="bottom"
      >
        ?
      </span>

      <button
        type="button"
        onClick={go}
        className="usa-suggestion-cta"
        data-hint="打开对应阶段的取证向导"
        data-hint-side="bottom"
      >
        去处理 →
      </button>

      <button
        type="button"
        onClick={sceneActions.dismissSuggestion}
        style={xBtnStyle}
        data-hint="本次会话忽略此建议"
        data-hint-side="bottom"
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
  flexShrink: 0,
}
