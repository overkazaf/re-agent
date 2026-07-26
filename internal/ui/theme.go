// Package ui owns everything the operator sees: the palette, the live HUD, the
// dataflow diagram, the trace lines, and the markdown renderer.
//
// Terminal theme: color-depth detection, a restrained palette, and CJK/emoji
// aware width math. Everything that needs to know how wide a glyph renders goes
// through DisplayWidth so box layouts stay aligned for mixed output.
package ui

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/term"
)

type tone struct {
	rgb   [3]int
	x256  int
	basic int
}

type palette struct {
	accent    tone
	accentDim tone
	violet    tone
	violetDim tone
	ok        tone
	warn      tone
	err       tone
	text      tone
	muted     tone
	faint     tone
	rule      tone
}

// deck is the default cyberdeck palette: one accent (cyan), one secondary
// (violet), semantic green/amber/red, and a deep gray ramp for the chrome.
var deck = palette{
	accent:    tone{[3]int{34, 211, 238}, 45, 36},
	accentDim: tone{[3]int{14, 116, 144}, 30, 36},
	violet:    tone{[3]int{167, 139, 250}, 141, 35},
	violetDim: tone{[3]int{91, 71, 156}, 97, 35},
	ok:        tone{[3]int{74, 222, 128}, 114, 32},
	warn:      tone{[3]int{251, 191, 36}, 214, 33},
	err:       tone{[3]int{248, 113, 113}, 203, 31},
	text:      tone{[3]int{229, 231, 235}, 253, 37},
	muted:     tone{[3]int{148, 163, 184}, 245, 37},
	faint:     tone{[3]int{100, 116, 139}, 242, 90},
	rule:      tone{[3]int{51, 65, 85}, 238, 90},
}

// amber is an amber CRT: everything sits in the amber family; only errors break
// out, since legibility of a failure beats palette purity.
var amber = palette{
	accent:    tone{[3]int{255, 176, 0}, 214, 33},
	accentDim: tone{[3]int{166, 112, 0}, 136, 33},
	violet:    tone{[3]int{255, 210, 127}, 222, 33},
	violetDim: tone{[3]int{140, 100, 40}, 94, 33},
	ok:        tone{[3]int{255, 214, 51}, 220, 33},
	warn:      tone{[3]int{255, 149, 0}, 208, 33},
	err:       tone{[3]int{255, 95, 86}, 203, 31},
	text:      tone{[3]int{255, 204, 102}, 221, 37},
	muted:     tone{[3]int{193, 143, 43}, 178, 33},
	faint:     tone{[3]int{125, 88, 20}, 94, 90},
	rule:      tone{[3]int{74, 52, 12}, 58, 90},
}

// matrix is green phosphor.
var matrix = palette{
	accent:    tone{[3]int{0, 255, 156}, 48, 32},
	accentDim: tone{[3]int{0, 168, 104}, 35, 32},
	violet:    tone{[3]int{124, 255, 178}, 121, 32},
	violetDim: tone{[3]int{40, 120, 80}, 29, 32},
	ok:        tone{[3]int{0, 255, 156}, 48, 32},
	warn:      tone{[3]int{255, 209, 102}, 221, 33},
	err:       tone{[3]int{255, 107, 107}, 203, 31},
	text:      tone{[3]int{200, 255, 217}, 194, 37},
	muted:     tone{[3]int{78, 142, 106}, 71, 32},
	faint:     tone{[3]int{47, 92, 70}, 65, 90},
	rule:      tone{[3]int{30, 58, 44}, 236, 90},
}

// mono is hueless: for screenshots, e-ink, and anyone who reads color badly;
// contrast carries the hierarchy instead of hue.
var mono = palette{
	accent:    tone{[3]int{255, 255, 255}, 231, 37},
	accentDim: tone{[3]int{160, 160, 160}, 247, 37},
	violet:    tone{[3]int{214, 214, 214}, 252, 37},
	violetDim: tone{[3]int{120, 120, 120}, 244, 90},
	ok:        tone{[3]int{235, 235, 235}, 255, 37},
	warn:      tone{[3]int{190, 190, 190}, 250, 37},
	err:       tone{[3]int{255, 255, 255}, 231, 37},
	text:      tone{[3]int{224, 224, 224}, 253, 37},
	muted:     tone{[3]int{150, 150, 150}, 246, 37},
	faint:     tone{[3]int{110, 110, 110}, 243, 90},
	rule:      tone{[3]int{68, 68, 68}, 238, 90},
}

var themes = map[string]palette{"deck": deck, "amber": amber, "matrix": matrix, "mono": mono}

var ThemeNames = []string{"deck", "amber", "matrix", "mono"}

