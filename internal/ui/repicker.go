package ui

import (
	"fmt"
	"strings"
)

type REPickerItem struct {
	Key   string
	Label string
	Desc  string
}

func RenderREPicker(items []REPickerItem, width int) []string {
	if width < 40 {
		width = 40
	}
	inner := width - 4

	var lines []string

	title := Truncate("TARGET SELECT", maxOf(inner-4, 4))
	titleW := DisplayWidth(title)
	headPad := inner - titleW - 4
	if headPad < 0 {
		headPad = 0
	}
	lines = append(lines, C.Accent("╭─[ ")+C.Bold(C.Accent(title))+C.Accent(" ]"+strings.Repeat("─", headPad)+"╮"))

	lines = append(lines, reBoxLine("", 0, inner))

	for i, item := range items {
		num := fmt.Sprintf("[%d]", i+1)
		prefixPlain := num + " " + item.Label
		prefixW := DisplayWidth(prefixPlain)
		if prefixW >= inner {
			clipped := Truncate(prefixPlain, inner)
			lines = append(lines, reBoxLine(C.Bold(clipped), DisplayWidth(clipped), inner))
			continue
		}
		desc := Truncate(" — "+item.Desc, inner-prefixW)
		plainW := prefixW + DisplayWidth(desc)
		painted := C.Bold(C.Accent(num)) + " " + C.Bold(item.Label) + C.Muted(desc)
		lines = append(lines, reBoxLine(painted, plainW, inner))
	}

	lines = append(lines, reBoxLine("", 0, inner))
	hint := Truncate("enter number or type name, [s] skip", inner)
	lines = append(lines, reBoxLine(C.Muted(hint), DisplayWidth(hint), inner))
	lines = append(lines, C.Accent("╰"+strings.Repeat("─", inner+2)+"╯"))

	return lines
}

func RenderREPromptMenu(sampleLabel string, prompts []string, width int) []string {
	if width < 40 {
		width = 40
	}
	inner := width - 4

	var lines []string

	title := Truncate("SUGGESTED PROMPTS — "+sampleLabel, maxOf(inner-4, 4))
	titleW := DisplayWidth(title)
	headPad := inner - titleW - 4
	if headPad < 0 {
		headPad = 0
	}
	lines = append(lines, C.Accent("╭─[ ")+C.Bold(C.Accent(title))+C.Accent(" ]"+strings.Repeat("─", headPad)+"╮"))

	lines = append(lines, reBoxLine("", 0, inner))

	for i, prompt := range prompts {
		num := fmt.Sprintf("[%d]", i+1)
		numW := DisplayWidth(num)
		body := Truncate(prompt, maxOf(inner-numW-1, 1))
		plainW := numW + 1 + DisplayWidth(body)
		painted := C.Bold(C.Accent(num)) + " " + body
		lines = append(lines, reBoxLine(painted, plainW, inner))
	}

	lines = append(lines, reBoxLine("", 0, inner))
	hint := Truncate("enter number to start, [s] skip, [c] custom prompt", inner)
	lines = append(lines, reBoxLine(C.Muted(hint), DisplayWidth(hint), inner))
	lines = append(lines, C.Accent("╰"+strings.Repeat("─", inner+2)+"╯"))

	return lines
}

func reBoxLine(painted string, plainWidth, inner int) string {
	pad := inner - plainWidth
	if pad < 0 {
		pad = 0
	}
	return C.Accent("│") + " " + painted + strings.Repeat(" ", pad) + " " + C.Accent("│")
}
