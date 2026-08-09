// Terminal theme: color-depth detection, a restrained palette, and
// CJK/emoji-aware width math. Everything that needs to know how wide a glyph
// renders goes through displayWidth() so box layouts stay aligned for mixed
// Chinese/English/emoji output.

const noColor = Boolean(process.env.NO_COLOR);
const forced = Boolean(process.env.FORCE_COLOR);

export const colorEnabled = !noColor && (Boolean(process.stdout.isTTY) || forced);

const colorterm = process.env.COLORTERM ?? "";
const term = process.env.TERM ?? "";
const truecolor = colorEnabled && /truecolor|24bit/i.test(colorterm);
const has256 = colorEnabled && (truecolor || /256|kitty|alacritty|ghostty/i.test(term) || Boolean(process.env.TERM_PROGRAM));

type Rgb = readonly [number, number, number];
interface Tone {
  rgb: Rgb;
  x256: number;
  basic: number;
}

// Cyberdeck palette. One accent (cyan), one secondary (violet), semantic
// green/amber/red, and a deep gray ramp that carries most of the chrome.
const DECK = {
  accent: { rgb: [34, 211, 238], x256: 45, basic: 36 },
  accentDim: { rgb: [14, 116, 144], x256: 30, basic: 36 },
  violet: { rgb: [167, 139, 250], x256: 141, basic: 35 },
  violetDim: { rgb: [91, 71, 156], x256: 97, basic: 35 },
  ok: { rgb: [74, 222, 128], x256: 114, basic: 32 },
  warn: { rgb: [251, 191, 36], x256: 214, basic: 33 },
  err: { rgb: [248, 113, 113], x256: 203, basic: 31 },
  text: { rgb: [229, 231, 235], x256: 253, basic: 37 },
  muted: { rgb: [148, 163, 184], x256: 245, basic: 37 },
  faint: { rgb: [100, 116, 139], x256: 242, basic: 90 },
  rule: { rgb: [51, 65, 85], x256: 238, basic: 90 },
} as const satisfies Record<string, Tone>;

export type ToneName = keyof typeof DECK;
type Palette = Record<ToneName, Tone>;

// Amber CRT. Everything sits in the amber family; only errors break out, since
// legibility of a failure beats palette purity.
const AMBER: Palette = {
  accent: { rgb: [255, 176, 0], x256: 214, basic: 33 },
  accentDim: { rgb: [166, 112, 0], x256: 136, basic: 33 },
  violet: { rgb: [255, 210, 127], x256: 222, basic: 33 },
  violetDim: { rgb: [140, 100, 40], x256: 94, basic: 33 },
  ok: { rgb: [255, 214, 51], x256: 220, basic: 33 },
  warn: { rgb: [255, 149, 0], x256: 208, basic: 33 },
  err: { rgb: [255, 95, 86], x256: 203, basic: 31 },
  text: { rgb: [255, 204, 102], x256: 221, basic: 37 },
  muted: { rgb: [193, 143, 43], x256: 178, basic: 33 },
  faint: { rgb: [125, 88, 20], x256: 94, basic: 90 },
  rule: { rgb: [74, 52, 12], x256: 58, basic: 90 },
};

// Green phosphor.
const MATRIX: Palette = {
  accent: { rgb: [0, 255, 156], x256: 48, basic: 32 },
  accentDim: { rgb: [0, 168, 104], x256: 35, basic: 32 },
  violet: { rgb: [124, 255, 178], x256: 121, basic: 32 },
  violetDim: { rgb: [40, 120, 80], x256: 29, basic: 32 },
  ok: { rgb: [0, 255, 156], x256: 48, basic: 32 },
  warn: { rgb: [255, 209, 102], x256: 221, basic: 33 },
  err: { rgb: [255, 107, 107], x256: 203, basic: 31 },
  text: { rgb: [200, 255, 217], x256: 194, basic: 37 },
  muted: { rgb: [78, 142, 106], x256: 71, basic: 32 },
  faint: { rgb: [47, 92, 70], x256: 65, basic: 90 },
  rule: { rgb: [30, 58, 44], x256: 236, basic: 90 },
};

