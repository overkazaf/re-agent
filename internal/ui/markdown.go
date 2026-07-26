package ui

// Minimal markdown -> ANSI renderer for model output. Model replies are
// markdown; dumping them raw into a terminal is the single ugliest thing a CLI
// agent can do. This handles the subset that actually shows up in practice:
// headings, fenced code, lists, blockquotes, rules, tables, and inline spans.

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	fenceRE    = regexp.MustCompile("^\\s*(`{3,}|~{3,})\\s*([\\w+-]*)\\s*$")
	headingRE2 = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	bulletRE2  = regexp.MustCompile(`^(\s*)[-*+]\s+(.*)$`)
	orderedRE  = regexp.MustCompile(`^(\s*)(\d+)[.)]\s+(.*)$`)
	quoteRE    = regexp.MustCompile(`^\s*>\s?(.*)$`)
	ruleRE     = regexp.MustCompile(`^\s*(?:-{3,}|\*{3,}|_{3,})\s*$`)
	tableSepRE = regexp.MustCompile(`^\s*\|?[\s:|-]+$`)
)

// RenderMarkdown renders markdown source into ANSI-styled lines of at most
// `width` columns.
func RenderMarkdown(source string, width int) string {
	lines := strings.Split(strings.ReplaceAll(source, "\r\n", "\n"), "\n")
	var out []string
	fence := ""
	codeLang := ""
	var code []string
	var tableBuffer []string

	flushTable := func() {
		if len(tableBuffer) == 0 {
			return
		}
		out = append(out, renderTable(tableBuffer, width)...)
		tableBuffer = nil
	}

	for _, raw := range lines {
		fenceMatch := fenceRE.FindStringSubmatch(raw)
		if fence != "" {
			if fenceMatch != nil && strings.HasPrefix(fenceMatch[1], fence[:1]) && len(fenceMatch[1]) >= len(fence) {
				out = append(out, renderCode(code, codeLang, width)...)
				fence = ""
				code = nil
				continue
			}
			code = append(code, raw)
			continue
		}
		if fenceMatch != nil {
			flushTable()
			fence = fenceMatch[1]
			codeLang = fenceMatch[2]
			code = nil
			continue
		}

		// Pipe tables are buffered so columns can be measured together.
		if strings.HasPrefix(strings.TrimSpace(raw), "|") ||
			(len(tableBuffer) > 0 && strings.Contains(raw, "|")) {
			tableBuffer = append(tableBuffer, raw)
			continue
		}
		flushTable()

		if strings.TrimSpace(raw) == "" {
			if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
				out = append(out, "")
			}
			continue
		}

		if heading := headingRE2.FindStringSubmatch(raw); heading != nil {
			out = append(out, renderHeading(len(heading[1]), heading[2], width)...)
			continue
		}

		if ruleRE.MatchString(raw) {
			out = append(out, GradientRule(minOf(width, 48)))
			continue
		}

		if quote := quoteRE.FindStringSubmatch(raw); quote != nil {
			for _, line := range WrapAnsi(inlineSpans(quote[1]), width-2, "") {
				out = append(out, C.VioletDim("▌")+" "+C.Muted(line))
			}
			continue
		}

		if bullet := bulletRE2.FindStringSubmatch(raw); bullet != nil {
			depth := len(bullet[1]) / 2
			pad := strings.Repeat("  ", depth)
			marker := C.Accent("▸")
			if depth > 0 {
				marker = C.Faint("·")
			}
			indent := pad + "  "
			wrapped := WrapAnsi(inlineSpans(bullet[2]), width-DisplayWidth(indent), indent)
			head := ""
			if len(wrapped) > 0 {
				head = wrapped[0]
			}
			out = append(out, pad+marker+" "+head)
			if len(wrapped) > 1 {
				out = append(out, wrapped[1:]...)
			}
			continue
		}

		if ordered := orderedRE.FindStringSubmatch(raw); ordered != nil {
			pad := strings.Repeat(" ", len(ordered[1]))
			marker := C.Accent(ordered[2] + ".")
			indent := pad + strings.Repeat(" ", len(ordered[2])+2)
			wrapped := WrapAnsi(inlineSpans(ordered[3]), width-DisplayWidth(indent), indent)
			head := ""
			if len(wrapped) > 0 {
				head = wrapped[0]
			}
			out = append(out, pad+marker+" "+head)
			if len(wrapped) > 1 {
				out = append(out, wrapped[1:]...)
			}
			continue
		}

		out = append(out, WrapAnsi(inlineSpans(strings.TrimSpace(raw)), width, "")...)
	}

	flushTable()
	if fence != "" {
		out = append(out, renderCode(code, codeLang, width)...) // unterminated fence
	}

	// Block renderers each emit a leading blank for breathing room; collapse the
	// runs that creates, and trim the edges.
	var tidy []string
	for _, line := range out {
		if strings.TrimSpace(line) == "" && (len(tidy) == 0 || strings.TrimSpace(tidy[len(tidy)-1]) == "") {
			continue
		}
		tidy = append(tidy, line)
	}
	for len(tidy) > 0 && strings.TrimSpace(tidy[len(tidy)-1]) == "" {
		tidy = tidy[:len(tidy)-1]
	}
	return strings.Join(tidy, "\n")
}

func renderHeading(level int, text string, width int) []string {
	content := inlineSpans(text)
	if level <= 2 {
		ruleWidth := DisplayWidth(content) + 6
		if ruleWidth < 12 {
			ruleWidth = 12
		}
		return []string{"", C.Bold(C.Accent(content)), GradientRule(minOf(width, ruleWidth))}
	}
	return []string{"", C.AccentDim("▍") + " " + C.Bold(C.Text(content))}
}

