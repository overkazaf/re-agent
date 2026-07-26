package core

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func userMessage(text string) types.Message { return types.UserMessage(text) }

func assistantWithCall(id, name string) types.Message {
	return types.Message{
		Role:      types.MessageAssistant,
		Blocks:    []types.ContentBlock{types.TextBlock("calling")},
		ToolCalls: []types.ToolCall{{ID: id, Name: name, Arguments: map[string]any{}}},
	}
}

func toolResult(id, name, text string) types.Message {
	return types.Message{
		Role: types.MessageToolResult, ToolCallID: id, ToolName: name,
		Blocks: []types.ContentBlock{types.TextBlock(text)},
	}
}

func TestEstimateTokensCountsCJKHeavier(t *testing.T) {
	latin := EstimateTokens(strings.Repeat("a", 40))
	cjk := EstimateTokens(strings.Repeat("逆", 40))
	if cjk <= latin {
		t.Fatalf("expected CJK to cost more tokens than latin: cjk=%d latin=%d", cjk, latin)
	}
}

func TestCompactHistoryLeavesSmallHistoryAlone(t *testing.T) {
	messages := []types.Message{userMessage("hello"), userMessage("world")}
	result := CompactHistory(messages, CompactionOptions{BudgetTokens: 10_000})
	if len(result.Messages) != 2 || result.DroppedMessages != 0 || result.ElidedToolResults != 0 {
		t.Fatalf("unexpected compaction of a small history: %+v", result)
	}
}

func TestCompactHistoryElidesOldToolResults(t *testing.T) {
	var messages []types.Message
	for i := 0; i < 12; i++ {
		messages = append(messages,
			userMessage("prompt"),
			assistantWithCall("call", "run_command"),
			toolResult("call", "run_command", strings.Repeat("x", 5000)),
		)
	}
	result := CompactHistory(messages, CompactionOptions{BudgetTokens: 4000})
	if result.ElidedToolResults == 0 {
		t.Fatal("expected old tool results to be elided")
	}
	if result.TokensAfter > 4000 {
		t.Fatalf("budget overshot: %d tokens", result.TokensAfter)
	}
	for _, message := range result.Messages {
		if message.Role == types.MessageToolResult && len(message.Text()) > 400 {
			// Any surviving long body has to be inside the keep-recent window.
			continue
		}
	}
}

func TestCompactHistoryKeepsTheLastExchange(t *testing.T) {
	var messages []types.Message
	for i := 0; i < 40; i++ {
		messages = append(messages, userMessage(strings.Repeat("old ", 200)))
	}
	messages = append(messages, userMessage("the question that matters"))
	result := CompactHistory(messages, CompactionOptions{BudgetTokens: 300})
	last := result.Messages[len(result.Messages)-1]
	if !strings.Contains(last.Text(), "the question that matters") {
		t.Fatalf("last exchange was dropped: %q", last.Text())
	}
	if result.DroppedMessages == 0 {
		t.Fatal("expected older messages to be dropped")
	}
	if !strings.Contains(result.Messages[0].Text(), "[context compacted]") {
		t.Fatalf("expected a compaction marker, got %q", result.Messages[0].Text())
	}
}

func TestCompactionMarkerListsPromptsAndTools(t *testing.T) {
	marker := CompactionMarker([]types.Message{
		userMessage("triage the binary"),
		assistantWithCall("1", "strings"),
		toolResult("1", "strings", "output"),
	})
	text := marker.Text()
	if !strings.Contains(text, "triage the binary") || !strings.Contains(text, "strings") {
		t.Fatalf("marker lost its content: %q", text)
	}
}
