package app

// A small raw-mode line editor: history, TAB completion, and the live
// slash-command palette. Go has no readline in the standard library, and the
// REPL's whole feel depends on those three, so they are implemented here rather
// than dropped.
//
// The redraw contract mirrors the live pane's: erase exactly what was drawn,
// then draw again. Everything is measured with the UI's display-width math so a
// CJK prompt or a wide glyph cannot desynchronise the cursor.

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/ui"
	"golang.org/x/term"
)

// ErrInterrupted is returned when the operator presses ^C at the prompt.
var ErrInterrupted = errors.New("interrupted")

type Editor struct {
	// Complete returns whole-line replacements for the current input.
	Complete func(line string) []string
	// Palette renders the suggestion panel drawn under the prompt, or "". It is
	// given the rows actually available below the caret and must not exceed
	// them: a panel taller than the screen scrolls the terminal, which strands
	// rows above the erase walk and smears the prompt down the scrollback.
	Palette func(line string, maxRows int) string

	historyFile string
	history     []string
	// last is the newest entry, to skip consecutive duplicates.
	last string

	reader *bufio.Reader
	fd     int

	mu sync.Mutex
	// lastCursor is the row the cursor sat on relative to the first prompt row,
	// which is exactly how far the next redraw has to walk back.
	lastCursor int
}

func NewEditor() *Editor {
	home, _ := os.UserHomeDir()
	editor := &Editor{
		historyFile: filepath.Join(home, ".0xaf-re-agent", "repl-history"),
		reader:      bufio.NewReader(os.Stdin),
		fd:          int(os.Stdin.Fd()),
	}
	editor.loadHistory()
	return editor
}

func (e *Editor) Interactive() bool {
	return term.IsTerminal(e.fd) && term.IsTerminal(int(os.Stdout.Fd()))
}

func (e *Editor) loadHistory() {
	data, err := os.ReadFile(e.historyFile)
	if err != nil {
		return
	}
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			e.history = append(e.history, trimmed)
		}
	}
	if len(e.history) > 1000 {
		e.history = e.history[len(e.history)-1000:]
	}
	if len(e.history) > 0 {
		e.last = e.history[len(e.history)-1]
	}
}

