package app

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/workflow"
)

func runREPicker(state *State) (prompt string, ok bool) {
	types := workflow.SampleTypes()
	items := make([]ui.REPickerItem, len(types))
	for i, st := range types {
		items[i] = ui.REPickerItem{Key: st.Key, Label: st.Label, Desc: st.Desc}
	}

	w := ui.TermWidth()
	if w < 40 {
		w = 80
	}

	for _, line := range ui.RenderREPicker(items, w) {
		fmt.Println(line)
	}

	raw, err := state.editor.ReadLine(ui.REPromptLabel("target"))
	if err != nil {
		return "", false
	}
	choice := strings.TrimSpace(raw)
	if choice == "s" || choice == "S" {
		state.REState = workflow.NewREState("generic")
		return "", true
	}

	var selected *workflow.SampleType
	if n, err := strconv.Atoi(choice); err == nil && n >= 1 && n <= len(types) {
		selected = &types[n-1]
	} else {
		selected = workflow.SampleTypeByKey(strings.ToLower(choice))
	}
	if selected == nil {
		fmt.Println(ui.RenderError("unknown sample type: " + choice))
		return "", false
	}

	state.REState = workflow.NewREState(selected.Key)

	shorts := make([]string, len(selected.Prompts))
	for i, p := range selected.Prompts {
		shorts[i] = p.Short
	}
	for _, line := range ui.RenderREPromptMenu(selected.Label, shorts, w) {
		fmt.Println(line)
	}

	raw, err = state.editor.ReadLine(ui.REPromptLabel("prompt"))
	if err != nil {
		return "", true
	}
	pick := strings.TrimSpace(raw)
	if pick == "s" || pick == "S" {
		return "", true
	}
	if pick == "c" || pick == "C" {
		raw, err = state.editor.ReadLine(ui.REPromptLabel("custom"))
		if err != nil {
			return "", true
		}
		return strings.TrimSpace(raw), true
	}
	if n, err := strconv.Atoi(pick); err == nil && n >= 1 && n <= len(selected.Prompts) {
		return selected.Prompts[n-1].Full, true
	}

	return pick, true
}
