// Keyboard Shortcuts Cheat Sheet (? or Cmd/Ctrl+/):
// Two-column scannable keybinding reference rendered inside shared Dialog
// so Esc unwinding, focus trapping, and focus restoration work automatically.
import { useMemo } from 'react'
import { Dialog } from '../session/Dialog'
import { formatChord, isMacPlatform, SHORTCUT_GROUPS } from './shortcuts'
import './interaction.css'

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const mac = useMemo(() => isMacPlatform(), [])

  return (
    <Dialog title="keyboard shortcuts" accent="accent" width={680} onClose={onClose}>
      <div className="ix-shortcuts-grid" data-testid="shortcuts-dialog">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.title} className="ix-shortcuts-section">
            <div className="ix-shortcuts-title">{group.title}</div>
            {group.entries.map((entry) => (
              <div key={`${group.title}:${entry.label}`} className="ix-shortcut-row">
                <span>{entry.label}</span>
                <span className="ix-shortcut-keys">
                  {formatChord(entry.keys, mac).map((k, i) => (
                    <kbd key={i} className="ix-kbd ix-kbd--accent">
                      {k}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 10.5,
          color: 'var(--faint)',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 8,
        }}
      >
        <span>双击分割线重置尺寸 · 聚焦后方向键微调</span>
        <span>Esc 关闭</span>
      </div>
    </Dialog>
  )
}
