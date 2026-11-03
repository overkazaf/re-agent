// WS2 dev page (dev-shell.html): AppShell with every slot filled, the theme
// switcher, and the full crt/ component showroom across tones and stages.
// Everything runs on local theme state + mock data — no Wails bindings.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '../styles/tokens.css'
import '../styles/crt.css'
import '../styles/base.css'
import { AppShell } from '../components/shell/AppShell'
import {
  BootSplash,
  CornerFrame,
  GlowText,
  PanelBox,
  ProgressChip,
  Sparkline,
  Spinner,
  StatusBadge,
} from '../components/crt'
import type { BootProbe } from '../components/crt'
import { ThemeProvider, useTheme } from '../theme/ThemeContext'
import { hud } from './mock'

const BOOT_PROBES: BootProbe[] = [
  { label: 'config load', ok: true },
  { label: 'providers · claude-max', ok: true },
  { label: 'tools 24 registered', ok: true },
  { label: 'MCP filesystem', ok: true },
  { label: 'MCP frida-bridge', ok: false },
]

// --- theme switcher -------------------------------------------------------------

function ThemeSwitcher() {
  const { theme, themes, setTheme } = useTheme()
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {themes.map((t) => {
        const active = t === theme
        return (
          <button
            key={t}
            onClick={() => setTheme(t)}
            style={{
              fontSize: 11,
              padding: '2px 8px',
              letterSpacing: '0.08em',
              color: active ? 'var(--accent)' : 'var(--muted)',
              border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 45%, var(--rule))' : 'var(--rule)'}`,
              textShadow: active
                ? '0 0 calc(6px * var(--glow-strength)) color-mix(in srgb, var(--accent) 55%, transparent)'
                : undefined,
            }}
          >
            {active ? `▸ ${t}` : t}
          </button>
        )
      })}
    </span>
  )
}

// --- boot overlay ----------------------------------------------------------------

function BootOverlay({ onDone }: { onDone: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'var(--bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <BootSplash probes={BOOT_PROBES} onDone={onDone} />
    </div>
  )
}

// --- slot content ------------------------------------------------------------------

function row(label: string, node: ReactNode) {
  return (
    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0' }}>
      <span style={{ color: 'var(--faint)', fontSize: 11, width: 86 }}>{label}</span>
      {node}
    </div>
  )
}

function Showroom() {
  const spark = hud().spark
  return (
    <>
      {row('glow', (
        <span style={{ display: 'inline-flex', gap: 12, fontSize: 12 }}>
          <GlowText tone="accent">accent</GlowText>
          <GlowText tone="violet">violet</GlowText>
          <GlowText tone="ok">ok</GlowText>
          <GlowText tone="warn">warn</GlowText>
          <GlowText tone="err">err</GlowText>
          <GlowText tone="muted">muted</GlowText>
          <GlowText tone="text">text</GlowText>
        </span>
      ))}
      {row('badge', (
        <span style={{ display: 'inline-flex', gap: 12, fontSize: 13 }}>
          <StatusBadge state="ok" />
          <StatusBadge state="pending" />
          <StatusBadge state="off" />
        </span>
      ))}
      {row('spinner', (
        <span style={{ display: 'inline-flex', gap: 12, fontSize: 13 }}>
          <Spinner tone="accent" />
          <Spinner tone="violet" />
          <Spinner tone="ok" />
          <Spinner tone="warn" />
          <Spinner tone="err" />
        </span>
      ))}
      {row('progress', (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
          <ProgressChip done={0} total={7} />
          <ProgressChip done={3} total={7} />
          <ProgressChip done={7} total={7} />
        </span>
      ))}
      {row('spark', <Sparkline data={spark} />)}
      {row('spark/empty', <Sparkline data={[]} />)}
      {row('corners', (
        <CornerFrame>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>bracketed inline block</span>
        </CornerFrame>
      ))}
    </>
  )
}

function DashboardSlot() {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1.1 1 0' }}>
        <PanelBox title="flow" accent="accent">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
            <Spinner tone="accent" />
            <GlowText tone="accent">planner</GlowText>
            <span style={{ color: 'var(--faint)' }}>⇉</span>
            <GlowText tone="violet">executor</GlowText>
            <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
              claude-max · claude-sonnet-5-5
            </span>
          </div>
          <div style={{ color: 'var(--faint)', fontSize: 11, marginTop: 4 }}>
            stage <GlowText tone="ok">think</GlowText> · turn 4 · packets in flight
          </div>
        </PanelBox>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 0' }}>
        <PanelBox title="tools" accent="violet">
          <div style={{ fontSize: 12, whiteSpace: 'pre', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--faint)' }}>├─ </span>
            <span style={{ color: 'var(--muted)' }}>strings -n 8 binary.so </span>
            <GlowText tone="ok">✓ 0.8s</GlowText>
            {'\n'}
            <span style={{ color: 'var(--faint)' }}>├─ </span>
            <span style={{ color: 'var(--muted)' }}>r2 -q aaa -c afl </span>
            <GlowText tone="ok">✓ 3.1s</GlowText>
            {'\n'}
            <span style={{ color: 'var(--faint)' }}>└─ </span>
            <span style={{ color: 'var(--muted)' }}>hexdump -s 0x8f4c </span>
            <Spinner tone="accent" />
          </div>
        </PanelBox>
      </div>
      <div style={{ display: 'flex', gap: 8, flex: '0.9 1 0', minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <PanelBox title="plan" accent="ok">
            <div style={{ fontSize: 12 }}>
              <ProgressChip done={3} total={7} />
              <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: 11 }}>
                ◈ locate license check routine
              </div>
            </div>
          </PanelBox>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <PanelBox title="tele">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, fontSize: 11 }}>
              <Sparkline data={hud().spark} h={22} />
              <div style={{ color: 'var(--muted)' }}>
                in <GlowText tone="text">48.2k</GlowText> out <GlowText tone="text">3.9k</GlowText>
                <br />
                <span style={{ color: 'var(--warn)' }}>$0.4137</span>
              </div>
            </div>
          </PanelBox>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1.4 1 0' }}>
        <PanelBox title="crt showroom">
          <Showroom />
        </PanelBox>
      </div>
    </>
  )
}