var ThemeBlurbs = map[string]string{
	"deck":   "cyan + violet cyberdeck (default)",
	"amber":  "amber CRT phosphor",
	"matrix": "green phosphor terminal",
	"mono":   "hueless, contrast-only",
}

var (
	themeMu     sync.RWMutex
	activeTheme = "deck"
)

func SetTheme(name string) {
	themeMu.Lock()
	defer themeMu.Unlock()
	if _, ok := themes[name]; ok {
		activeTheme = name
	}
}

func CurrentTheme() string {
	themeMu.RLock()
	defer themeMu.RUnlock()
	return activeTheme
}

func IsThemeName(value string) bool {
	_, ok := themes[value]
	return ok
}

func current() palette {
	themeMu.RLock()
	defer themeMu.RUnlock()
	return themes[activeTheme]
}

var (
	colorEnabled bool
	truecolor    bool
	has256       bool
)

func init() {
	noColor := os.Getenv("NO_COLOR") != ""
	forced := os.Getenv("FORCE_COLOR") != ""
	isTTY := term.IsTerminal(int(os.Stdout.Fd()))
	colorEnabled = !noColor && (isTTY || forced)
	colorterm := os.Getenv("COLORTERM")
	termName := os.Getenv("TERM")
	truecolor = colorEnabled && regexp.MustCompile(`(?i)truecolor|24bit`).MatchString(colorterm)
	has256 = colorEnabled && (truecolor ||
		regexp.MustCompile(`(?i)256|kitty|alacritty|ghostty`).MatchString(termName) ||
		os.Getenv("TERM_PROGRAM") != "")
}

// ColorEnabled reports whether escapes are being emitted at all.
func ColorEnabled() bool { return colorEnabled }

func foreground(t tone) string {
	if !colorEnabled {
		return ""
	}
	if truecolor {
		return fmt.Sprintf("\x1b[38;2;%d;%d;%dm", t.rgb[0], t.rgb[1], t.rgb[2])
	}
	if has256 {
		return fmt.Sprintf("\x1b[38;5;%dm", t.x256)
	}
	return fmt.Sprintf("\x1b[%dm", t.basic)
}

func reset() string {
	if !colorEnabled {
		return ""
	}
	return "\x1b[0m"
}

func wrapColor(open, value string) string {
	if !colorEnabled || open == "" {
		return value
	}
	return open + value + reset()
}

// Painter is a named color function, e.g. C.Accent("0xAF").
type Painter func(string) string

type painters struct {
	Accent    Painter
	AccentDim Painter
	Violet    Painter
	VioletDim Painter
	OK        Painter
	Warn      Painter
	Err       Painter
	Text      Painter
	Muted     Painter
	Faint     Painter
	Rule      Painter
	Bold      Painter
	Dim       Painter
	Italic    Painter
	Underline Painter
	Reverse   Painter
}

// tonePainter resolves the palette per call, not at capture time, so /theme
// takes effect immediately.
func tonePainter(pick func(palette) tone) Painter {
	return func(value string) string { return wrapColor(foreground(pick(current())), value) }
}

// C holds every painter used across the UI.
var C = painters{
	Accent:    tonePainter(func(p palette) tone { return p.accent }),
	AccentDim: tonePainter(func(p palette) tone { return p.accentDim }),
	Violet:    tonePainter(func(p palette) tone { return p.violet }),
	VioletDim: tonePainter(func(p palette) tone { return p.violetDim }),
	OK:        tonePainter(func(p palette) tone { return p.ok }),
	Warn:      tonePainter(func(p palette) tone { return p.warn }),
	Err:       tonePainter(func(p palette) tone { return p.err }),
	Text:      tonePainter(func(p palette) tone { return p.text }),
	Muted:     tonePainter(func(p palette) tone { return p.muted }),
	Faint:     tonePainter(func(p palette) tone { return p.faint }),
	Rule:      tonePainter(func(p palette) tone { return p.rule }),
	Bold:      func(value string) string { return wrapColor("\x1b[1m", value) },
	Dim:       func(value string) string { return wrapColor("\x1b[2m", value) },
	Italic:    func(value string) string { return wrapColor("\x1b[3m", value) },
	Underline: func(value string) string { return wrapColor("\x1b[4m", value) },
	Reverse:   func(value string) string { return wrapColor("\x1b[7m", value) },
}

// ByName resolves a style name for the canvas.
func ByName(name string) Painter {
	switch name {
	case "accent":
		return C.Accent
	case "accentDim":
		return C.AccentDim
	case "violet":
		return C.Violet
	case "violetDim":
		return C.VioletDim
	case "ok":
		return C.OK
	case "warn":
		return C.Warn
	case "err":
		return C.Err
	case "text":
		return C.Text
	case "muted":
		return C.Muted
	case "faint":
		return C.Faint
	case "rule":
		return C.Rule
	}
	return func(value string) string { return value }
}

