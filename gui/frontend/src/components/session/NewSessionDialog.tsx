// [+ new] dialog — StartOptions form. The workspace pre-fills from the last
// successful workspace (localStorage) or the backend's $HOME — never '.' since
// a .app launch's cwd is '/'. Browse opens the OS directory picker.
import { useEffect, useState } from 'react'
import { actions, hasBackend } from '../../store/sessions'
import { api } from '../../lib/api'
import type { StartOptions } from '../../lib/types'
import { Btn, Dialog, fieldStyle, labelStyle } from './Dialog'

const ROLES = ['auto', 'planner', 'executor', 'researcher']
const WORKFLOWS = ['off', 'auto', 'specialist', 'caveman', 'research', 'writeup', 'ctf', 'reverse', 'engineering']
const LAST_WORKSPACE_KEY = 're-gui:lastWorkspace'

async function defaultWorkspace(): Promise<string> {
  try {
    const last = localStorage.getItem(LAST_WORKSPACE_KEY)
    if (last) return last
  } catch {
    // storage unavailable — fall through to the backend default
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
  const [mock, setMock] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void defaultWorkspace().then((dir) => {
      setWorkspace((current) => current || dir)
    })
  }, [])

  async function browse() {
    if (!hasBackend()) return
    try {
      const dir = await api.pickDirectory()
      if (dir) setWorkspace(dir)
    } catch (err) {
      setError(String(err))
    }
  }

  async function submit() {
    setBusy(true)
    setError(null)
    // blank input still means $HOME (the manager would otherwise see '.' from
    // a cwd=/ launch and treat the filesystem root as the workspace)
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
      try {
        localStorage.setItem(LAST_WORKSPACE_KEY, res.value.workspace)
      } catch {
        // storage unavailable — remembering the dir is best-effort
      }
      onClose()
    } else {
      setError(res.error)
    }
  }

  return (
    <Dialog title="new session" onClose={onClose}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>workspace</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={{ ...fieldStyle, flex: 1 }}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder={hasBackend() ? '默认使用 $HOME（输入绝对路径或选择目录）' : '（浏览器 dev：无后端）'}
            autoFocus
          />
          <Btn onClick={browse} disabled={!hasBackend()} title="选择目录">
            browse…
          </Btn>
        </div>
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>role</span>
          <select style={fieldStyle} value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>workflow</span>
          <select style={fieldStyle} value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            {WORKFLOWS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
        <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
        演示模式（无 API key）
      </label>

      {error && <div style={{ color: 'var(--err)', fontSize: 12, whiteSpace: 'pre-wrap' }}>✗ {error}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn onClick={onClose}>cancel</Btn>
        <Btn tone="accent" onClick={submit} disabled={busy}>
          {busy ? 'starting…' : 'start session'}
        </Btn>
      </div>
    </Dialog>
  )
}