function SidebarSlot() {
  const sessions = [
    { id: 's1', label: 'rev · apk-license', state: 'ok' as const },
    { id: 's2', label: 'ctf · flare-on', state: 'pending' as const },
    { id: 's3', label: 'audit · libnative', state: 'off' as const },
  ]
  return (
    <div style={{ padding: 8, fontSize: 12 }}>
      {sessions.map((s, i) => (
        <div
          key={s.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 6px',
            marginBottom: 2,
            border: i === 0 ? '1px solid color-mix(in srgb, var(--accent) 35%, var(--rule))' : '1px solid transparent',
            color: 'var(--muted)',
          }}
        >
          <StatusBadge state={s.state} />
          <span style={i === 0 ? { color: 'var(--accent)' } : undefined}>{s.label}</span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button style={{ border: '1px solid var(--rule)', color: 'var(--accent)', padding: '2px 10px', fontSize: 11 }}>
          + new
        </button>
        <button style={{ border: '1px solid var(--rule)', color: 'var(--muted)', padding: '2px 10px', fontSize: 11 }}>
          resume
        </button>
      </div>
    </div>
  )
}

function SideSlot() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <PanelBox title="re hud" accent="violet">
          <div style={{ fontSize: 12, whiteSpace: 'pre', lineHeight: 1.7 }}>
            <span style={{ color: 'var(--muted)' }}>▸ TRI </span>
            <span style={{ color: 'var(--accent)' }}>→ STA </span>
            <span style={{ color: 'var(--faint)' }}>→ DYN → EVD → INT → HYP → WRU</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            H:2 <GlowText tone="violet">hypotheses</GlowText> · E:5 <GlowText tone="ok">evidence</GlowText>
          </div>
        </PanelBox>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <PanelBox title="queue">
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            <span className="glow-warn">⠿</span> queued (2)
            <div style={{ color: 'var(--faint)', fontSize: 11, marginTop: 2 }}>
              ├─ dump classes via frida
              <br />└─ diff unpacked so
            </div>
          </div>
        </PanelBox>
      </div>
    </div>
  )
}

function TranscriptSlot() {
  const faint = { color: 'var(--faint)' } as const
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6, padding: '2px 4px' }}>
      <div><span style={faint}>t+0.0s </span><span style={{ color: 'var(--muted)' }}>↻ wire send · 8.4k tokens</span></div>
      <div><span style={faint}>t+2.1s </span><span style={{ color: 'var(--faint)' }}>┊ thinking: strings hit JNI_OnLoad + OpenSSL…</span></div>
      <div><span style={faint}>t+3.0s </span><span style={{ color: 'var(--muted)' }}>⚙ entropy binary.so</span> <GlowText tone="ok">✓ 0.4s</GlowText></div>
      <div><span style={faint}>t+6.3s </span><span style={{ color: 'var(--muted)' }}>◈ plan update · 7 steps</span></div>
      <div><span style={faint}>t+9.4s </span><GlowText tone="accent">✓ reply</GlowText> <span style={faint}>812 chars — aarch64 ELF, OLLVM flattening suspected</span></div>
    </div>
  )
}

function PromptSlot() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%', padding: '0 12px', fontSize: 13 }}>
      <GlowText tone="accent">❯</GlowText>
      <span style={{ color: 'var(--faint)' }}>ask anything — / for commands</span>
      <span style={{ marginLeft: 'auto' }}>
        <Spinner tone="accent" ms={120} />
      </span>
    </div>
  )
}

// --- page -------------------------------------------------------------------------

function ShellDemo() {
  const [booting, setBooting] = useState(true)
  return (
    <>
      {booting && <BootOverlay onDone={() => setBooting(false)} />}
      <AppShell
        topRight={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <ThemeSwitcher />
            <button
              onClick={() => setBooting(true)}
              style={{ border: '1px solid var(--rule)', color: 'var(--muted)', padding: '2px 8px', fontSize: 11 }}
            >
              replay boot
            </button>
          </span>
        }
        sidebar={<SidebarSlot />}
        dashboard={<DashboardSlot />}
        side={<SideSlot />}
        transcript={
          <PanelBox title="transcript">
            <TranscriptSlot />
          </PanelBox>
        }
        prompt={<PromptSlot />}
      />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <ShellDemo />
  </ThemeProvider>,
)
