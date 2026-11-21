// Shared keyboard-first utilities: platform modifier formatting, editable-target
// detection, fast fuzzy matcher for Command Palette + Slash Completions, and
// the canonical Keyboard Shortcuts catalog.

export interface FuzzyMatchResult {
  matched: boolean
  score: number
  indices: number[]
}

/** Detect macOS/iOS for ⌘ vs Ctrl keycap display. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true
  const p = (navigator.platform || navigator.userAgent || '').toLowerCase()
  return p.includes('mac') || p.includes('iphone') || p.includes('ipad')
}

/** Primary modifier key glyph/label. */
export function modGlyph(mac = isMacPlatform()): string {
  return mac ? '⌘' : 'Ctrl+'
}

/** True when the primary shortcut modifier (Cmd on Mac, Ctrl elsewhere) is held. */
export function hasPrimaryMod(
  e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>,
  mac = isMacPlatform(),
): boolean {
  return mac ? e.metaKey : e.ctrlKey
}

/** Format a shortcut chord using platform-appropriate modifier glyphs. */
export function formatChord(keys: readonly string[], mac = isMacPlatform()): string[] {
  return keys.map((k) => {
    if (k === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (k === 'Shift') return mac ? '⇧' : 'Shift'
    if (k === 'Alt') return mac ? '⌥' : 'Alt'
    if (k === 'Enter') return '⏎'
    if (k === 'Esc') return 'ESC'
    return k
  })
}

/**
 * Returns true when keyboard focus is inside a text input, editable area,
 * select control, or xterm terminal so single-key shortcuts (`?`, `/`) never
 * steal keystrokes from typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof HTMLElement === 'undefined') return false
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  if (target.closest('.xterm')) return true
  return false
}

/**
 * Fast, deterministic fuzzy matcher for command palettes and slash commands.
 * Rewards: exact match > prefix > word-boundary hits > contiguous runs > earlier hits.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatchResult {
  const q = query.trim().toLowerCase()
  if (!q) return { matched: true, score: 0, indices: [] }

  const text = candidate.toLowerCase()
  const indices: number[] = []
  let ti = 0
  let score = 0
  let streak = 0

  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]
    if (ch === ' ') continue
    const found = text.indexOf(ch, ti)
    if (found < 0) return { matched: false, score: -1, indices: [] }

    indices.push(found)
    if (found === 0) {
      score += 24
    } else {
      const prev = text[found - 1]
      if (prev === ' ' || prev === '/' || prev === '-' || prev === '_' || prev === ':' || prev === '.') {
        score += 18
      }
    }

    if (indices.length > 1 && found === indices[indices.length - 2] + 1) {
      streak += 1
      score += 10 + streak * 4
    } else {
      streak = 0
      score += 3
    }

    // Slight penalty for spread/late matches so tighter matches win
    score -= found * 0.15
    ti = found + 1
  }

  if (text === q) score += 80
  else if (text.startsWith(q)) score += 45

  return { matched: true, score, indices }
}

/** Split text into highlighted/plain spans using matched character indices. */
export function splitHighlightSegments(
  text: string,
  indices: readonly number[],
): Array<{ text: string; hit: boolean }> {
  if (indices.length === 0) return [{ text, hit: false }]
  const hitSet = new Set(indices)
  const out: Array<{ text: string; hit: boolean }> = []
  let cur = ''
  let curHit = hitSet.has(0)
  for (let i = 0; i < text.length; i += 1) {
    const h = hitSet.has(i)
    if (h !== curHit && cur) {
      out.push({ text: cur, hit: curHit })
      cur = ''
    }
    curHit = h
    cur += text[i]
  }
  if (cur) out.push({ text: cur, hit: curHit })
  return out
}

export interface ShortcutEntry {
  label: string
  keys: readonly string[]
}

export interface ShortcutGroup {
  title: string
  entries: readonly ShortcutEntry[]
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Command & Discovery',
    entries: [
      { label: '命令面板 (Command Palette)', keys: ['Mod', 'K'] },
      { label: '快捷键速查表', keys: ['Mod', '/'] },
      { label: '快捷键速查表 (非输入态)', keys: ['?'] },
      { label: '聚焦 Prompt 输入框', keys: ['/'] },
      { label: '按层级关闭浮层 / 拒绝审批', keys: ['Esc'] },
    ],
  },
  {
    title: 'Views & Stages',
    entries: [
      { label: '五维实时仪表盘 (Classic)', keys: ['Mod', '1'] },
      { label: '二进制解剖地形图 (Radar)', keys: ['Mod', '2'] },
      { label: '机制协同图谱 (Governance)', keys: ['Mod', '3'] },
      { label: '3D 取证剧场 (Theater)', keys: ['Mod', '4'] },
      { label: '循环切换 CRT 荧光管主题', keys: ['Mod', 'Shift', 'T'] },
    ],
  },
  {
    title: 'Workspace Panes',
    entries: [
      { label: '折叠 / 展开左侧会话栏', keys: ['Mod', 'B'] },
      { label: '折叠 / 展开转录日志区', keys: ['Mod', 'J'] },
      { label: '折叠 / 展开右侧取证栏', keys: ['Mod', '\\'] },
      { label: '折叠 / 展开上方仪表区', keys: ['Mod', 'Shift', 'D'] },
      { label: '重置所有分屏尺寸并展开', keys: ['Mod', 'Shift', '0'] },
      { label: '进入 / 退出系统真全屏', keys: ['Mod', 'Shift', 'F'] },
    ],
  },
  {
    title: 'Prompt & Sessions',
    entries: [
      { label: '发送 Prompt / 执行命令', keys: ['Enter'] },
      { label: '输入框换行', keys: ['Shift', 'Enter'] },
      { label: '浏览历史命令 (首/末行)', keys: ['↑', '↓'] },
      { label: '新建 Session', keys: ['Mod', 'Shift', 'N'] },
      { label: '筛选侧栏 Sessions', keys: ['Mod', 'Shift', 'S'] },
      { label: '打开 RE 工作流选择器', keys: ['Mod', 'Shift', 'R'] },
    ],
  },
]

// ---------- Lightweight cross-shell interaction event bus ----------

export const IX_EVENT_FOCUS_PROMPT = '0xaf:focus-prompt'
export const IX_EVENT_OPEN_RE_PICKER = '0xaf:open-re-picker'
export const IX_EVENT_FOCUS_SIDEBAR_SEARCH = '0xaf:focus-sidebar-search'

export function dispatchIxEvent(name: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name))
}
