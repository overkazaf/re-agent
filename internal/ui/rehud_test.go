package ui

import (
	"strings"
	"testing"
)

func TestRenderRESection(t *testing.T) {
	model := REHudModel{
		SampleType: "APK",
		Phase:      "static",
		PhaseIndex: 1,
		PhaseCount: 7,
		Hypotheses: 2,
		Evidence:   5,
	}
	lines := renderRESection(model, 80)
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 lines, got %d", len(lines))
	}
	plain := StripAnsi(strings.Join(lines, "\n"))
	if !strings.Contains(plain, "APK") {
		t.Fatal("sample type not found")
	}
	if !strings.Contains(plain, "H:2") {
		t.Fatal("hypothesis count not found")
	}
	if !strings.Contains(plain, "E:5") {
		t.Fatal("evidence count not found")
	}
}

func TestRenderRESectionNarrow(t *testing.T) {
	model := REHudModel{
		SampleType: "ELF",
		Phase:      "triage",
		PhaseIndex: 0,
		PhaseCount: 7,
	}
	lines := renderRESection(model, 40)
	if len(lines) == 0 {
		t.Fatal("should produce output at narrow width")
	}
}