// AppendHistory records a line, skipping consecutive duplicates. Persistence is
// best-effort; never break the REPL over it.
func (e *Editor) AppendHistory(line string) {
	if line == e.last {
		return
	}
	e.last = line
	e.history = append(e.history, line)
	if err := os.MkdirAll(filepath.Dir(e.historyFile), 0o700); err != nil {
		return
	}
	handle, err := os.OpenFile(e.historyFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer handle.Close()
	_, _ = handle.WriteString(line + "\n")
}

// ReadLine reads one line. It returns io.EOF at end of input and ErrInterrupted
// on ^C, both of which the REPL treats as outcomes rather than failures.
func (e *Editor) ReadLine(prompt string) (string, error) {
	if !e.Interactive() {
		fmt.Print(prompt)
		line, err := e.reader.ReadString('\n')
		if err != nil && line == "" {
			return "", err
		}
		return strings.TrimRight(line, "\r\n"), nil
	}

	state, err := term.MakeRaw(e.fd)
	if err != nil {
		fmt.Print(prompt)
		line, err := e.reader.ReadString('\n')
		if err != nil && line == "" {
			return "", err
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	defer func() { _ = term.Restore(e.fd, state) }()

	var (
		buffer     []rune
		cursor     int
		historyPos = len(e.history)
		stash      string
	)
	e.lastCursor = 0
	e.redraw(prompt, string(buffer), cursor)

	finish := func(value string) (string, error) {
		e.clearPanelOnly(prompt, value)
		fmt.Print("\r\n")
		return value, nil
	}

	for {
		char, _, err := e.reader.ReadRune()
		if err != nil {
			e.clearPanelOnly(prompt, string(buffer))
			fmt.Print("\r\n")
			return "", io.EOF
		}
		switch char {
		case '\r', '\n':
			return finish(string(buffer))
		case 3: // ^C
			e.clearPanelOnly(prompt, string(buffer))
			fmt.Print("\r\n")
			return "", ErrInterrupted
		case 4: // ^D
			if len(buffer) == 0 {
				e.clearPanelOnly(prompt, "")
				fmt.Print("\r\n")
				return "", io.EOF
			}
			if cursor < len(buffer) {
				buffer = append(buffer[:cursor], buffer[cursor+1:]...)
			}
		case 1: // ^A
			cursor = 0
		case 5: // ^E
			cursor = len(buffer)
		case 21: // ^U — kill to start of line
			buffer = append([]rune{}, buffer[cursor:]...)
			cursor = 0
		case 11: // ^K — kill to end of line
			buffer = buffer[:cursor]
		case 23: // ^W — kill previous word
			start := cursor
			for start > 0 && buffer[start-1] == ' ' {
				start--
			}
			for start > 0 && buffer[start-1] != ' ' {
				start--
			}
			buffer = append(append([]rune{}, buffer[:start]...), buffer[cursor:]...)
			cursor = start
		case 12: // ^L — clear screen, keep the line
			fmt.Print("\x1b[2J\x1b[H")
			e.lastCursor = 0
		case 127, 8: // backspace
			if cursor > 0 {
				buffer = append(append([]rune{}, buffer[:cursor-1]...), buffer[cursor:]...)
				cursor--
			}
		case '\t':
			line := string(buffer)
			if e.Complete != nil {
				options := e.Complete(line)
				if len(options) == 1 {
					buffer = []rune(options[0])
					cursor = len(buffer)
				} else if len(options) > 1 {
					if shared := commonPrefix(options); len([]rune(shared)) > len(buffer) {
						buffer = []rune(shared)
						cursor = len(buffer)
					}
				}
			}
		case 27: // escape sequence
			next, _, err := e.reader.ReadRune()
			if err != nil {
				continue
			}
			if next != '[' && next != 'O' {
				continue
			}
			code, _, err := e.reader.ReadRune()
			if err != nil {
				continue
			}
			switch code {
			case 'A': // up
				if historyPos == len(e.history) {
					stash = string(buffer)
				}
				if historyPos > 0 {
					historyPos--
					buffer = []rune(e.history[historyPos])
					cursor = len(buffer)
				}
			case 'B': // down
				if historyPos < len(e.history) {
					historyPos++
					if historyPos == len(e.history) {
						buffer = []rune(stash)
					} else {
						buffer = []rune(e.history[historyPos])
					}
					cursor = len(buffer)
				}
			case 'C': // right
				if cursor < len(buffer) {
					cursor++
				}
			case 'D': // left
				if cursor > 0 {
					cursor--
				}
			case 'H':
				cursor = 0
			case 'F':
				cursor = len(buffer)
			case '3': // delete: ESC [ 3 ~
				if trailer, _, err := e.reader.ReadRune(); err == nil && trailer == '~' {
					if cursor < len(buffer) {
						buffer = append(buffer[:cursor], buffer[cursor+1:]...)
					}
				}
			}
		default:
			if char < 32 {
				continue // ignore the control codes we do not bind
			}
			buffer = append(buffer[:cursor], append([]rune{char}, buffer[cursor:]...)...)
			cursor++
		}
		e.redraw(prompt, string(buffer), cursor)
	}
}

// crlf rewrites bare line feeds into CR+LF.
//
// This is not cosmetic. term.MakeRaw clears OPOST/ONLCR, so the terminal stops
// translating "\n" for us: a bare line feed moves down one row and *keeps the
// column*. Printing a multi-row palette that way marches each row further right
// and leaves the erase walk pointing at the wrong line, which smears stale
// prompts down the screen.
func crlf(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
}

// frame is the whole redraw as one string: erase what was drawn last, paint the
// prompt, the line and the palette, then walk the cursor back to where the
// caret logically sits. Pure on purpose — the escape arithmetic is the part that
// breaks, so it has to be testable without a terminal.
//
// It returns the sequence to write and the cursor's row offset, which the next
// redraw needs to find the top of what it drew.
func frame(prompt, line string, cursor int, panel string, columns, lastCursor int) (string, int) {
	var out strings.Builder
	// Walk back to the first row of the prompt, then erase everything below.
	if lastCursor > 0 {
		fmt.Fprintf(&out, "\x1b[%dA", lastCursor)
	}
	out.WriteString("\r\x1b[J")
	out.WriteString(crlf(prompt + line))

	runes := []rune(line)
	head := prompt + string(runes[:minInt(cursor, len(runes))])
	cursorRow, cursorCol := layout(head, columns)
	rowsBelow, _ := layout(prompt+line, columns)

	if panel != "" {
		out.WriteString("\r\n")
		out.WriteString(crlf(panel))
		panelRows, _ := layout(panel, columns)
		rowsBelow += 1 + panelRows
	}
	// The cursor now sits at the end of everything drawn; walk it back up to the
	// input line and across to the caret.
	if up := rowsBelow - cursorRow; up > 0 {
		fmt.Fprintf(&out, "\x1b[%dA", up)
	}
	out.WriteString("\r")
	if cursorCol > 0 {
		fmt.Fprintf(&out, "\x1b[%dC", cursorCol)
	}
	return out.String(), cursorRow
}

// redraw erases what was last drawn and repaints prompt, line, and palette,
// leaving the cursor at its logical position on the input line.
func (e *Editor) redraw(prompt, line string, cursor int) {
	e.mu.Lock()
	defer e.mu.Unlock()

	columns := ui.TerminalColumns(80)
	if columns < 8 {
		columns = 8
	}
	panel := ""
	if e.Palette != nil {
		panel = e.Palette(line, panelBudget(prompt, line, columns))
	}
	sequence, cursorRow := frame(prompt, line, cursor, panel, columns, e.lastCursor)
	fmt.Print(sequence)
	e.lastCursor = cursorRow
}

// clearPanelOnly removes the palette and leaves prompt+line on screen, which is
// what should stay in the scrollback when a line is submitted.
func (e *Editor) clearPanelOnly(prompt, line string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.lastCursor > 0 {
		fmt.Printf("\x1b[%dA", e.lastCursor)
	}
	fmt.Print("\r\x1b[J")
	fmt.Print(crlf(prompt + line))
	e.lastCursor = 0
}

// panelBudget is how many rows the palette may occupy without scrolling the
// screen. The prompt itself can already be several rows once it wraps, and one
// row is left spare so the panel's last line never lands on the bottom edge.
func panelBudget(prompt, line string, columns int) int {
	rows := ui.TerminalRows()
	if rows <= 0 {
		rows = 24
	}
	promptRows, _ := layout(prompt+line, columns)
	budget := rows - promptRows - 3
	if budget < 0 {
		return 0
	}
	return budget
}

// layout reports the terminal row the text ends on (0-based, relative to where
// it started) and the column it leaves the cursor in. It accounts for embedded
// newlines — the approval prompt is two lines — and for soft wrapping, which is
// what keeps the erase walk in step with what the terminal actually drew.
func layout(text string, columns int) (row, col int) {
	for _, char := range ui.StripAnsi(text) {
		if char == '\n' {
			row++
			col = 0
			continue
		}
		if char == '\r' {
			col = 0
			continue
		}
		cells := ui.CharWidth(char)
		if col+cells > columns {
			row++
			col = 0
		}
		col += cells
	}
	return row, col
}

func commonPrefix(values []string) string {
	if len(values) == 0 {
		return ""
	}
	prefix := []rune(values[0])
	for _, value := range values[1:] {
		runes := []rune(value)
		limit := minInt(len(prefix), len(runes))
		index := 0
		for index < limit && prefix[index] == runes[index] {
			index++
		}
		prefix = prefix[:index]
	}
	return string(prefix)
}

// ReadSecret reads one line without echoing it, for `auth login`.
func ReadSecret(label string) (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		reader := bufio.NewReader(os.Stdin)
		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			return "", err
		}
		return strings.TrimSpace(line), nil
	}
	fmt.Print(label)
	secret, err := term.ReadPassword(fd)
	fmt.Println()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(secret)), nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
