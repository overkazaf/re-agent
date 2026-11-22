// NewSessionDialog — clean StartOptions form with quiet labels and contextual
// `data-hint` tooltips instead of multi-line helper prose.
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { actions, hasBackend } from '../../store/sessions'
import { api } from '../../lib/api'
import type { StartOptions } from '../../lib/types'
import { Btn, Dialog, fieldStyle, labelStyle } from './Dialog'
import { ProSelect, type ProSelectOption } from '../crt'
import { validateWorkspacePath } from './usabilityHelpers'
import './usability.css'

const ROLES = ['auto', 'planner', 'executor', 'researcher'] as const
const WORKFLOWS = ['off', 'auto', 'specialist', 'caveman', 'research', 'writeup', 'ctf', 'reverse', 'engineering'] as const

const ROLE_DESC: Record<string, string> = {
  auto: '按任务阶段自动路由 planner / executor / researcher',
  planner: '偏重推理规划与拆解，适合复杂样本前期架构分析',
  executor: '偏重高速工具执行与脚本取证，响应更快',
  researcher: '偏重资料检索、协议比对与深度调研',
}

const WORKFLOW_DESC: Record<string, string> = {
  off: '自由对话模式，不启用阶段状态机',
  auto: '根据目录特征与指令自动判断是否切入工作流',
  reverse: '9 阶段逆向主线：分诊 → 静动态取证 → 假设账本 → 独立审计 → Writeup',
  ctf: '面向解题提速：快速定位 flag 约束与验证脚本',
  writeup: '聚焦结构化证据溯源与报告撰写',
  specialist: '多专员协同拆解复杂目标',
  research: '偏研究型探索与文献/代码归纳',
  engineering: '常规代码工程开发与排障流程',
  caveman: '极简精炼输出，降低 token 消耗',
}

const ROLE_OPTIONS: readonly ProSelectOption[] = ROLES.map((r) => ({
  value: r,
  label: r,
  description: ROLE_DESC[r],
  badge: r === 'auto' ? 'SMART' : undefined,
}))

const WORKFLOW_GROUPS: Record<string, string> = {
  auto: 'General',
  off: 'General',
  reverse: 'Forensics & CTF',
  ctf: 'Forensics & CTF',
  writeup: 'Forensics & CTF',
  specialist: 'Specialist Modes',
  research: 'Specialist Modes',
  engineering: 'Specialist Modes',
  caveman: 'Specialist Modes',
}

const WORKFLOW_OPTIONS: readonly ProSelectOption[] = WORKFLOWS.map((w) => ({
  value: w,
  label: w,
  group: WORKFLOW_GROUPS[w],
  description: WORKFLOW_DESC[w],
  badge: w === 'reverse' ? '9-PHASE' : w === 'auto' ? 'AUTO' : undefined,
}))

const LAST_WORKSPACE_KEY = 're-gui:lastWorkspace'
const RECENT_WORKSPACES_KEY = 're-gui:recentWorkspaces'

function readRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_WORKSPACES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 4) : []
  } catch {
    return []
  }
}

function rememberWorkspace(dir: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, dir)
    const prev = readRecentWorkspaces().filter((d) => d !== dir)
    localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify([dir, ...prev].slice(0, 4)))
  } catch {
    // storage unavailable — remembering is best-effort
  }
}