// Fade paints text at position t (0..1) along the ramp between two tones. Used
// for the logo's CRT-style vertical falloff. Without truecolor it snaps to the
// nearer endpoint, which still reads as a fade.
func Fade(from, to string, t float64, value string) string {
	if !colorEnabled {
		return value
	}
	fromTone := toneByName(from)
	toTone := toneByName(to)
	if !truecolor {
		if t < 0.5 {
			return wrapColor(foreground(fromTone), value)
		}
		return wrapColor(foreground(toTone), value)
	}
	clamped := math.Min(1, math.Max(0, t))
	mix := func(index int) int {
		a := float64(fromTone.rgb[index])
		b := float64(toTone.rgb[index])
		return int(math.Round(a + (b-a)*clamped))
	}
	return wrapColor(fmt.Sprintf("\x1b[38;2;%d;%d;%dm", mix(0), mix(1), mix(2)), value)
}

func toneByName(name string) tone {
	p := current()
	switch name {
	case "accent":
		return p.accent
	case "accentDim":
		return p.accentDim
	case "violet":
		return p.violet
	case "violetDim":
		return p.violetDim
	case "ok":
		return p.ok
	case "warn":
		return p.warn
	case "err":
		return p.err
	case "text":
		return p.text
	case "muted":
		return p.muted
	case "faint":
		return p.faint
	}
	return p.rule
}

func toneOpen(name string) string { return foreground(toneByName(name)) }

// --- width math --------------------------------------------------------------

var ansiFullRE = regexp.MustCompile("\x1b\\[[0-9;?]*[a-zA-Z]|\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)")

func StripAnsi(value string) string { return ansiFullRE.ReplaceAllString(value, "") }

