// RE sample-type + starter-prompt picker — the GUI-native replacement for the
// terminal /workflow reverse picker. Confirm sends the argument form
// ("/workflow reverse <key>") through SendCommand, then the chosen prompt
// through SendPrompt; both failures surface inline and keep the dialog open.
import { useEffect, useState, type CSSProperties } from 'react'
import { api } from '../../lib/api'
import type { RESampleType } from '../../lib/types'
import { actions } from '../../store/sessions'
import { Btn, Dialog, fieldStyle, labelStyle } from '../session/Dialog'

const gridItem = (selected: boolean): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '8px 10px',
  border: `1px solid ${selected ? 'var(--violet)' : 'var(--border-subtle)'}`,
  borderRadius: 'var(--radius-xs)',
  background: selected ? 'var(--violet-soft)' : 'color-mix(in srgb, var(--surface-2) 45%, transparent)',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
})

export function REPickerDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [types, setTypes] = useState<RESampleType[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [picked, setPicked] = useState<RESampleType | null>(null)
  // -1 = no starter prompt (the reverse session starts bare); -2 = custom
  const [promptIdx, setPromptIdx] = useState(-1)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .reSampleTypes()
      .then((res) => {
        if (alive) setTypes(res)
      })
      .catch((err) => {
        if (alive) setLoadError(String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  async function confirm() {
    if (!picked || busy) return
    const starter =
      promptIdx === -2 ? custom.trim() : promptIdx >= 0 ? picked.prompts[promptIdx].full : ''
    if (promptIdx === -2 && !starter) {
      setSendError('custom starter prompt is empty')
      return
    }
    setBusy(true)
    setSendError(null)
    const res = await actions.sendCommand(sessionId, `/workflow reverse ${picked.key}`)
    if (!res.ok || !res.value.ok) {
      setBusy(false)
      setSendError(res.ok ? noticeError(res.value) : res.error)
      return
    }
    if (starter) {
      const sent = await actions.sendPrompt(sessionId, starter)
      if (!sent.ok) {
        // the session IS in reverse mode already — close, the notice/toast said why
        setBusy(false)
        setSendError(sent.error)
        return
      }
    }
    onClose()
  }

  return (
    <Dialog title="RE workflow — pick sample" accent="violet" width={560} onClose={onClose}>
      {!picked &&
        (loadError ? (
          <div style={{ color: 'var(--err)', fontSize: 12 }}>
            ✗ sample types unavailable: {loadError}
          </div>
        ) : !types ? (
          <div style={{ color: 'var(--faint)', fontSize: 12 }}>loading sample types…</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={labelStyle}>sample type — {types.length} kinds</span>
              <span
                className="re-hint-dot"
                data-hint="也可直接在输入框执行 /workflow reverse <type> 跳过此选择弹窗"
              >
                ?
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
              {types.map((st) => (
                <button
                  key={st.key}
                  type="button"
                  style={gridItem(false)}
                  onClick={() => setPicked(st)}
                  data-hint={`命令行快捷方式：/workflow reverse ${st.key}`}
                >
                  <span style={{ color: 'var(--violet)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>
                    {st.label}
                  </span>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>{st.desc}</span>
                  <span className="re-mono-num" style={{ color: 'var(--faint)', fontSize: 10 }}>{st.key}</span>
                </button>
              ))}
            </div>
          </>
        ))}

      {picked && (
        <>
          <div style={labelStyle}>
            starter prompt — {picked.label} ({picked.key})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button
              style={{ ...gridItem(promptIdx === -1), flexDirection: 'row' }}
              onClick={() => setPromptIdx(-1)}
            >
              <span style={{ color: promptIdx === -1 ? 'var(--violet)' : 'var(--faint)', fontSize: 12 }}>
                ○ 不用起始 prompt — 自己描述任务
              </span>
            </button>
            {picked.prompts.map((p, i) => (
              <button
                key={p.short}
                style={{ ...gridItem(promptIdx === i), flexDirection: 'row' }}
                onClick={() => setPromptIdx(i)}
              >
                <span style={{ color: promptIdx === i ? 'var(--violet)' : 'var(--text)', fontSize: 12 }}>
                  {promptIdx === i ? '◉' : '○'} {p.short}
                </span>
              </button>
            ))}
            <button
              style={{ ...gridItem(promptIdx === -2), flexDirection: 'row' }}
              onClick={() => setPromptIdx(-2)}
            >
              <span style={{ color: promptIdx === -2 ? 'var(--violet)' : 'var(--faint)', fontSize: 12 }}>
                {promptIdx === -2 ? '◉' : '○'} 自定义…
              </span>
            </button>
            {promptIdx === -2 && (
              <textarea
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                rows={3}
                placeholder="自定义起始 prompt"
                spellCheck={false}
                style={{ ...fieldStyle, resize: 'vertical' }}
                autoFocus
              />
            )}
          </div>
          {sendError && <div style={{ color: 'var(--err)', fontSize: 12 }}>✗ {sendError}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn
              onClick={() => {
                setPicked(null)
                setPromptIdx(-1)
                setCustom('')
                setSendError(null)
              }}
            >
              ← back
            </Btn>
            <Btn tone="violet" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'starting…' : 'start RE session'}
            </Btn>
          </div>
        </>
      )}
    </Dialog>
  )
}

// SendCommand OK-transport but command-error shape: the error notice text.
function noticeError(result: { ok: boolean; notices: { level: string; text: string }[] }): string {
  const err = result.notices.find((n) => n.level === 'error')
  return err ? err.text : 'command failed'
}
