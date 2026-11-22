// WizardCard — shared guided-forensics modal shell + clean form primitives.
// Tucks the step rationale (`why`) into a header `?` contextual hint pill
// (`data-hint`) so each wizard stays spacious and focused.
import { Fragment, useEffect, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { pushEsc } from '../../lib/escStack'
import { useSessionStore } from '../../store/sessions'
import '../session/usability.css'

const STEPS = [
  { label: '假设', glyph: '①', hint: '建立可证伪假设与预期输出' },
  { label: '实验', glyph: '②', hint: '由宿主实跑探针并铸造不可篡改证据 ev_NNN' },
  { label: '验证', glyph: '③', hint: 'verify_artifact 确定性重放并签发 SHA256 凭证' },
  { label: '审计', glyph: '④', hint: '引用实测证据完成审查签章或独立对抗审计' },
  { label: '归档', glyph: '⑤', hint: '闭环沉淀并聚焦全局视图' },
] as const

export function WizardCard({
  title,
  step,
  why,
  width = 580,
  sessionId,
  onClose,
  children,
}: {
  title: string
  /** 当前步骤 1..5（hypothesis/revise=1 experiment=2 verification=3 review=4） */
  step: number
  /** 简明“为什么这一步重要”提示微文案（收纳在标题栏 ? 悬浮提示中） */
  why?: string
  width?: number
  /** 审批门检测的目标 session（缺省回落到 active session） */
  sessionId?: string
  onClose: () => void
  children: ReactNode
}) {
  const { sessions, activeId } = useSessionStore()
  const rt = (sessionId ? sessions.get(sessionId) : null) ?? (activeId ? sessions.get(activeId) : null)
  const approvalUp = rt?.pendingApproval != null

  useEffect(() => {
    if (approvalUp) return
    return pushEsc(onClose)
  }, [approvalUp, onClose])

  const clampedStep = Math.max(1, Math.min(STEPS.length, step))
  const progressPct = Math.round((clampedStep / STEPS.length) * 100)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 5, 8, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 44,
        pointerEvents: approvalUp ? 'none' : undefined,
        opacity: approvalUp ? 0.6 : 1,
        transition: 'opacity 150ms',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width,
          maxWidth: '92vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border-accent, var(--accent-dim))',
          borderRadius: 'var(--radius-sm, 3px)',
          background: 'var(--surface-3, color-mix(in srgb, var(--bg) 90%, var(--bg-panel) 10%))',
          backdropFilter: 'blur(8px)',
          boxShadow: 'var(--shadow-popover, 0 14px 40px rgba(0, 0, 0, 0.56))',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 11px',
            borderBottom: '1px solid var(--border-subtle, var(--rule))',
            color: 'var(--accent)',
            fontSize: 11,
            letterSpacing: '0.08em',
          }}
        >
          <span style={{ whiteSpace: 'nowrap', fontWeight: 700 }}>╭─ {title} ─╮</span>

          {why && (
            <span
              className="usa-hint-dot"
              tabIndex={0}
              data-hint={`STEP ${clampedStep}/${STEPS.length}：${why}`}
              data-hint-side="bottom"
            >
              ?
            </span>
          )}

          <div
            style={{
              display: 'flex',
              gap: 4,
              marginLeft: 'auto',
              alignItems: 'center',
              minWidth: 0,
            }}
            aria-label={`Step ${clampedStep} of ${STEPS.length}`}
          >
            {STEPS.map((st, i) => {
              const n = i + 1
              const isCur = n === clampedStep
              const isDone = n < clampedStep
              return (
                <Fragment key={st.label}>
                  <span
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.03em',
                      whiteSpace: 'nowrap',
                      padding: isCur ? '1px 6px' : '1px 3px',
                      border: isCur ? '1px solid var(--accent)' : '1px solid transparent',
                      borderRadius: 'var(--radius-xs, 2px)',
                      background: isCur ? 'var(--accent-soft, color-mix(in srgb, var(--accent) 14%, transparent))' : 'transparent',
                      color: isCur ? 'var(--accent)' : isDone ? 'var(--ok)' : 'var(--faint)',
                      fontWeight: isCur ? 700 : 400,
                      cursor: 'help',
                    }}
                    data-hint={`${st.glyph} ${st.label} — ${st.hint}`}
                    data-hint-side="bottom"
                  >
                    {isDone ? '✓' : st.glyph}
                    {isCur ? ` ${st.label}` : ''}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span
                      style={{
                        color: isDone ? 'var(--ok)' : 'var(--border-subtle, var(--rule))',
                        fontSize: 9,
                        userSelect: 'none',
                      }}
                    >
                      ─
                    </span>
                  )}
                </Fragment>
              )
            })}
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--faint)',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12,
              padding: '0 2px',
            }}
            aria-label="关闭向导"
            data-hint="关闭向导"
            data-hint-kbd="Esc"
            data-hint-side="bottom"
          >
            ✕
          </button>
        </header>

        {/* Crisp 2px step progress rail */}
        <div style={{ height: 2, background: 'color-mix(in srgb, var(--rule) 45%, transparent)' }}>
          <div
            style={{
              height: '100%',
              width: `${progressPct}%`,
              background: 'var(--accent)',
              transition: 'width 200ms ease',
            }}
          />
        </div>

        <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

