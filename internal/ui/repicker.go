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

	title := "TARGET SELECT"
	titleW := len(title)
	headPad := inner - titleW - 4
	if headPad < 0 {
		headPad = 0
	}
	lines = append(lines, C.Accent("╭─[ ")+C.Bold(C.Accent(title))+C.Accent(" ]"+strings.Repeat("─", headPad)+"╮"))

	lines = append(lines, reBoxLine("", 0, inner))

	for i, item := range items {
		num := fmt.Sprintf("[%d]", i+1)
		desc := " — " + item.Desc
		plainW := len(num) + 1 + len(item.Label) + len(desc)
		painted := C.Bold(C.Accent(num)) + " " + C.Bold(item.Label) + C.Muted(desc)
		lines = append(lines, reBoxLine(painted, plainW, inner))
	}

	lines = append(lines, reBoxLine("", 0, inner))
	hint := "enter number or type name, [s] skip"
	lines = append(lines, reBoxLine(C.Muted(hint), len(hint), inner))
	lines = append(lines, C.Accent("╰"+strings.Repeat("─", inner+2)+"╯"))

	return lines
}

func RenderREPromptMenu(sampleLabel string, prompts []string, width int) []string {
	if width < 40 {
		width = 40
	}
	inner := width - 4

	var lines []string

	title := "SUGGESTED PROMPTS — " + sampleLabel
	titleW := len(title)
	headPad := inner - titleW - 4
	if headPad < 0 {
		headPad = 0
	}
	lines = append(lines, C.Accent("╭─[ ")+C.Bold(C.Accent(title))+C.Accent(" ]"+strings.Repeat("─", headPad)+"╮"))

	lines = append(lines, reBoxLine("", 0, inner))

	for i, prompt := range prompts {
		num := fmt.Sprintf("[%d]", i+1)
		plainW := len(num) + 1 + len(prompt)
		painted := C.Bold(C.Accent(num)) + " " + prompt
		lines = append(lines, reBoxLine(painted, plainW, inner))
	}

	lines = append(lines, reBoxLine("", 0, inner))
	hint := "enter number to start, [s] skip, [c] custom prompt"
	lines = append(lines, reBoxLine(C.Muted(hint), len(hint), inner))
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
