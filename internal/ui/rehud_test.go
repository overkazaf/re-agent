package ui

import (
	"strings"
	"testing"
)

func TestRenderRESection(t *testing.T) {
	model := REHudModel{
		SampleType: "APK",
		Phase:      "verify",
		PhaseIndex: 6,
		PhaseCount: 9,
		Hypotheses: 2,
		Evidence:   5,
	}
	lines := renderRESection(model, 80)
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 lines, got %d", len(lines))
	}
	plain := StripAnsi(strings.Join(lines, "\n"))
	for _, want := range []string{"APK", "H:2", "E:5", "[7/9]", "▸VER", "AUD", "WRI"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected %q in RE HUD output:\n%s", want, plain)
		}
	}
}

func TestRenderRESectionNarrow(t *testing.T) {
	model := REHudModel{
		SampleType: "ELF",
		Phase:      "audit",
		PhaseIndex: 7,
		PhaseCount: 9,
	}
	lines := renderRESection(model, 40)
	if len(lines) == 0 {
		t.Fatal("should produce output at narrow width")
	}
	for _, line := range lines {
		if w := DisplayWidth(line); w > 40 {
			t.Fatalf("narrow RE HUD line exceeded inner width 40 (%d cols): %q", w, StripAnsi(line))
		}
	}
	if !strings.Contains(StripAnsi(strings.Join(lines, "\n")), "▸AUD") {
		t.Fatalf("narrow RE HUD must keep active phase visible: %s", StripAnsi(strings.Join(lines, "\n")))
	}
}
