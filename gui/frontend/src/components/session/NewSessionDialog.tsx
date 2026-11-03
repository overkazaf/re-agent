// [+ new] dialog — StartOptions form. In a plain browser (no Wails runtime)
// submit fails and the error renders inline instead of vanishing.
import { useState } from 'react'
import { actions, hasBackend } from '../../store/sessions'
import type { StartOptions } from '../../lib/types'
import { Btn, Dialog, fieldStyle, labelStyle } from './Dialog'

const ROLES = ['auto', 'planner', 'executor', 'researcher']
const WORKFLOWS = ['off', 'auto', 'specialist', 'caveman', 'research', 'writeup', 'ctf', 'reverse', 'engineering']

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const [workspace, setWorkspace] = useState('')
  const [role, setRole] = useState('auto')
  const [workflow, setWorkflow] = useState('auto')
  const [mock, setMock] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    const opts: StartOptions = { workspace: workspace.trim() || '.', role, workflow, mock }
    const res = await actions.createSession(opts)
    setBusy(false)
    if (res.ok) onClose()
    else setError(res.error)
  }

  return (
    <Dialog title="new session" onClose={onClose}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>workspace</span>
        <input
          style={fieldStyle}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder={hasBackend() ? '/abs/path/to/workspace（空 = 当前目录）' : '（浏览器 dev：无后端 cwd）'}
          autoFocus
        />
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
