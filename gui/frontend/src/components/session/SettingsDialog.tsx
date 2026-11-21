// ⚙ settings dialog — active session's live config with explicit dirty/unsaved
// tracking, inline validation on maxTurns (1..200), grouped sections, and
// unambiguous save-confirmation feedback.
// Provider routes persist via SaveUIPrefs; maxTurns is session-local.
import { useEffect, useMemo, useState } from 'react'
import { hasBackend } from '../../store/sessions'
import { api } from '../../lib/api'
import type { SettingsDTO, SettingsPatch } from '../../lib/types'
import { Btn, Dialog, fieldStyle, labelStyle } from './Dialog'
import { validateMaxTurns } from './usabilityHelpers'
import './usability.css'

// '' = auto routing (the backend's empty-string default), rendered as "auto"
const AUTO = ''
const TURN_PRESETS = [20, 30, 60, 100] as const

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
  const [maxTurns, setMaxTurns] = useState(30)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
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

  const maxTurnsError = useMemo(() => (settings ? validateMaxTurns(maxTurns) : null), [settings, maxTurns])

  const changedCount = useMemo(() => {
    if (!settings) return 0
    let n = 0
    if (planner !== settings.plannerProvider) n += 1
    if (executor !== settings.executorProvider) n += 1
    if (researcher !== settings.researcherProvider) n += 1
    if (auditor !== (settings.auditProvider ?? '')) n += 1
    if (maxTurns !== settings.maxTurns) n += 1
    return n
  }, [settings, planner, executor, researcher, auditor, maxTurns])

  const isDirty = changedCount > 0

  function markEdited<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setSavedAt(null)
      setSaveError(null)
    }
  }

  function resetDraft() {
    if (!settings) return
    setPlanner(settings.plannerProvider)
    setExecutor(settings.executorProvider)
    setResearcher(settings.researcherProvider)
    setAuditor(settings.auditProvider ?? '')
    setMaxTurns(settings.maxTurns)
    setSaveError(null)
    setSavedAt(null)
  }

  async function save() {
    if (!settings || maxTurnsError) return
    setBusy(true)
    setSaveError(null)
    setSavedAt(null)
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
      setSettings({
        ...settings,
        plannerProvider: planner,
        executorProvider: executor,
        researcherProvider: researcher,
        auditProvider: auditor,
        maxTurns,
      })
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      const ss = String(now.getSeconds()).padStart(2, '0')
      setSavedAt(`${hh}:${mm}:${ss}`)
    } catch (err) {
      setSaveError(String(err))
    }
    setBusy(false)
  }

  return (
    <Dialog title="config" width={580} onClose={onClose}>
      {!settings ? (
        <div style={{ color: loadError ? 'var(--err)' : 'var(--faint)', fontSize: 12, padding: '8px 0' }}>
          {loadError ? `✗ ${loadError}` : '⠋ loading session settings…'}
        </div>
      ) : (
        <>
          {/* Session context summary strip */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '6px 9px',
              border: '1px solid var(--rule)',
              background: 'color-mix(in srgb, var(--bg) 60%, var(--bg-panel) 40%)',
              color: 'var(--faint)',
              fontSize: 11,
            }}
          >
            <span>
              session <strong style={{ color: 'var(--accent)' }}>{sessionName}</strong>
            </span>
            <span>·</span>
            <span>role {settings.role}</span>
            <span>·</span>
            <span>compaction {settings.compactionStrategy || 'summary'}</span>
            <span>·</span>
            <span>mcp {settings.mcpServerCount}</span>
            {isDirty && (
              <span
                style={{
                  marginLeft: 'auto',
                  color: 'var(--warn)',
                  border: '1px solid color-mix(in srgb, var(--warn) 60%, var(--rule))',
                  background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
                  padding: '0 6px',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                ● {changedCount} unsaved
              </span>
            )}
          </div>

          {/* Section 1: Persistent Provider Routing */}
          <div className="usa-section">
            <div className="usa-section-head">
              <span>1. Role Routing (Persistent)</span>
              <span style={{ color: 'var(--faint)', fontSize: 9.5, textTransform: 'none', letterSpacing: 0 }}>
                修改后全局持久化，同终端 /planner /executor /researcher /auditor
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '7px 8px',
                  border: `1px solid ${
                    planner !== settings.plannerProvider
                      ? 'var(--warn)'
                      : 'color-mix(in srgb, var(--accent) 42%, var(--rule))'
                  }`,
                  background: 'rgba(6, 14, 24, 0.5)',
                }}
              >
                <span style={{ ...labelStyle, color: 'var(--accent)' }}>planner · 强推理规划 (/planner)</span>
                <span style={{ fontSize: 10, color: 'var(--faint)' }}>候选: codex sol / gemini 4 carbon</span>
                {routeSelect(planner, settings.providerNames, markEdited(setPlanner))}
              </label>

              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '7px 8px',
                  border: `1px solid ${
                    executor !== settings.executorProvider
                      ? 'var(--warn)'
                      : 'color-mix(in srgb, var(--ok) 42%, var(--rule))'
                  }`,
                  background: 'rgba(6, 18, 14, 0.45)',
                }}
              >
                <span style={{ ...labelStyle, color: 'var(--ok)' }}>executor · 高速工具取证 (/executor)</span>
                <span style={{ fontSize: 10, color: 'var(--faint)' }}>候选: ds / gemini 4 neon / glm-5.3-flash</span>
                {routeSelect(executor, settings.providerNames, markEdited(setExecutor))}
              </label>

              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '7px 8px',
                  border: `1px solid ${
                    researcher !== settings.researcherProvider
                      ? 'var(--warn)'
                      : 'color-mix(in srgb, var(--warn) 42%, var(--rule))'
                  }`,
                  background: 'rgba(20, 14, 6, 0.45)',
                }}
              >
                <span style={{ ...labelStyle, color: 'var(--warn)' }}>researcher · 知识库与调研 (/researcher)</span>
                <span style={{ fontSize: 10, color: 'var(--faint)' }}>候选: gemini 4 carbon / ds / glm-5.3</span>
                {routeSelect(researcher, settings.providerNames, markEdited(setResearcher))}
              </label>

              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '7px 8px',
                  border: `1px solid ${
                    auditor !== (settings.auditProvider ?? '')
                      ? 'var(--warn)'
                      : 'color-mix(in srgb, var(--violet) 48%, var(--rule))'
                  }`,
                  background: 'rgba(16, 10, 26, 0.5)',
                }}
              >
                <span style={{ ...labelStyle, color: 'var(--violet)' }}>auditor · 独立对抗审计 (/auditor)</span>
                <span style={{ fontSize: 10, color: 'var(--faint)' }}>候选: codex sol / gemini 4 carbon / glm-5.3</span>
                {routeSelect(auditor, settings.providerNames, markEdited(setAuditor))}
              </label>
            </div>
          </div>

          {/* Section 2: Session Guardrails */}
          <div className="usa-section">
            <div className="usa-section-head">
              <span>2. Execution Guardrails (Session-local)</span>
              <span style={{ color: 'var(--faint)', fontSize: 9.5, textTransform: 'none', letterSpacing: 0 }}>
                单回合最大工具迭代步数（1–200）
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 170 }}>
                <span style={labelStyle}>max turns（session 级）</span>
                <input
                  style={{
                    ...fieldStyle,
                    borderColor: maxTurnsError ? 'var(--err)' : maxTurns !== settings.maxTurns ? 'var(--warn)' : undefined,
                  }}
                  type="number"
                  min={1}
                  max={200}
                  value={maxTurns}
                  onChange={(e) => markEdited(setMaxTurns)(Number(e.target.value) || 0)}
                />
              </label>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, paddingBottom: 3 }}>
                <span style={{ color: 'var(--faint)', fontSize: 10 }}>presets:</span>
                {TURN_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="usa-pill"
                    data-active={maxTurns === p ? 'true' : undefined}
                    onClick={() => markEdited(setMaxTurns)(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {maxTurnsError && <div style={{ color: 'var(--err)', fontSize: 11 }}>✗ {maxTurnsError}</div>}
          </div>

          {/* Section 3: Read-only Provider Inventory */}
          <div className="usa-section">
            <div className="usa-section-head">
              <span>3. Providers (Read-only)</span>
              <span style={{ color: 'var(--faint)', fontSize: 9.5, textTransform: 'none', letterSpacing: 0 }}>
                API Key 仅留在后端，不跨桥传输
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, maxHeight: 110, overflowY: 'auto' }}>
              {settings.providers.map((p) => (
                <div
                  key={p.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--muted)',
                    padding: '2px 4px',
                    borderBottom: '1px solid color-mix(in srgb, var(--rule) 45%, transparent)',
                  }}
                >
                  <span style={{ color: 'var(--accent)', minWidth: 96, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.model || '—'}
                  </span>
                  <span
                    style={{
                      color: 'var(--faint)',
                      fontSize: 10,
                      border: '1px solid var(--rule)',
                      padding: '0 5px',
                    }}
                  >
                    {p.type}
                  </span>
                </div>
              ))}
              {settings.providers.length === 0 && (
                <div style={{ color: 'var(--faint)' }}>○ 无 provider 配置</div>
              )}
            </div>
          </div>

          {saveError && (
            <div
              style={{
                color: 'var(--err)',
                fontSize: 12,
                padding: '6px 8px',
                border: '1px solid var(--err)',
                background: 'color-mix(in srgb, var(--err) 10%, var(--bg))',
              }}
            >
              ✗ {saveError}
            </div>
          )}
          {savedAt && (
            <div
              style={{
                color: 'var(--ok)',
                fontSize: 12,
                padding: '6px 8px',
                border: '1px solid var(--ok)',
                background: 'color-mix(in srgb, var(--ok) 10%, var(--bg))',
              }}
            >
              ✓ 已保存（provider 路由已持久化 · {savedAt}）
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 11, color: isDirty ? 'var(--warn)' : 'var(--faint)' }}>
              {isDirty ? `⚠ 有 ${changedCount} 项未保存更改` : '所有设置已与当前会话同步'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {isDirty && (
                <Btn type="button" onClick={resetDraft} disabled={busy}>
                  reset
                </Btn>
              )}
              <Btn type="button" onClick={onClose}>
                close
              </Btn>
              <Btn
                type="button"
                tone="accent"
                onClick={save}
                disabled={busy || Boolean(maxTurnsError)}
                style={{
                  borderColor: 'var(--accent)',
                  background: isDirty
                    ? 'color-mix(in srgb, var(--accent) 22%, transparent)'
                    : 'color-mix(in srgb, var(--accent) 10%, transparent)',
                  fontWeight: 600,
                }}
              >
                {busy ? 'saving…' : 'save'}
              </Btn>
            </div>
          </div>
        </>
      )}
    </Dialog>
  )
}
