package ui

import (
	"strings"
	"testing"
)

func TestRenderREPicker(t *testing.T) {
	items := []REPickerItem{
		{Key: "apk", Label: "APK", Desc: "Android application package"},
		{Key: "so", Label: "SO", Desc: "shared object"},
	}
	lines := RenderREPicker(items, 80)
	if len(lines) < 5 {
		t.Fatalf("expected at least 5 lines, got %d", len(lines))
	}
	joined := strings.Join(lines, "\n")
	plain := StripAnsi(joined)
	if !strings.Contains(plain, "TARGET SELECT") {
		t.Fatal("TARGET SELECT header not found")
	}
	if !strings.Contains(plain, "APK") {
		t.Fatal("APK label not found")
	}
	if !strings.Contains(plain, "[1]") {
		t.Fatal("numbering not found")
	}
	if !strings.Contains(plain, "[s] skip") {
		t.Fatal("skip hint not found")
	}
}

func TestRenderREPromptMenu(t *testing.T) {
	prompts := []string{"Triage APK structure", "Find hardcoded secrets"}
	lines := RenderREPromptMenu("APK", prompts, 80)
	if len(lines) < 5 {
		t.Fatalf("expected at least 5 lines, got %d", len(lines))
	}
	plain := StripAnsi(strings.Join(lines, "\n"))
	if !strings.Contains(plain, "SUGGESTED PROMPTS") {
		t.Fatal("prompt menu header not found")
	}
	if !strings.Contains(plain, "Triage APK structure") {
		t.Fatal("prompt text not found")
	}
	if !strings.Contains(plain, "[c] custom") {
		t.Fatal("custom hint not found")
	}
}

func TestRenderREPickerNarrow(t *testing.T) {
	items := []REPickerItem{{Key: "elf", Label: "ELF", Desc: "Linux binary"}}
	lines := RenderREPicker(items, 20)
	if len(lines) == 0 {
		t.Fatal("should produce output even at narrow width")
	}
}

func TestReBoxLineEmpty(t *testing.T) {
	line := reBoxLine("", 0, 40)
	plain := StripAnsi(line)
	if !strings.HasPrefix(plain, "│") || !strings.HasSuffix(plain, "│") {
		t.Fatalf("box line should be bordered: %q", plain)
	}
}