func renderCode(lines []string, lang string, width int) []string {
	tag := C.Faint(" code")
	if lang != "" {
		tag = C.Faint(" " + lang)
	}
	out := []string{"", C.Rule("┌") + C.Rule("─") + tag}
	inner := width - 2
	for _, line := range lines {
		clipped := line
		// Code must not be re-wrapped on words; clip long lines with a marker.
		if DisplayWidth(line) > inner {
			clipped = sliceToWidth(line, inner-1) + C.Faint("›")
		}
		out = append(out, C.Rule("▏")+" "+C.Violet(clipped))
	}
	return append(out, C.Rule("└─"))
}

func sliceToWidth(value string, width int) string {
	var out strings.Builder
	used := 0
	for _, char := range value {
		w := CharWidth(char)
		if used+w > width {
			break
		}
		out.WriteRune(char)
		used += w
	}
	return out.String()
}

func renderTable(rows []string, width int) []string {
	var grid [][]string
	for _, row := range rows {
		if strings.TrimSpace(row) == "" || tableSepRE.MatchString(row) {
			continue
		}
		trimmed := strings.TrimSpace(row)
		trimmed = strings.TrimPrefix(trimmed, "|")
		trimmed = strings.TrimSuffix(trimmed, "|")
		var cells []string
		for _, cell := range strings.Split(trimmed, "|") {
			cells = append(cells, inlineSpans(strings.TrimSpace(cell)))
		}
		grid = append(grid, cells)
	}
	if len(grid) == 0 {
		return nil
	}

	columns := 0
	for _, row := range grid {
		if len(row) > columns {
			columns = len(row)
		}
	}
	widths := make([]int, columns)
	for index := 0; index < columns; index++ {
		for _, row := range grid {
			if index < len(row) && DisplayWidth(row[index]) > widths[index] {
				widths[index] = DisplayWidth(row[index])
			}
		}
	}
	// Shrink proportionally if the table would overflow the terminal.
	total := 1
	sum := 0
	for _, w := range widths {
		total += w + 3
		sum += w
	}
	if total > width && sum > 0 {
		scale := float64(width-columns*3-1) / float64(sum)
		for index := range widths {
			scaled := int(float64(widths[index]) * scale)
			if scaled < 4 {
				scaled = 4
			}
			widths[index] = scaled
		}
	}

	out := []string{""}
	for index, row := range grid {
		cells := make([]string, columns)
		for column := 0; column < columns; column++ {
			value := ""
			if column < len(row) {
				value = row[column]
			}
			cells[column] = PadEnd(clipCell(value, widths[column]), widths[column])
		}
		line := strings.Join(cells, C.Rule(" │ "))
		if index == 0 {
			out = append(out, C.Bold(line))
			var dividers []string
			for _, w := range widths {
				dividers = append(dividers, strings.Repeat("─", w))
			}
			out = append(out, C.Rule(strings.Join(dividers, "─┼─")))
			continue
		}
		out = append(out, line)
	}
	return out
}

func clipCell(value string, width int) string {
	if DisplayWidth(value) <= width {
		return value
	}
	return sliceToWidth(StripAnsi(value), width-1) + "…"
}

var (
	codeSpanRE    = regexp.MustCompile("`([^`]+)`")
	linkRE        = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	boldRE        = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	boldUnderRE   = regexp.MustCompile(`(^|[\s(])__([^_]+)__`)
	italicRE      = regexp.MustCompile(`(^|[\s(])\*([^*\n]+)\*`)
	strikeRE      = regexp.MustCompile(`~~([^~]+)~~`)
	placeholderRE = regexp.MustCompile("\x00(\\d+)\x00")
)

// inlineSpans renders code, bold, italic, links, and strikethrough.
func inlineSpans(value string) string {
	// Inline code first so its contents are not re-processed as emphasis. NUL
	// delimiters keep the placeholder unambiguous against the source text.
	var codeSpans []string
	out := codeSpanRE.ReplaceAllStringFunc(value, func(match string) string {
		body := codeSpanRE.FindStringSubmatch(match)[1]
		codeSpans = append(codeSpans, body)
		return fmt.Sprintf("\x00%d\x00", len(codeSpans)-1)
	})
	out = linkRE.ReplaceAllStringFunc(out, func(match string) string {
		parts := linkRE.FindStringSubmatch(match)
		return C.Underline(C.Accent(parts[1])) + C.Faint(" "+parts[2])
	})
	out = boldRE.ReplaceAllStringFunc(out, func(match string) string {
		return C.Bold(C.Text(boldRE.FindStringSubmatch(match)[1]))
	})
	out = boldUnderRE.ReplaceAllStringFunc(out, func(match string) string {
		parts := boldUnderRE.FindStringSubmatch(match)
		return parts[1] + C.Bold(C.Text(parts[2]))
	})
	out = italicRE.ReplaceAllStringFunc(out, func(match string) string {
		parts := italicRE.FindStringSubmatch(match)
		return parts[1] + C.Italic(parts[2])
	})
	out = strikeRE.ReplaceAllStringFunc(out, func(match string) string {
		return C.Faint(strikeRE.FindStringSubmatch(match)[1])
	})
	out = placeholderRE.ReplaceAllStringFunc(out, func(match string) string {
		index, err := strconv.Atoi(placeholderRE.FindStringSubmatch(match)[1])
		if err != nil || index >= len(codeSpans) {
			return ""
		}
		return C.Violet(codeSpans[index])
	})
	return out
}
