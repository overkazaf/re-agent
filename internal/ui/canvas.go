package ui

// A tiny styled character grid. Diagrams are easier to reason about as
// coordinates than as concatenated strings, but colouring per character would
// emit an escape sequence per cell — so styles are stored per cell and emitted
// as runs at render time.

import "strings"

type canvasCell struct {
	char  string
	style string
	bold  bool
	// wideTail marks the second half of a double-width glyph. It carries no
	// character of its own — it exists so column arithmetic matches what the
	// terminal actually draws.
	wideTail bool
}

type Canvas struct {
	Width  int
	Height int
	cells  [][]canvasCell
}

func NewCanvas(width, height int) *Canvas {
	cells := make([][]canvasCell, height)
	for row := range cells {
		cells[row] = make([]canvasCell, width)
		for col := range cells[row] {
			cells[row][col] = canvasCell{char: " "}
		}
	}
	return &Canvas{Width: width, Height: height, cells: cells}
}

// Put writes text at (row, col). Out-of-bounds characters are dropped, not
// wrapped — a soft-wrapped line would desynchronise the caller's erase walk.
// CJK and other double-width glyphs consume two columns, which is what the
// terminal does, so a row is never wider than Width display columns even when a
// tool name or an error message is not ASCII.
func (c *Canvas) Put(row, col int, text, style string, bold bool) {
	if row < 0 || row >= c.Height {
		return
	}
	target := col
	for _, char := range text {
		cells := CharWidth(char)
		if cells < 1 {
			cells = 1
		}
		if target < 0 {
			target += cells
			continue
		}
		if target+cells > c.Width {
			return // no room left on this row
		}
		c.cells[row][target] = canvasCell{char: string(char), style: style, bold: bold}
		for extra := 1; extra < cells; extra++ {
			c.cells[row][target+extra] = canvasCell{style: style, bold: bold, wideTail: true}
		}
		target += cells
	}
}

func (c *Canvas) Plain() []string {
	out := make([]string, c.Height)
	for row := range c.cells {
		var line strings.Builder
		for _, cell := range c.cells[row] {
			if cell.wideTail {
				continue
			}
			line.WriteString(cell.char)
		}
		out[row] = strings.TrimRight(line.String(), " ")
	}
	return out
}

func (c *Canvas) Render() []string {
	out := make([]string, c.Height)
	for row := range c.cells {
		var line strings.Builder
		run := ""
		style := ""
		bold := false
		flush := func() {
			if run == "" {
				return
			}
			line.WriteString(paintCanvas(run, style, bold))
			run = ""
		}
		for _, cell := range c.cells[row] {
			if cell.wideTail {
				continue // already drawn by its leading half
			}
			if cell.style != style || cell.bold != bold {
				flush()
				style = cell.style
				bold = cell.bold
			}
			run += cell.char
		}
		flush()
		out[row] = strings.TrimRight(line.String(), " ")
	}
	return out
}

func paintCanvas(text, style string, bold bool) string {
	painted := text
	if style != "" {
		painted = ByName(style)(text)
	}
	if bold {
		painted = C.Bold(painted)
	}
	return painted
}