// ---------- shared form primitives ----------

export const wizLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 10.5,
  color: 'var(--muted)',
}

export const wizFieldStyle: CSSProperties = {
  width: '100%',
  background: 'var(--surface-1, color-mix(in srgb, var(--bg) 55%, transparent))',
  border: '1px solid var(--border-subtle, var(--rule))',
  borderRadius: 'var(--radius-xs, 2px)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12,
  padding: '5px 8px',
  outline: 'none',
}

export const wizAreaStyle: CSSProperties = {
  ...wizFieldStyle,
  minHeight: 50,
  resize: 'vertical',
  lineHeight: 1.5,
}

export const wizFooterStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
  paddingTop: 6,
  borderTop: '1px solid var(--border-subtle, var(--rule))',
}

type WizTone = 'accent' | 'ok' | 'warn' | 'err' | 'violet' | 'muted'

export function WizBtn({ tone = 'muted', ...rest }: { tone?: WizTone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const isPrimary = tone !== 'muted'
  return (
    <button
      {...rest}
      style={{
        background: isPrimary ? `color-mix(in srgb, var(--${tone}) 16%, transparent)` : 'transparent',
        border: `1px solid ${isPrimary ? `var(--${tone})` : 'var(--border-subtle, var(--rule))'}`,
        borderRadius: 'var(--radius-xs, 2px)',
        color: isPrimary ? `var(--${tone})` : 'var(--muted)',
        fontWeight: isPrimary ? 600 : 400,
        font: 'inherit',
        fontSize: 12,
        padding: isPrimary ? '5px 13px' : '5px 10px',
        cursor: rest.disabled ? 'default' : 'pointer',
        opacity: rest.disabled ? 0.42 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        ...rest.style,
      }}
    />
  )
}

export function WizBanner({ tone, text }: { tone: 'ok' | 'err' | 'info'; text: string }) {
  const c = tone === 'err' ? 'err' : tone === 'ok' ? 'ok' : 'accent'
  return (
    <div
      style={{
        padding: '6px 9px',
        fontSize: 11.5,
        lineHeight: 1.45,
        border: `1px solid var(--${c})`,
        borderRadius: 'var(--radius-xs, 2px)',
        color: `var(--${c})`,
        background: `color-mix(in srgb, var(--${c}) 10%, var(--surface-1, var(--bg)))`,
      }}
    >
      {tone === 'err' ? '✗ ' : tone === 'ok' ? '✓ ' : '◈ '}
      {text}
    </div>
  )
}

/** Multi-select chip (evidence citation / verdict) */
export function chipToneStyle(active: boolean, tone: 'ok' | 'err' | 'warn' | 'violet' | 'accent'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--border-subtle, var(--rule))'}`,
    borderRadius: 'var(--radius-xs, 2px)',
    background: active ? `color-mix(in srgb, var(--${tone}) 14%, transparent)` : 'var(--surface-1, transparent)',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 10.5,
    padding: '2px 7px',
    cursor: 'pointer',
    font: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  }
}

/** Selectable option card (experiment type / review mode) */
export function wizSelectCardStyle(active: boolean, tone: 'accent' | 'violet'): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    alignItems: 'flex-start',
    textAlign: 'left',
    border: `1px solid ${active ? `var(--${tone})` : 'var(--border-subtle, var(--rule))'}`,
    borderRadius: 'var(--radius-xs, 2px)',
    background: active ? `color-mix(in srgb, var(--${tone}) 12%, transparent)` : 'var(--surface-1, transparent)',
    padding: '7px 9px',
    cursor: 'pointer',
    font: 'inherit',
  }
}

/** Toggle string id in list */
export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