// Hueless. For screenshots, e-ink, and anyone who reads color badly; contrast
// carries the hierarchy instead of hue.
const MONO: Palette = {
  accent: { rgb: [255, 255, 255], x256: 231, basic: 37 },
  accentDim: { rgb: [160, 160, 160], x256: 247, basic: 37 },
  violet: { rgb: [214, 214, 214], x256: 252, basic: 37 },
  violetDim: { rgb: [120, 120, 120], x256: 244, basic: 90 },
  ok: { rgb: [235, 235, 235], x256: 255, basic: 37 },
  warn: { rgb: [190, 190, 190], x256: 250, basic: 37 },
  err: { rgb: [255, 255, 255], x256: 231, basic: 37 },
  text: { rgb: [224, 224, 224], x256: 253, basic: 37 },
  muted: { rgb: [150, 150, 150], x256: 246, basic: 37 },
  faint: { rgb: [110, 110, 110], x256: 243, basic: 90 },
  rule: { rgb: [68, 68, 68], x256: 238, basic: 90 },
};

export const THEMES = { deck: DECK as Palette, amber: AMBER, matrix: MATRIX, mono: MONO };
export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export const THEME_BLURBS: Record<ThemeName, string> = {
  deck: "cyan + violet cyberdeck (default)",
  amber: "amber CRT phosphor",
  matrix: "green phosphor terminal",
  mono: "hueless, contrast-only",
};

let activeTheme: ThemeName = "deck";

export function setTheme(name: ThemeName): void {
  activeTheme = name;
}

export function currentTheme(): ThemeName {
  return activeTheme;
}

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as string[]).includes(value);
}

function fg(tone: Tone): string {
  if (!colorEnabled) return "";
  if (truecolor) return `\x1b[38;2;${tone.rgb[0]};${tone.rgb[1]};${tone.rgb[2]}m`;
  if (has256) return `\x1b[38;5;${tone.x256}m`;
  return `\x1b[${tone.basic}m`;
}

const RESET = colorEnabled ? "\x1b[0m" : "";

function wrap(open: string, value: string): string {
  if (!colorEnabled || !open) return value;
  return `${open}${value}${RESET}`;
}

type Painter = (value: string) => string;

// Resolved per call, not captured, so /theme takes effect immediately.
function tonePainter(name: ToneName): Painter {
  return value => wrap(fg(THEMES[activeTheme][name]), value);
}

/** Named color painters, e.g. `c.accent("0xAF")`. */
export const c: Record<ToneName, Painter> & {
  bold: Painter;
  dim: Painter;
  italic: Painter;
  underline: Painter;
  reverse: Painter;
} = {
  accent: tonePainter("accent"),
  accentDim: tonePainter("accentDim"),
  violet: tonePainter("violet"),
  violetDim: tonePainter("violetDim"),
  ok: tonePainter("ok"),
  warn: tonePainter("warn"),
  err: tonePainter("err"),
  text: tonePainter("text"),
  muted: tonePainter("muted"),
  faint: tonePainter("faint"),
  rule: tonePainter("rule"),
  bold: value => wrap("\x1b[1m", value),
  dim: value => wrap("\x1b[2m", value),
  italic: value => wrap("\x1b[3m", value),
  underline: value => wrap("\x1b[4m", value),
  reverse: value => wrap("\x1b[7m", value),
};

/** Foreground escape for a tone, for callers building their own sequences. */
export function toneOpen(name: ToneName): string {
  return fg(THEMES[activeTheme][name]);
}

/**
 * Paints text at position `t` (0..1) along the ramp between two tones. Used for
 * the logo's CRT-style vertical falloff. Without truecolor it snaps to the
 * nearer endpoint, which still reads as a fade.
 */
export function fade(from: ToneName, to: ToneName, t: number, value: string): string {
  if (!colorEnabled) return value;
  const palette = THEMES[activeTheme];
  if (!truecolor) return wrap(fg(palette[t < 0.5 ? from : to]), value);
  const a = palette[from].rgb;
  const b = palette[to].rgb;
  const mix = (i: number) => Math.round(a[i] + (b[i] - a[i]) * Math.min(1, Math.max(0, t)));
  return wrap(`\x1b[38;2;${mix(0)};${mix(1)};${mix(2)}m`, value);
}

export const RESET_SEQ = RESET;

// --- width math --------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

// Zero-width: combining marks and explicit zero-width/format characters.
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff
  );
}

// Double-width: CJK, Hangul, fullwidth forms, and the common emoji planes.
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function charWidth(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined) return 0;
  if (isZeroWidth(code)) return 0;
  return isWide(code) ? 2 : 1;
}

