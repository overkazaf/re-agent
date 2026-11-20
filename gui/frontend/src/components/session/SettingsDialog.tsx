// ⚙ settings dialog — the active session's live config. Provider routes
// persist through the same SaveUIPrefs path as the terminal /planner
// /executor /researcher commands; maxTurns is session-local (no prefs slot).
// Provider detail (model/type) is read-only — API keys never cross the bridge.
import { useEffect, useState } from 'react'
import { hasBackend } from '../../store/sessions'
import { api } from '../../lib/api'
import type { SettingsDTO, SettingsPatch } from '../../lib/types'
import { Btn, Dialog, fieldStyle, labelStyle } from './Dialog'

// '' = auto routing (the backend's empty-string default), rendered as "auto"
const AUTO = ''

function routeSelect(
  value: string,
  names: string[],
  onChange: (v: string) => void,
): React.ReactNode {
  return (
    <select style={fieldStyle} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={AUTO}>auto</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

export function SettingsDialog({
  sessionId,
  sessionName,
  onClose,
}: {
  sessionId: string
  sessionName: string
  onClose: () => void
}) {
  const [settings, setSettings] = useState<SettingsDTO | null>(null)
  const [planner, setPlanner] = useState(AUTO)
  const [executor, setExecutor] = useState(AUTO)
  const [researcher, setResearcher] = useState(AUTO)
  const [auditor, setAuditor] = useState(AUTO)
  const [maxTurns, setMaxTurns] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!hasBackend()) {
      setLoadError('浏览器 dev：无后端')
      return
    }
    api
      .getSettings(sessionId)
      .then((s) => {
        setSettings(s)
        setPlanner(s.plannerProvider)
        setExecutor(s.executorProvider)
        setResearcher(s.researcherProvider)
        setAuditor(s.auditProvider ?? '')
        setMaxTurns(s.maxTurns)
      })
      .catch((err) => setLoadError(String(err)))
  }, [sessionId])

  async function save() {
    if (!settings) return
    setBusy(true)
    setSaveError(null)
    setSaved(false)
    const patch: SettingsPatch = {
      plannerProvider: planner,
      executorProvider: executor,
      researcherProvider: researcher,
      auditProvider: auditor === '' && (settings.auditProvider ?? '') !== '' ? 'auto' : auditor,
      // 0 = leave unchanged; the backend validates 1..200 otherwise
      maxTurns: maxTurns === settings.maxTurns ? 0 : maxTurns,
    }
    try {
      await api.setSettings(sessionId, patch)
      setSaved(true)
    } catch (err) {
      setSaveError(String(err))
    }
    setBusy(false)
  }

  return (
    <Dialog title="config" width={560} onClose={onClose}>
      {!settings ? (
        <div style={{ color: loadError ? 'var(--err)' : 'var(--faint)', fontSize: 12, padding: '8px 0' }}>
          {loadError ? `✗ ${loadError}` : 'loading…'}
        </div>
      ) : (
        <>
          <div style={{ color: 'var(--faint)', fontSize: 11, lineHeight: 1.8 }}>
            session <span style={{ color: 'var(--accent)' }}>{sessionName}</span>
            <span style={{ margin: '0 6px' }}>·</span>role {settings.role}
            <span style={{ margin: '0 6px' }}>·</span>compaction {settings.compactionStrategy || 'summary'}
            <span style={{ margin: '0 6px' }}>·</span>mcp {settings.mcpServerCount}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '6px 8px',
                border: '1px solid color-mix(in srgb, var(--accent) 42%, var(--rule))',
                background: 'rgba(6, 14, 24, 0.5)',
              }}
            >
              <span style={{ ...labelStyle, color: 'var(--accent)' }}>planner · 规划与假设建模 (/planner)</span>
              {routeSelect(planner, settings.providerNames, setPlanner)}
            </label>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '6px 8px',
                border: '1px solid color-mix(in srgb, var(--ok) 42%, var(--rule))',
                background: 'rgba(6, 18, 14, 0.45)',
              }}
            >
              <span style={{ ...labelStyle, color: 'var(--ok)' }}>executor · 工具取证与重放 (/executor)</span>
              {routeSelect(executor, settings.providerNames, setExecutor)}
            </label>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '6px 8px',
                border: '1px solid color-mix(in srgb, var(--warn) 42%, var(--rule))',
                background: 'rgba(20, 14, 6, 0.45)',
              }}
            >
              <span style={{ ...labelStyle, color: 'var(--warn)' }}>researcher · 知识库与调研 (/researcher)</span>
              {routeSelect(researcher, settings.providerNames, setResearcher)}
            </label>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '6px 8px',
                border: '1px solid color-mix(in srgb, var(--violet) 48%, var(--rule))',
                background: 'rgba(16, 10, 26, 0.5)',
              }}
            >
              <span style={{ ...labelStyle, color: 'var(--violet)' }}>auditor · 零上下文对抗审计 (/auditor)</span>
              {routeSelect(auditor, settings.providerNames, setAuditor)}
            </label>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 160 }}>
            <span style={labelStyle}>max turns（session 级）</span>
            <input
              style={fieldStyle}
              type="number"
              min={1}
              max={200}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Number(e.target.value) || 0)}
            />
          </label>

          <div>
            <div style={{ ...labelStyle, marginBottom: 6 }}>providers（只读）</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
              {settings.providers.map((p) => (
                <div key={p.name} style={{ display: 'flex', gap: 10, color: 'var(--muted)' }}>
                  <span style={{ color: 'var(--accent)', minWidth: 90 }}>{p.name}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.model || '—'}
                  </span>
                  <span style={{ color: 'var(--faint)' }}>{p.type}</span>
                </div>
              ))}
              {settings.providers.length === 0 && (
                <div style={{ color: 'var(--faint)' }}>○ 无 provider 配置</div>
              )}
            </div>
          </div>

          {saveError && <div style={{ color: 'var(--err)', fontSize: 12 }}>✗ {saveError}</div>}
          {saved && <div style={{ color: 'var(--ok)', fontSize: 12 }}>✓ 已保存（provider 路由已持久化）</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Btn onClick={onClose}>close</Btn>
            <Btn tone="accent" onClick={save} disabled={busy}>
              {busy ? 'saving…' : 'save'}
            </Btn>
          </div>
        </>
      )}
    </Dialog>
  )
}
