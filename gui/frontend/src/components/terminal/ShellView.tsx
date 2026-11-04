// ShellView — one xterm.js terminal wired to a backend PTY shell. Bytes flow
// two ways around React: PTY output arrives via the store's sink registry
// (gui:shell events, base64-decoded) and keystrokes leave through
// api.ShellWrite. The component only re-renders on theme/container changes.
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { shellActions, registerShellSink } from '../../store/shells'
import type { ShellInfo } from '../../lib/types'

// Map the CRT tokens onto xterm's palette. Read at mount — theme switches
// remount the view via key so the palette follows without live-var plumbing.
function terminalTheme(): Record<string, string> {
  const css = getComputedStyle(document.body)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    background: v('--bg', '#05080c'),
    foreground: v('--text', '#d8e6ee'),
    cursor: v('--accent', '#22d3ee'),
    cursorAccent: v('--bg', '#05080c'),
    selectionBackground: v('--accent-dim', 'rgba(34, 211, 238, 0.3)'),
    black: v('--bg', '#05080c'),
    red: v('--err', '#ff5c57'),
    green: v('--ok', '#5af78e'),
    yellow: v('--warn', '#f3f99d'),
    blue: v('--accent', '#22d3ee'),
    magenta: v('--violet', '#c792ea'),
    cyan: v('--accent', '#22d3ee'),
    white: v('--text', '#d8e6ee'),
    brightBlack: v('--faint', '#4a5a66'),
    brightWhite: '#ffffff',
  }
}

export function ShellView({ shell }: { shell: ShellInfo }) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // PTY bytes → xterm, bypassing React state
    const unregister = registerShellSink(shell.id, (bytes) => term.write(bytes))

    term.onData((data) => void shellActions.write(shell.id, data))
    term.onResize(({ cols, rows }) => void shellActions.resize(shell.id, cols, rows))

    // Size the PTY to the viewport now and on every container resize.
    const refit = () => {
      try {
        fit.fit()
      } catch {
        // zero-sized container during layout — next observer tick fixes it
      }
    }
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    refit()

    term.focus()

    return () => {
      observer.disconnect()
      unregister()
      term.dispose()
    }
  }, [shell.id])

  return (
    <section
      style={{
        height: '100%',
        minHeight: 0,
        border: '1px solid var(--rule)',
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--muted)',
          fontSize: 11,
          letterSpacing: '0.12em',
          padding: '5px 10px',
          borderBottom: '1px solid var(--rule)',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: 'var(--accent)' }}>⌘ SHELL {shell.id}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={shell.cwd}>
          {shell.cwd}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--faint)' }}>pid {shell.pid}</span>
        <button
          onClick={() => void shellActions.close(shell.id)}
          title="kill shell"
          style={{
            background: 'none',
            border: '1px solid var(--rule)',
            color: 'var(--faint)',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 11,
            padding: '1px 7px',
          }}
        >
          kill
        </button>
      </header>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: '2px 6px' }} />
    </section>
  )
}
