// 引导式向导（Track C）共享外壳 + 表单原语。
// 卡片语言沿用 session/Dialog.tsx 的 CRT 审美（fixed 居中 / var(--bg-panel) /
// accent-dim 边框辉光 / pushEsc），差异点：
//  - 标题栏带 ①-⑤ 步骤指示（假设 → 实验 → 验证 → 审计 → 归档）
//  - 审批门优先：目标 runtime 有 pendingApproval 时整卡降为背景
//    （pointerEvents:none + opacity .6；审批 DOM 的 z-index 更高，自然覆盖），
//    并且不注册 Esc，把栈顶让给审批卡。
import { useEffect, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { pushEsc } from '../../lib/escStack'
import { useSessionStore } from '../../store/sessions'

const STEPS = ['假设', '实验', '验证', '审计', '归档'] as const
const STEP_GLYPHS = ['①', '②', '③', '④', '⑤'] as const

export function WizardCard({
  title,
  step,
  width = 580,
  sessionId,
  onClose,
  children,
}: {
  title: string
  /** 当前步骤 1..5（hypothesis/revise=1 experiment=2 verification=3 review=4） */
  step: number
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
        style={{
          width,
          maxWidth: '92vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--accent-dim)',
          background: 'var(--bg-panel)',
          boxShadow: '0 0 26px var(--accent-dim)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 10px',
            borderBottom: '1px solid var(--rule)',
            color: 'var(--accent)',
            fontSize: 11,
            letterSpacing: '0.12em',
          }}
        >
          <span style={{ whiteSpace: 'nowrap' }}>╭─ {title} ─╮</span>
          <div style={{ display: 'flex', gap: 9, marginLeft: 'auto', alignItems: 'baseline', minWidth: 0 }}>
            {STEPS.map((label, i) => {
              const n = i + 1
              const isCur = n === step
              const isDone = n < step
              return (
                <span
                  key={label}
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    whiteSpace: 'nowrap',
                    color: isCur ? 'var(--accent)' : isDone ? 'var(--ok)' : 'var(--faint)',
                    textShadow: isCur ? '0 0 8px var(--accent-dim)' : undefined,
                    fontWeight: isCur ? 700 : 400,
                  }}
                >
                  {STEP_GLYPHS[i]} {label}
                </span>
              )
            })}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer', font: 'inherit', fontSize: 12 }}
            title="close (esc)"
          >
            ✕
          </button>
        </header>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', minHeight: 0 }}>
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
  background: 'transparent',
  border: '1px solid var(--rule)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 12,
  padding: '5px 8px',
  outline: 'none',
}

export const wizAreaStyle: CSSProperties = {
  ...wizFieldStyle,
  minHeight: 48,
  resize: 'vertical',
  lineHeight: 1.5,
}

export const wizFooterStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
}

type WizTone = 'accent' | 'ok' | 'warn' | 'err' | 'violet' | 'muted'

export function WizBtn({ tone = 'muted', ...rest }: { tone?: WizTone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      style={{
        background: 'transparent',
        border: '1px solid var(--rule)',
        color: tone === 'muted' ? 'var(--text)' : `var(--${tone})`,
        font: 'inherit',
        fontSize: 12,
        padding: '4px 12px',
        cursor: rest.disabled ? 'default' : 'pointer',
        opacity: rest.disabled ? 0.4 : 1,
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
        padding: '5px 9px',
        fontSize: 11.5,
        lineHeight: 1.45,
        border: `1px solid var(--${c})`,
        color: `var(--${c})`,
        background: 'rgba(5, 10, 16, 0.8)',
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
    fontSize: 10,
    padding: '1px 6px',
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
    background: active ? `color-mix(in srgb, var(--${tone}) 12%, transparent)` : 'rgba(5, 8, 12, 0.45)',
    padding: '7px 8px',
    cursor: 'pointer',
    font: 'inherit',
  }
}

/** 列表内多选切换 helper */
export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
