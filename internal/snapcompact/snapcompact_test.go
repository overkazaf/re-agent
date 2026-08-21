package snapcompact

import (
	"bytes"
	"image/png"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestSerializeTruncatesToolResultsHeadAndTail(t *testing.T) {
	body := strings.Repeat("a", 5000)
	messages := []types.Message{
		types.Message{Role: types.MessageToolResult, ToolName: "run_command", Blocks: []types.ContentBlock{types.TextBlock(body)}},
	}
	text := Serialize(messages, SerializeOptions{ToolResultMaxChars: 200})
	if !strings.Contains(text, "# Tool result ¶ run_command") {
		t.Fatalf("tool result heading missing:\n%s", text)
	}
	if !strings.Contains(text, "[truncated]") {
		t.Fatal("truncation marker missing")
	}
	if !strings.Contains(text, strings.Repeat("a", 120)) {
		t.Fatal("head of the result should be kept")
	}
	if !strings.Contains(text, strings.Repeat("a", 80)) {
		t.Fatal("tail of the result should be kept")
	}
}

func TestSerializeCollapsesWhitespaceAndCapsArgs(t *testing.T) {
	messages := []types.Message{
		types.Message{Role: types.MessageUser, Blocks: []types.ContentBlock{types.TextBlock("first\n\n  second\tthird")}},
		types.Message{Role: types.MessageAssistant, ToolCalls: []types.ToolCall{{
			Name: "run_command", Arguments: map[string]any{"command": "strings ./chall"},
		}}},
	}
	text := Serialize(messages, SerializeOptions{})
	if !strings.Contains(text, "first second third") {
		t.Fatalf("whitespace not collapsed:\n%s", text)
	}
	if !strings.Contains(text, "# Tool call ¶ run_command") {
		t.Fatalf("tool call heading missing:\n%s", text)
	}
	if !strings.Contains(text, "strings ./chall") {
		t.Fatalf("tool call args missing:\n%s", text)
	}
}

func TestRenderProducesValidPNGFrames(t *testing.T) {
	frames, err := Render("hello snapcompact\nsecond line", RenderOptions{FrameWidth: 800, MaxFrameHeight: 800})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) == 0 {
		t.Fatal("no frames produced")
	}
	img, err := png.Decode(bytes.NewReader(frames[0]))
	if err != nil {
		t.Fatalf("frame is not a valid PNG: %v", err)
	}
	if img.Bounds().Dx() != 800 {
		t.Fatalf("frame width = %d, want 800", img.Bounds().Dx())
	}
}

func TestRenderSplitsTallArchivesIntoMultipleFrames(t *testing.T) {
	text := strings.Repeat("line of archive text\n", 200)
	frames, err := Render(text, RenderOptions{FrameWidth: 800, MaxFrameHeight: 600})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) < 2 {
		t.Fatalf("tall archive should split into multiple frames, got %d", len(frames))
	}
	for _, frame := range frames {
		img, err := png.Decode(bytes.NewReader(frame))
		if err != nil {
			t.Fatal(err)
		}
		if img.Bounds().Dy() > 600 {
			t.Fatalf("frame taller than the cap: %d", img.Bounds().Dy())
		}
	}
}

func TestHasCJK(t *testing.T) {
	if !HasCJK("定位校验函数") {
		t.Fatal("CJK not detected")
	}
	if HasCJK("plain ascii") {
		t.Fatal("ASCII wrongly detected as CJK")
	}
}

func TestRenderDeterministic(t *testing.T) {
	first, err := Render("deterministic frame", RenderOptions{FrameWidth: 800, MaxFrameHeight: 800})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Render("deterministic frame", RenderOptions{FrameWidth: 800, MaxFrameHeight: 800})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first[0], second[0]) {
		t.Fatal("same input should produce identical PNG bytes")
	}
}