async function defaultWorkspace(): Promise<string> {
  try {
    const last = localStorage.getItem(LAST_WORKSPACE_KEY)
    if (last) return last
  } catch {
    // storage unavailable
  }
  if (!hasBackend()) return ''
  try {
    return await api.homeDir()
  } catch {
    return ''
  }
}

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const [workspace, setWorkspace] = useState('')
  const [role, setRole] = useState('auto')
  const [workflow, setWorkflow] = useState('auto')
  const [mock, setMock] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent] = useState<string[]>(() => readRecentWorkspaces())

  useEffect(() => {
    void defaultWorkspace().then((dir) => {
      setWorkspace((current) => current || dir)
    })
  }, [])

  const validation = useMemo(() => validateWorkspacePath(workspace), [workspace])

  async function browse() {
    if (!hasBackend()) return
    try {
      const dir = await api.pickDirectory()
      if (dir) {
        setWorkspace(dir)
        setError(null)
      }
    } catch (err) {
      setError(String(err))
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!validation.valid || busy) return
    setBusy(true)
    setError(null)
    let dir = workspace.trim()
    if (!dir && hasBackend()) {
      try {
        dir = await api.homeDir()
      } catch {
        dir = ''
      }
    }
    const opts: StartOptions = { workspace: dir || '~', role, workflow, mock }
    const res = await actions.createSession(opts)
    setBusy(false)
    if (res.ok) {
      rememberWorkspace(res.value.workspace)
      onClose()
    } else {
      setError(res.error)
    }
  }

  return (
    <Dialog title="new session" width={480} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {/* Workspace */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={labelStyle}>workspace</span>
              <span
                className="usa-hint-dot"
                data-hint="留空自动使用 $HOME 目录（不会落到系统根目录 /），建议填写绝对路径或点击浏览"
              >
                ?
              </span>
              <span style={{ marginLeft: 'auto', color: hasBackend() ? 'var(--ok)' : 'var(--warn)', fontSize: 9.5 }}>
                {hasBackend() ? '● ready' : '○ preview'}
              </span>
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{
                  ...fieldStyle,
                  flex: 1,
                  borderColor: !validation.valid ? 'var(--err)' : undefined,
                }}
                value={workspace}
                onChange={(e) => {
                  setWorkspace(e.target.value)
                  if (error) setError(null)
                }}
                placeholder={hasBackend() ? '默认使用 $HOME（输入绝对路径或选择目录）' : '（浏览器 dev：无后端）'}
                autoFocus
              />
              <Btn type="button" onClick={browse} disabled={!hasBackend()} data-hint="选择本地工作区目录">
                browse…
              </Btn>
            </div>
          </label>

          {(!validation.valid || validation.level === 'warn') && (
            <div style={{ fontSize: 10.5, color: !validation.valid ? 'var(--err)' : 'var(--warn)' }}>
              {validation.message}
            </div>
          )}

          {recent.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>recent:</span>
              {recent.map((dir) => {
                const base = dir.split('/').filter(Boolean).pop() || dir
                return (
                  <button
                    key={dir}
                    type="button"
                    className="usa-pill"
                    data-active={workspace.trim() === dir ? 'true' : undefined}
                    onClick={() => setWorkspace(dir)}
                    data-hint={dir}
                  >
                    {base}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Role & Workflow */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={labelStyle}>role</span>
              <span className="usa-hint-dot" data-hint={ROLE_DESC[role] ?? '选择默认模型角色'}>
                ?
              </span>
            </span>
            <ProSelect
              value={role}
              options={ROLE_OPTIONS}
              onChange={setRole}
              fullWidth
              searchable={false}
              popoverMinWidth={240}
              ariaLabel="Session role"
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={labelStyle}>workflow</span>
              <span className="usa-hint-dot" data-hint={WORKFLOW_DESC[workflow] ?? '选择分析工作流'}>
                ?
              </span>
            </span>
            <ProSelect
              value={workflow}
              options={WORKFLOW_OPTIONS}
              onChange={setWorkflow}
              fullWidth
              align="right"
              popoverMinWidth={268}
              searchPlaceholder="Filter workflows…"
              ariaLabel="Session workflow"
            />
          </label>
        </div>

        {/* Mock runtime toggle */}
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
          <span>演示模式（无 API key）</span>
          <span className="usa-hint-dot" data-hint="使用本地模拟 Provider 响应，不消耗真实 API 额度">
            ?
          </span>
        </label>

        {error && (
          <div
            style={{
              color: 'var(--err)',
              fontSize: 11.5,
              whiteSpace: 'pre-wrap',
              padding: '6px 8px',
              border: '1px solid var(--err)',
              borderRadius: 'var(--radius-xs, 2px)',
              background: 'var(--err-soft, color-mix(in srgb, var(--err) 10%, var(--bg)))',
            }}
          >
            ✗ {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 2 }}>
          <span style={{ color: 'var(--faint)', fontSize: 10 }}>
            <kbd className="usa-kbd">Enter</kbd> 启动 · <kbd className="usa-kbd">Esc</kbd> 取消
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn type="button" onClick={onClose}>
              cancel
            </Btn>
            <Btn
              type="submit"
              tone="accent"
              disabled={busy || !validation.valid}
              style={{
                borderColor: 'var(--accent)',
                background: 'var(--accent-soft, color-mix(in srgb, var(--accent) 16%, transparent))',
                fontWeight: 600,
              }}
            >
              {busy ? 'starting…' : 'start session'}
            </Btn>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
