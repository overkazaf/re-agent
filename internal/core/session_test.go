package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestSessionRoundTrip(t *testing.T) {
	dir := t.TempDir()
	session := NewSession(dir, "test")
	if err := session.Init(map[string]any{"workspace": "/tmp/ws"}); err != nil {
		t.Fatal(err)
	}
	if err := session.AppendMessage(types.UserMessage("first prompt")); err != nil {
		t.Fatal(err)
	}
	assistant := types.Message{
		Role: types.MessageAssistant, Provider: "mock",
		Blocks:    []types.ContentBlock{types.TextBlock("answer")},
		ToolCalls: []types.ToolCall{{ID: "call_1", Name: "grep", Arguments: map[string]any{"pattern": "flag"}}},
	}
	if err := session.AppendMessage(assistant); err != nil {
		t.Fatal(err)
	}
	if err := session.AppendMessage(toolResult("call_1", "grep", "hit")); err != nil {
		t.Fatal(err)
	}
	if err := session.AppendEvent(map[string]any{
		"type": "plan", "source": "update_plan",
		"steps": []types.PlanStep{{Text: "look", Status: types.StepCompleted}},
	}); err != nil {
		t.Fatal(err)
	}

	loaded, err := LoadSession(session.File)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(loaded.Messages))
	}
	if loaded.Messages[1].ToolCalls[0].Arguments["pattern"] != "flag" {
		t.Fatalf("tool call arguments lost: %+v", loaded.Messages[1].ToolCalls)
	}
	if loaded.Plan == nil || len(loaded.Plan.Steps) != 1 {
		t.Fatalf("plan not restored: %+v", loaded.Plan)
	}
	if loaded.Meta["workspace"] != "/tmp/ws" {
		t.Fatalf("meta lost: %+v", loaded.Meta)
	}

	summaries := ListSessions(dir, 10)
	if len(summaries) != 1 || summaries[0].FirstPrompt != "first prompt" {
		t.Fatalf("unexpected summary: %+v", summaries)
	}
	if ResolveSession(dir, summaries[0].ID[:8]) == nil {
		t.Fatal("id prefix did not resolve")
	}
}

func TestLoadSessionRepairsDanglingToolCalls(t *testing.T) {
	dir := t.TempDir()
	session := NewSession(dir, "test")
	if err := session.Init(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	_ = session.AppendMessage(types.UserMessage("go"))
	_ = session.AppendMessage(types.Message{
		Role:      types.MessageAssistant,
		Blocks:    []types.ContentBlock{types.TextBlock("working on it")},
		ToolCalls: []types.ToolCall{{ID: "never-answered", Name: "run_command"}},
	})
	// Simulate a kill mid-write: a truncated final line.
	handle, err := os.OpenFile(session.File, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = handle.WriteString(`{"type":"message","timestamp":"2026`)
	_ = handle.Close()

	loaded, err := LoadSession(session.File)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range loaded.Messages {
		if len(message.ToolCalls) > 0 {
			t.Fatalf("unanswered tool call survived: %+v", message.ToolCalls)
		}
	}
	if len(loaded.Messages) != 2 {
		t.Fatalf("expected the assistant text to survive, got %d messages", len(loaded.Messages))
	}
}

func TestSessionFileNameIsSortable(t *testing.T) {
	dir := t.TempDir()
	session := NewSession(dir, "0xaf")
	name := filepath.Base(session.File)
	if !strings.HasSuffix(name, "-0xaf.jsonl") || !strings.HasPrefix(name, "20") {
		t.Fatalf("unexpected session file name: %s", name)
	}
}

// A corrupt mid-file line makes readEntries skip it, which can strand a tool
// result whose assistant call never loaded. Providers reject that shape just as
// hard as the dangling call in the other direction.
func TestLoadSessionDropsOrphanToolResults(t *testing.T) {
	dir := t.TempDir()
	session := NewSession(dir, "test")
	if err := session.Init(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	_ = session.AppendMessage(types.UserMessage("go"))
	// The assistant turn that issued call_1 is missing entirely.
	_ = session.AppendMessage(toolResult("call_1", "run_command", "output nobody asked for"))
	_ = session.AppendMessage(types.Message{
		Role:   types.MessageAssistant,
		Blocks: []types.ContentBlock{types.TextBlock("done")},
	})

	loaded, err := LoadSession(session.File)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range loaded.Messages {
		if message.Role == types.MessageToolResult {
			t.Fatalf("orphan tool result survived: %+v", message)
		}
	}
	if len(loaded.Messages) != 2 {
		t.Fatalf("expected the prompt and the reply to survive, got %d", len(loaded.Messages))
	}
}

func TestRepairKeepsMatchedPairs(t *testing.T) {
	messages := []types.Message{
		types.UserMessage("go"),
		assistantWithCall("kept", "grep"),
		toolResult("kept", "grep", "hit"),
		assistantWithCall("dangling", "run_command"),
	}
	out := repair(messages)
	if len(out) != 4 {
		t.Fatalf("every message carries text, so all four should survive; got %d", len(out))
	}
	if len(out[1].ToolCalls) != 1 || out[1].ToolCalls[0].ID != "kept" {
		t.Fatalf("matched pair was damaged: %+v", out[1].ToolCalls)
	}
	// The dangling call is stripped, but its text is worth keeping.
	if len(out[3].ToolCalls) != 0 {
		t.Fatalf("dangling call survived: %+v", out[3].ToolCalls)
	}
	if out[3].Text() == "" {
		t.Fatal("the assistant text should survive the repair")
	}
}