// isZeroWidth covers combining marks and explicit zero-width/format characters.
func isZeroWidth(code rune) bool {
	return (code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code == 0xfeff
}

// isWide covers CJK, Hangul, fullwidth forms, and the common emoji planes.
func isWide(code rune) bool {
	switch {
	case code >= 0x1100 && code <= 0x115f,
		code >= 0x2e80 && code <= 0x303e,
		code >= 0x3041 && code <= 0x33ff,
		code >= 0x3400 && code <= 0x4dbf,
		code >= 0x4e00 && code <= 0x9fff,
		code >= 0xa000 && code <= 0xa4cf,
		code >= 0xac00 && code <= 0xd7a3,
		code >= 0xf900 && code <= 0xfaff,
		code >= 0xfe10 && code <= 0xfe19,
		code >= 0xfe30 && code <= 0xfe6f,
		code >= 0xff00 && code <= 0xff60,
		code >= 0xffe0 && code <= 0xffe6,
		code >= 0x1f300 && code <= 0x1f64f,
		code >= 0x1f680 && code <= 0x1f6ff,
		code >= 0x1f900 && code <= 0x1f9ff,
		code >= 0x20000 && code <= 0x3fffd:
		return true
	}
	return false
}

func CharWidth(char rune) int {
	if isZeroWidth(char) {
		return 0
	}
	if isWide(char) {
		return 2
	}
	return 1
}

// DisplayWidth is the rendered column count, ignoring ANSI escapes and counting
// CJK as 2.
func DisplayWidth(value string) int {
	total := 0
	for _, char := range StripAnsi(value) {
		total += CharWidth(char)
	}
	return total
}

func PadEnd(value string, width int) string {
	gap := width - DisplayWidth(value)
	if gap > 0 {
		return value + strings.Repeat(" ", gap)
	}
	return value
}

func PadStart(value string, width int) string {
	gap := width - DisplayWidth(value)
	if gap > 0 {
		return strings.Repeat(" ", gap) + value
	}
	return value
}

// Truncate cuts to `width` columns, appending an ellipsis when clipped. Not
// ANSI-safe: it drops color when it clips, which is why width math elsewhere
// runs on plain text and paints afterwards.
func Truncate(value string, width int) string {
	if DisplayWidth(value) <= width {
		return value
	}
	var out strings.Builder
	used := 0
	for _, char := range StripAnsi(value) {
		w := CharWidth(char)
		if used+w > width-1 {
			break
		}
		out.WriteRune(char)
		used += w
	}
	return out.String() + "…"
}

// ElidePath middle-elides a path so both the head and the filename stay readable.
func ElidePath(value string, width int) string {
	home := os.Getenv("HOME")
	compact := value
	if home != "" && strings.HasPrefix(value, home) {
		compact = "~" + value[len(home):]
	}
	if len(compact) <= width {
		return compact
	}
	if width < 3 {
		return compact
	}
	return "…" + compact[len(compact)-(width-2):]
}

type cell struct {
	open  string
	char  string
	close string
	width int
}

func toCells(value string) []cell {
	var cells []cell
	pending := ""
	index := 0
	for index < len(value) {
		if location := ansiFullRE.FindStringIndex(value[index:]); location != nil && location[0] == 0 {
			pending += value[index : index+location[1]]
			index += location[1]
			continue
		}
		char := []rune(value[index:])[0]
		size := len(string(char))
		cells = append(cells, cell{open: pending, char: string(char), width: CharWidth(char)})
		pending = ""
		index += size
	}
	// Trailing escapes close the final glyph; they must stay *after* it, or a
	// reset would land before the last character and strip its color.
	if pending != "" && len(cells) > 0 {
		cells[len(cells)-1].close += pending
	}
	return cells
}

// WrapAnsi is an ANSI-aware word wrap. It breaks on spaces for latin text and
// between glyphs for CJK runs (which carry no spaces), so Chinese output wraps
// at the right column instead of overflowing the terminal.
func WrapAnsi(value string, width int, hangingIndent string) []string {
	if width <= 4 {
		return []string{value}
	}
	var lines []string
	for _, paragraph := range strings.Split(value, "\n") {
		cells := toCells(paragraph)
		if len(cells) == 0 {
			lines = append(lines, "")
			continue
		}
		current := ""
		used := 0
		breakAt := -1 // index in `current` just after the last space
		first := true
		limit := func() int {
			if first {
				return width
			}
			return width - DisplayWidth(hangingIndent)
		}
		flush := func(text string) {
			if first {
				lines = append(lines, text)
			} else {
				lines = append(lines, hangingIndent+text)
			}
			first = false
		}
		for _, item := range cells {
			wideBreak := item.width == 2
			if used+item.width > limit() && used > 0 {
				if wideBreak || breakAt < 0 {
					flush(strings.TrimRight(current, " "))
					current = ""
					used = 0
				} else {
					head := strings.TrimRight(current[:breakAt], " ")
					tail := current[breakAt:]
					flush(head)
					current = tail
					used = DisplayWidth(tail)
				}
				breakAt = -1
			}
			current += item.open + item.char + item.close
			used += item.width
			if item.char == " " {
				breakAt = len(current)
			}
		}
		if strings.TrimSpace(current) != "" || len(lines) == 0 {
			flush(strings.TrimRight(current, " "))
		}
	}
	return lines
}

// TerminalColumns falls back to a sane default when the environment (a pty
// without a winsize, CI) reports nothing usable.
func TerminalColumns(fallback int) int {
	if width, _, err := term.GetSize(int(os.Stdout.Fd())); err == nil && width > 0 {
		return width
	}
	return fallback
}

func TerminalRows() int {
	if _, height, err := term.GetSize(int(os.Stdout.Fd())); err == nil && height > 0 {
		return height
	}
	return 0
}

// TermWidth is the usable content width, clamped to a readable range.
func TermWidth() int {
	columns := TerminalColumns(80)
	if columns < 48 {
		return 48
	}
	if columns > 110 {
		return 110
	}
	return columns
}

// GradientRule fades from the accent into the gray ramp. Falls back to a flat
// rule when the terminal cannot do 256 colors.
func GradientRule(width int) string {
	return gradientRuleChar(width, "─")
}

func gradientRuleChar(width int, char string) string {
	if width < 1 {
		return ""
	}
	if !has256 {
		return C.Rule(strings.Repeat(char, width))
	}
	ramp := []string{"accent", "accentDim", "rule", "rule"}
	var out strings.Builder
	for i := 0; i < width; i++ {
		index := int(float64(i) / float64(width) * float64(len(ramp)))
		if index > len(ramp)-1 {
			index = len(ramp) - 1
		}
		out.WriteString(toneOpen(ramp[index]))
		out.WriteString(char)
	}
	return out.String() + reset()
}

// CompactNumber formats counts as 1.2k / 1.2M.
func CompactNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "0"
	}
	abs := math.Abs(value)
	if abs < 1000 {
		return fmt.Sprintf("%d", int(math.Round(value)))
	}
	if abs < 1_000_000 {
		if value < 10_000 {
			return fmt.Sprintf("%.1fk", value/1000)
		}
		return fmt.Sprintf("%.0fk", value/1000)
	}
	return fmt.Sprintf("%.1fM", value/1_000_000)
}

func FormatDuration(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	if ms < 60_000 {
		return fmt.Sprintf("%.1fs", float64(ms)/1000)
	}
	minutes := ms / 60_000
	seconds := int(math.Round(float64(ms%60_000) / 1000))
	return fmt.Sprintf("%dm%02ds", minutes, seconds)
}
