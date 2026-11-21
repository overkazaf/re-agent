// 引导式向导（Track C）共享外壳 + 表单原语。
// 卡片语言沿用 session/Dialog.tsx 的 CRT 审美（fixed 居中 / var(--bg-panel) /
// accent-dim 边框辉光 / pushEsc），升级：
//  - 标题栏带 ①-⑤ 连接式步骤进度条（假设 → 实验 → 验证 → 审计 → 归档）
//  - 可选 `why` 微文案条，解释本步在取证闭环中的意义
//  - WizBtn 明确区分主操作 CTA（tone=accent 高亮填充）与次操作（ghost outline）
//  - 审批门优先：目标 runtime 有 pendingApproval 时整卡降为背景并让出 Esc 栈顶。
import { Fragment, useEffect, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { pushEsc } from '../../lib/escStack'
import { useSessionStore } from '../../store/sessions'
import '../session/usability.css'

const STEPS = ['假设', '实验', '验证', '审计', '归档'] as const
const STEP_GLYPHS = ['①', '②', '③', '④', '⑤'] as const

export function WizardCard({
  title,
  step,
  why,
  width = 600,
  sessionId,
  onClose,
  children,
}: {
  title: string
  /** 当前步骤 1..5（hypothesis/revise=1 experiment=2 verification=3 review=4） */
  step: number
  /** 简明“为什么这一步重要”提示微文案 */
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
        background: 'rgba(2, 5, 8, 0.72)',
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
          border: '1px solid var(--accent-dim)',
          background: 'var(--surface-3, color-mix(in srgb, var(--bg) 90%, var(--bg-panel) 10%))',
          backdropFilter: 'blur(8px)',
          boxShadow: '0 0 26px var(--accent-dim)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            borderBottom: '1px solid var(--rule)',
            color: 'var(--accent)',
            fontSize: 11,
            letterSpacing: '0.1em',
          }}
        >
          <span style={{ whiteSpace: 'nowrap', fontWeight: 700 }}>╭─ {title} ─╮</span>

          <div
            style={{
              display: 'flex',
              gap: 4,
              marginLeft: 'auto',
              alignItems: 'center',
              minWidth: 0,
              flexWrap: 'wrap',
            }}
            aria-label={`Step ${clampedStep} of ${STEPS.length}`}
          >
            {STEPS.map((label, i) => {
              const n = i + 1
              const isCur = n === clampedStep
              const isDone = n < clampedStep
              return (
                <Fragment key={label}>
                  <span
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.04em',
                      whiteSpace: 'nowrap',
                      padding: isCur ? '1px 6px' : '1px 2px',
                      border: isCur ? '1px solid var(--accent)' : '1px solid transparent',
                      background: isCur ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
                      color: isCur ? 'var(--accent)' : isDone ? 'var(--ok)' : 'var(--faint)',
                      textShadow: isCur ? '0 0 8px var(--accent-dim)' : undefined,
                      fontWeight: isCur ? 700 : 400,
                    }}
                  >
                    {isDone ? '✓' : STEP_GLYPHS[i]} {label}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span
                      style={{
                        color: isDone ? 'var(--ok)' : 'var(--rule)',
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
            title="close (esc)"
          >
            ✕
          </button>
        </header>

        {/* Crisp 2px step progress rail */}
        <div style={{ height: 2, background: 'color-mix(in srgb, var(--rule) 55%, transparent)' }}>
          <div
            style={{
              height: '100%',
              width: `${progressPct}%`,
              background: 'var(--accent)',
              transition: 'width 200ms ease',
            }}
          />
        </div>

        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', minHeight: 0 }}>
          {why && (
            <div className="usa-wiz-why">
              <span style={{ color: 'var(--accent)', fontWeight: 600, marginRight: 6 }}>
                STEP {clampedStep}/{STEPS.length} · 为什么这一步重要
              </span>
              <span>{why}</span>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}

// ---------- 各向导步骤共用的表单原语（形态对齐 Dialog.tsx / Workbench） ----------

export const wizLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  fontSize: 10.5,
  color: 'var(--muted)',
}

export const wizFieldStyle: CSSProperties = {
  width: '100%',
  background: 'color-mix(in srgb, var(--bg) 55%, transparent)',
  border: '1px solid var(--rule)',
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
  paddingTop: 4,
  borderTop: '1px solid color-mix(in srgb, var(--rule) 65%, transparent)',
}

type WizTone = 'accent' | 'ok' | 'warn' | 'err' | 'violet' | 'muted'

export function WizBtn({ tone = 'muted', ...rest }: { tone?: WizTone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const isPrimary = tone !== 'muted'
  return (
    <button
      {...rest}
      style={{
        background: isPrimary ? `color-mix(in srgb, var(--${tone}) 18%, transparent)` : 'transparent',
        border: `1px solid ${isPrimary ? `var(--${tone})` : 'var(--rule)'}`,
        color: isPrimary ? `var(--${tone})` : 'var(--muted)',
        fontWeight: isPrimary ? 600 : 400,
        boxShadow: isPrimary ? `0 0 10px color-mix(in srgb, var(--${tone}) 22%, transparent)` : undefined,
        font: 'inherit',
        fontSize: 12,
        padding: isPrimary ? '5px 14px' : '5px 11px',
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
        color: `var(--${c})`,
        background: `color-mix(in srgb, var(--${c}) 10%, var(--bg))`,
      }}
    >
      {tone === 'err' ? '✗ ' : tone === 'ok' ? '✓ ' : '◈ '}
      {text}
    </div>
  )
}

/** 多选 chip（证据挂靠 / 裁定选择等） */
export function chipToneStyle(active: boolean, tone: 'ok' | 'err' | 'warn' | 'violet' | 'accent'): CSSProperties {
  return {
    border: `1px solid ${active ? `var(--${tone})` : 'var(--rule)'}`,
    background: active ? `color-mix(in srgb, var(--${tone}) 16%, transparent)` : 'rgba(5, 8, 12, 0.6)',
    color: active ? `var(--${tone})` : 'var(--muted)',
    fontSize: 10.5,
    padding: '2px 7px',
    cursor: 'pointer',
    font: 'inherit',
  }
}

/** 单选卡片（实验类型 / 审查模式） */
export function wizSelectCardStyle(active: boolean, tone: 'accent' | 'violet'): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    alignItems: 'flex-start',
    textAlign: 'left',
    border: `1px solid ${active ? `var(--${tone})` : 'var(--rule)'}`,
    background: active ? `color-mix(in srgb, var(--${tone}) 14%, transparent)` : 'rgba(5, 8, 12, 0.45)',
    boxShadow: active ? `0 0 10px color-mix(in srgb, var(--${tone}) 20%, transparent)` : undefined,
    padding: '7px 9px',
    cursor: 'pointer',
    font: 'inherit',
  }
}

/** 列表内多选切换 helper */
export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
