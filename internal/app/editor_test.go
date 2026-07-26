package app

import (
	"strings"
	"testing"
)

// The erase walk in redraw() is only correct if layout agrees with what the
// terminal drew. Multi-line prompts (the approval prompt is two lines) used to
// be counted as one row, which reprinted the label on every keystroke.
func TestLayoutCountsNewlinesAndWrapping(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		columns int
		row     int
		col     int
	}{
		{"single line", "abc", 20, 0, 3},
		{"embedded newline", "first line\nsecond ❯ ", 40, 1, 9},
		{"soft wrap", "0123456789abcd", 10, 1, 4},
		{"exact fill", "0123456789", 10, 0, 10},
		{"wrap past exact fill", "0123456789x", 10, 1, 1},
		{"cjk counts two", "定位校验", 20, 0, 8},
		{"cjk wraps whole glyphs", "定位校验", 5, 1, 4},
		{"ansi is invisible", "\x1b[38;5;45mabc\x1b[0m", 20, 0, 3},
		{"carriage return resets", "abcdef\rxy", 20, 0, 2},
	}
	for _, testCase := range cases {
		row, col := layout(testCase.text, testCase.columns)
		if row != testCase.row || col != testCase.col {
			t.Fatalf("%s: got (%d,%d) want (%d,%d)", testCase.name, row, col, testCase.row, testCase.col)
		}
	}
}

func TestCommonPrefix(t *testing.T) {
	if got := commonPrefix([]string{"/theme deck", "/theme dim"}); got != "/theme d" {
		t.Fatalf("prefix wrong: %q", got)
	}
	if got := commonPrefix([]string{"/read ", "/run "}); got != "/r" {
		t.Fatalf("prefix wrong: %q", got)
	}
	if got := commonPrefix(nil); got != "" {
		t.Fatalf("empty input should give an empty prefix: %q", got)
	}
}

// Raw mode clears ONLCR, so a bare "\n" in anything the editor prints moves the
// cursor down while keeping the column. That is what smeared the palette across
// the screen; nothing the editor writes may contain one.
func TestFrameNeverEmitsABareLineFeed(t *testing.T) {
	panel := "COMMANDS\n────────\n  /help   Show this deck\n  Enter runs command"
	sequence, _ := frame("auto/auto ❯ ", "/hel", 4, panel, 100, 3)
	for index := 0; index < len(sequence); index++ {
		if sequence[index] == '\n' && (index == 0 || sequence[index-1] != '\r') {
			t.Fatalf("bare line feed at offset %d in %q", index, sequence)
		}
	}
	// A two-line approval prompt is the other multi-row case.
	sequence, _ = frame("│ y run once · n skip\n❯ ", "", 0, "", 100, 0)
	for index := 0; index < len(sequence); index++ {
		if sequence[index] == '\n' && (index == 0 || sequence[index-1] != '\r') {
			t.Fatalf("bare line feed in a multi-line prompt: %q", sequence)
		}
	}
}

func TestFrameWalksBackOverEverythingItDrew(t *testing.T) {
	panel := "COMMANDS\nrule\nrow one\nrow two"
	prompt := "auto/auto ❯ "

	// Fresh prompt: nothing to erase above, four panel rows below, so the cursor
	// climbs back 1 (the blank line before the panel) + 3 (its extra rows).
	sequence, cursorRow := frame(prompt, "/h", 2, panel, 100, 0)
	if cursorRow != 0 {
		t.Fatalf("a one-row prompt puts the caret on row 0, got %d", cursorRow)
	}
	if strings.HasPrefix(sequence, "\x1b[") && strings.Contains(sequence[:6], "A") {
		t.Fatalf("nothing was drawn yet, so nothing should be erased above: %q", sequence[:12])
	}
	if !strings.Contains(sequence, "\x1b[4A") {
		t.Fatalf("expected a 4-row climb back to the input line, got %q", sequence)
	}
	// The caret sits after "auto/auto ❯ /h" — 12 columns of prompt plus 2.
	if !strings.Contains(sequence, "\x1b[14C") {
		t.Fatalf("expected the caret at column 14, got %q", sequence)
	}

	// Redrawing after that frame must first climb back over the prompt row.
	sequence, _ = frame(prompt, "/he", 3, panel, 100, 2)
	if !strings.HasPrefix(sequence, "\x1b[2A\r\x1b[J") {
		t.Fatalf("expected an erase from two rows up, got %q", sequence[:16])
	}
}

func TestFrameAccountsForSoftWrapAndWideGlyphs(t *testing.T) {
	// A line long enough to wrap once: the caret is on the second row, so the
	// next redraw has to climb one more row than an unwrapped line would.
	_, cursorRow := frame("❯ ", strings.Repeat("x", 30), 30, "", 20, 0)
	if cursorRow != 1 {
		t.Fatalf("a wrapped line puts the caret on row 1, got %d", cursorRow)
	}
	// CJK input counts two columns per glyph, so it wraps twice as early.
	_, cjkRow := frame("❯ ", strings.Repeat("定", 12), 12, "", 20, 0)
	if cjkRow != 1 {
		t.Fatalf("wide glyphs must wrap on column count, got row %d", cjkRow)
	}
}

func TestCRLFIsIdempotent(t *testing.T) {
	if got := crlf("a\nb"); got != "a\r\nb" {
		t.Fatalf("bare LF not fixed: %q", got)
	}
	if got := crlf("a\r\nb"); got != "a\r\nb" {
		t.Fatalf("CRLF must not double up: %q", got)
	}
	if got := crlf(crlf("a\nb\nc")); got != "a\r\nb\r\nc" {
		t.Fatalf("not idempotent: %q", got)
	}
}

// A palette taller than the rows below the caret scrolls the terminal, which
// strands rows above the erase walk — the other half of "the UI gets messed up
// when I type a slash".
func TestPanelBudgetLeavesRoomAndShrinksWithThePrompt(t *testing.T) {
	// TerminalRows() reports 0 under `go test` (no tty), so the 24-row floor
	// applies: 24 - 0 prompt rows - 3 spare = 21.
	if got := panelBudget("❯ ", "", 100); got != 21 {
		t.Fatalf("expected a 21-row budget on a 24-row fallback, got %d", got)
	}
	// A wrapped prompt costs the panel a row for each extra line it occupies.
	wrapped := panelBudget("❯ ", strings.Repeat("x", 250), 100)
	if wrapped != 19 {
		t.Fatalf("a 3-row prompt should leave 19, got %d", wrapped)
	}
	// It never goes negative, whatever the prompt does.
	if got := panelBudget("❯ ", strings.Repeat("x", 10_000), 40); got != 0 {
		t.Fatalf("budget must floor at zero, got %d", got)
	}
}
