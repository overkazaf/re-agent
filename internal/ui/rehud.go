package ui

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/workflow"
)

// REHudModel is the reverse-engineering overlay state shown in the dashboard.
type REHudModel struct {
	SampleType string
	Phase      string
	PhaseIndex int
	PhaseCount int
	Hypotheses int
	Evidence   int
}

func renderRESection(model REHudModel, inner int) []string {
	phases := workflow.PhaseCodes
	room := inner - sectionRailWidth
	if room < 12 {
		room = 12
	}

	renderChip := func(i int, name string) string {
		switch {
		case i < model.PhaseIndex:
			return C.Muted(name)
		case i == model.PhaseIndex:
			return C.Bold(C.Accent("▸" + name))
		default:
			return C.Faint(name)
		}
	}

	var strip []string
	for i, name := range phases {
		strip = append(strip, renderChip(i, name))
	}
	phaseLine := strings.Join(strip, C.Faint("→"))
	if DisplayWidth(phaseLine) > room {
		// Window around the active phase so ANSI colors stay intact on narrow widths.
		active := model.PhaseIndex
		if active < 0 || active >= len(phases) {
			active = 0
		}
		lo, hi := active, active
		buildWindow := func(l, r int) string {
			var parts []string
			if l > 0 {
				parts = append(parts, C.Faint("…"))
			}
			for i := l; i <= r; i++ {
				parts = append(parts, renderChip(i, phases[i]))
			}
			if r < len(phases)-1 {
				parts = append(parts, C.Faint("…"))
			}
			return strings.Join(parts, C.Faint("→"))
		}
		for {
			expanded := false
			if lo > 0 && DisplayWidth(buildWindow(lo-1, hi)) <= room {
				lo--
				expanded = true
			}
			if hi < len(phases)-1 && DisplayWidth(buildWindow(lo, hi+1)) <= room {
				hi++
				expanded = true
			}
			if !expanded {
				break
			}
		}
		phaseLine = buildWindow(lo, hi)
	}

	badge := C.Reverse(" " + model.SampleType + " ")
	phaseLabel := C.Bold(C.Accent(strings.ToUpper(model.Phase)))
	barWidth := 14
	if barWidth > room/4 {
		barWidth = room / 4
	}
	if barWidth < 4 {
		barWidth = 4
	}
	phaseTotal := model.PhaseCount
	if phaseTotal <= 0 {
		phaseTotal = len(phases)
	}
	filled := ((model.PhaseIndex + 1) * barWidth) / phaseTotal
	if filled < 0 {
		filled = 0
	}
	if filled > barWidth {
		filled = barWidth
	}
	bar := C.Accent(strings.Repeat("▰", filled)) + C.Faint(strings.Repeat("▱", barWidth-filled))

	hyp := C.Accent(fmt.Sprintf("H:%d", model.Hypotheses))
	evi := C.OK(fmt.Sprintf("E:%d", model.Evidence))
	step := C.Muted(fmt.Sprintf("[%d/%d]", model.PhaseIndex+1, phaseTotal))

	statsLine := badge + " " + phaseLabel + "  " + bar + "  " + hyp + " " + evi + " " + step
	if DisplayWidth(statsLine) > room {
		statsLine = badge + " " + phaseLabel + " " + hyp + " " + evi + " " + step
	}
	if DisplayWidth(statsLine) > room {
		statsLine = badge + " " + hyp + " " + evi + " " + step
	}

	return []string{
		sectionLabel("RE") + statsLine,
		sectionLabel("") + phaseLine,
	}
}