/** Rendered column count, ignoring ANSI escapes and counting CJK as 2. */
export function displayWidth(value: string): number {
  let total = 0;
  for (const char of stripAnsi(value)) total += charWidth(char);
  return total;
}

export function padEnd(value: string, width: number): string {
  const gap = width - displayWidth(value);
  return gap > 0 ? `${value}${" ".repeat(gap)}` : value;
}

export function padStart(value: string, width: number): string {
  const gap = width - displayWidth(value);
  return gap > 0 ? `${" ".repeat(gap)}${value}` : value;
}

/** Truncate to `width` columns, appending an ellipsis when clipped. */
export function truncate(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  let out = "";
  let used = 0;
  for (const char of stripAnsi(value)) {
    const w = charWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

/** Middle-elide a path so both the head and the filename stay readable. */
export function elidePath(value: string, width = 30): string {
  const home = process.env.HOME;
  const compact = home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (compact.length <= width) return compact;
  const tail = compact.slice(-(width - 2));
  return `…${tail}`;
}

interface Cell {
  open: string;
  char: string;
  /** Escapes that appeared after this glyph, e.g. a trailing reset. */
  close: string;
  width: number;
}

function toCells(value: string): Cell[] {
  const cells: Cell[] = [];
  let pending = "";
  ANSI_RE.lastIndex = 0;
  let index = 0;
  while (index < value.length) {
    ANSI_RE.lastIndex = index;
    const match = ANSI_RE.exec(value);
    if (match && match.index === index) {
      pending += match[0];
      index += match[0].length;
      continue;
    }
    const char = String.fromCodePoint(value.codePointAt(index)!);
    cells.push({ open: pending, char, close: "", width: charWidth(char) });
    pending = "";
    index += char.length;
  }
  // Trailing escapes close the final glyph; they must stay *after* it, or a
  // reset would land before the last character and strip its color.
  if (pending && cells.length > 0) cells[cells.length - 1].close += pending;
  return cells;
}

/**
 * ANSI-aware word wrap. Breaks on spaces for latin text and between glyphs for
 * CJK runs (which carry no spaces), so Chinese output wraps at the right column
 * instead of overflowing the terminal.
 */
export function wrapAnsi(value: string, width: number, hangingIndent = ""): string[] {
  if (width <= 4) return [value];
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    const cells = toCells(paragraph);
    if (cells.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    let used = 0;
    let breakAt = -1; // index in `current` just after the last space
    let first = true;
    const limit = () => width - (first ? 0 : displayWidth(hangingIndent));
    const flush = (text: string) => {
      lines.push(first ? text : `${hangingIndent}${text}`);
      first = false;
    };
    for (const cell of cells) {
      const wideBreak = cell.width === 2;
      if (used + cell.width > limit() && used > 0) {
        if (wideBreak || breakAt < 0) {
          flush(current.trimEnd());
          current = "";
          used = 0;
        } else {
          const head = current.slice(0, breakAt).trimEnd();
          const tail = current.slice(breakAt);
          flush(head);
          current = tail;
          used = displayWidth(tail);
        }
        breakAt = -1;
      }
      current += cell.open + cell.char + cell.close;
      used += cell.width;
      if (cell.char === " ") breakAt = current.length;
    }
    if (current.trim() || lines.length === 0) flush(current.trimEnd());
  }
  return lines;
}

/**
 * Terminal column count. Some environments (pty without a winsize, CI) report
 * 0 or undefined, so anything non-positive falls back to a sane default.
 */
export function terminalColumns(fallback = 80): number {
  const columns = process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : fallback;
}

/** Usable content width for the current terminal, clamped to a readable range. */
export function termWidth(): number {
  return Math.max(48, Math.min(terminalColumns(), 110));
}

/**
 * A horizontal rule that fades from the accent into the gray ramp. Falls back
 * to a flat rule when the terminal cannot do 256 colors.
 */
export function gradientRule(width: number, char = "─"): string {
  if (!has256) return c.rule(char.repeat(width));
  const ramp: ToneName[] = ["accent", "accentDim", "rule", "rule"];
  let out = "";
  for (let i = 0; i < width; i++) {
    const tone = ramp[Math.min(ramp.length - 1, Math.floor((i / width) * ramp.length))];
    out += `${toneOpen(tone)}${char}`;
  }
  return `${out}${RESET}`;
}

/** Compact token/number formatting: 1234 -> 1.2k, 1200000 -> 1.2M. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
