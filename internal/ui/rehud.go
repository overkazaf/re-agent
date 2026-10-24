package ui

import (
	"fmt"
	"strings"
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
	phases := []string{"TRI", "STA", "DYN", "EVI", "IFC", "HYP", "WRI"}

	// Phase strip: highlight current, dim past, faint future.
	var strip []string
	for i, name := range phases {
		switch {
		case i < model.PhaseIndex:
			strip = append(strip, C.Muted(name))
		case i == model.PhaseIndex:
			strip = append(strip, C.Bold(C.Accent("▸"+name)))
		default:
			strip = append(strip, C.Faint(name))
		}
	}
	phaseLine := strings.Join(strip, C.Faint("→"))

	badge := C.Reverse(" " + model.SampleType + " ")
	phaseLabel := C.Bold(C.Accent(strings.ToUpper(model.Phase)))
	barWidth := 14
	if barWidth > inner/4 {
		barWidth = inner / 4
	}
	if barWidth < 4 {
		barWidth = 4
	}
	filled := 0
	if model.PhaseCount > 0 {
		filled = (model.PhaseIndex * barWidth) / model.PhaseCount
	}
	bar := C.Accent(strings.Repeat("▰", filled)) + C.Faint(strings.Repeat("▱", barWidth-filled))

	hyp := C.Accent(fmt.Sprintf("H:%d", model.Hypotheses))
	evi := C.OK(fmt.Sprintf("E:%d", model.Evidence))
	step := C.Muted(fmt.Sprintf("[%d/%d]", model.PhaseIndex+1, model.PhaseCount))

	statsLine := badge + " " + phaseLabel + "  " + bar + "  " + hyp + " " + evi + " " + step

	return []string{
		sectionLabel("RE") + statsLine,
		sectionLabel("") + phaseLine,
	}
}
