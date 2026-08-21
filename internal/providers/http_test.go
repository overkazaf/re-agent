package providers

import (
	"encoding/json"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func conversation() []types.Message {
	return []types.Message{
		types.UserMessage("triage ./chall"),
		{
			Role: types.MessageAssistant, Provider: "codex",
			Blocks:    []types.ContentBlock{types.TextBlock("running strings")},
			ToolCalls: []types.ToolCall{{ID: "call_1", Name: "strings", Arguments: map[string]any{"path": "./chall"}}},
		},
		{
			Role: types.MessageToolResult, ToolCallID: "call_1", ToolName: "strings",
			Blocks: []types.ContentBlock{types.TextBlock("flag{...}")},
		},
	}
}

func encode(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestChatMessagesShape(t *testing.T) {
	out := ToChatMessages("system prompt", conversation())
	if len(out) != 4 {
		t.Fatalf("expected system + 3 messages, got %d", len(out))
	}
	assistant := out[2].(map[string]any)
	calls, ok := assistant["tool_calls"].([]any)
	if !ok || len(calls) != 1 {
		t.Fatalf("assistant tool calls lost: %s", encode(t, assistant))
	}
	tool := out[3].(map[string]any)
	if tool["role"] != "tool" || tool["tool_call_id"] != "call_1" {
		t.Fatalf("tool result shape wrong: %s", encode(t, tool))
	}
	// Strict backends reject `tool_calls: []`, so it is only sent when meaningful.
	plain := ToChatMessages("s", []types.Message{{
		Role: types.MessageAssistant, Blocks: []types.ContentBlock{types.TextBlock("hi")},
	}})[1].(map[string]any)
	if _, present := plain["tool_calls"]; present {
		t.Fatalf("empty tool_calls must be omitted: %s", encode(t, plain))
	}
}

func TestResponsesInputSendsToolCallsBack(t *testing.T) {
	out := ToResponsesInput(conversation())
	var sawFunctionCall, sawOutput bool
	for _, item := range out {
		record := item.(map[string]any)
		switch record["type"] {
		case "function_call":
			sawFunctionCall = record["call_id"] == "call_1"
		case "function_call_output":
			sawOutput = record["call_id"] == "call_1"
		}
	}
	if !sawFunctionCall {
		// Without it the API rejects the turn: function_call_output would
		// reference a call_id that is not in the input.
		t.Fatal("assistant function_call was not sent back")
	}
	if !sawOutput {
		t.Fatal("tool result was not sent as function_call_output")
	}
}

func TestAnthropicMessagesShape(t *testing.T) {
	out := toAnthropicMessages(conversation())
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}
	assistant := out[1].(map[string]any)
	content := assistant["content"].([]any)
	if len(content) != 2 || content[1].(map[string]any)["type"] != "tool_use" {
		t.Fatalf("tool_use block missing: %s", encode(t, assistant))
	}
	result := out[2].(map[string]any)
	block := result["content"].([]any)[0].(map[string]any)
	if result["role"] != "user" || block["tool_use_id"] != "call_1" {
		t.Fatalf("tool_result shape wrong: %s", encode(t, result))
	}
}

func imageUserMessage() types.Message {
	return types.Message{
		Role: types.MessageUser,
		Blocks: []types.ContentBlock{
			types.TextBlock("see the frames below"),
			types.ImageBlock("aGVsbG8=", "image/png"),
		},
	}
}

func TestChatMessagesIncludeImageBlocks(t *testing.T) {
	out := ToChatMessages("s", []types.Message{imageUserMessage()})
	user := out[1].(map[string]any)
	content, ok := user["content"].([]any)
	if !ok {
		t.Fatalf("user content should be an array when images are present: %s", encode(t, user))
	}
	if len(content) != 2 {
		t.Fatalf("expected text + image parts, got %d", len(content))
	}
	image := content[1].(map[string]any)
	url := image["image_url"].(map[string]any)["url"].(string)
	if image["type"] != "image_url" || url != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("chat image part wrong: %s", encode(t, image))
	}
}

func TestResponsesInputIncludesImageBlocks(t *testing.T) {
	out := ToResponsesInput([]types.Message{imageUserMessage()})
	user := out[0].(map[string]any)
	content := user["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("expected text + image parts, got %d", len(content))
	}
	image := content[1].(map[string]any)
	if image["type"] != "input_image" || image["image_url"] != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("responses image part wrong: %s", encode(t, image))
	}
}

func TestAnthropicMessagesIncludeImageBlocks(t *testing.T) {
	out := toAnthropicMessages([]types.Message{imageUserMessage()})
	user := out[0].(map[string]any)
	content := user["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("expected text + image parts, got %d", len(content))
	}
	image := content[1].(map[string]any)
	source := image["source"].(map[string]any)
	if image["type"] != "image" || source["type"] != "base64" ||
		source["media_type"] != "image/png" || source["data"] != "aGVsbG8=" {
		t.Fatalf("anthropic image part wrong: %s", encode(t, image))
	}
}

func TestProviderConfigSupportsImages(t *testing.T) {
	for _, kind := range []types.ProviderKind{types.KindAnthropic, types.KindOpenAIResponses, types.KindOpenAIChat} {
		if !(&types.ProviderConfig{Type: kind}).SupportsImages() {
			t.Fatalf("provider kind %s should support images", kind)
		}
	}
	for _, kind := range []types.ProviderKind{types.KindCLITmux, types.KindMock} {
		if (&types.ProviderConfig{Type: kind}).SupportsImages() {
			t.Fatalf("provider kind %s must not claim image support", kind)
		}
	}
}

func TestParseAnthropicResponse(t *testing.T) {
	raw := map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": "here you go"},
			map[string]any{"type": "tool_use", "id": "toolu_1", "name": "grep",
				"input": map[string]any{"pattern": "flag"}},
		},
		"usage": map[string]any{"input_tokens": 10.0, "output_tokens": 4.0, "cache_read_input_tokens": 900.0},
	}
	response := parseAnthropic(raw)
	if response.Text != "here you go" || len(response.ToolCalls) != 1 {
		t.Fatalf("parse wrong: %+v", response)
	}
	if response.ToolCalls[0].Arguments["pattern"] != "flag" {
		t.Fatalf("tool arguments lost: %+v", response.ToolCalls[0])
	}
	if response.Usage.CacheRead != 900 || response.Usage.Input != 10 {
		t.Fatalf("usage wrong: %+v", response.Usage)
	}
}

func TestParseChatResponseToleratesBadArguments(t *testing.T) {
	raw := map[string]any{
		"choices": []any{map[string]any{"message": map[string]any{
			"content": "text",
			"tool_calls": []any{map[string]any{
				"id": "1", "function": map[string]any{"name": "grep", "arguments": "not json"},
			}},
		}}},
		"usage": map[string]any{"prompt_tokens": 5.0, "completion_tokens": 6.0},
	}
	response := parseChat(raw)
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].Arguments["raw"] != "not json" {
		t.Fatalf("unparseable arguments should be preserved: %+v", response.ToolCalls)
	}
	if response.Usage.Output != 6 {
		t.Fatalf("usage wrong: %+v", response.Usage)
	}
}

func TestParseResponsesOutput(t *testing.T) {
	raw := map[string]any{
		"output": []any{
			map[string]any{"type": "message", "content": []any{
				map[string]any{"type": "output_text", "text": "done"},
			}},
			map[string]any{"type": "function_call", "call_id": "fc_1", "name": "read_file",
				"arguments": `{"path":"a.txt"}`},
		},
		"usage": map[string]any{
			"input_tokens": 3.0, "output_tokens": 8.0,
			"output_tokens_details": map[string]any{"reasoning_tokens": 2.0},
		},
	}
	response := parseResponses(raw)
	if response.Text != "done" || len(response.ToolCalls) != 1 {
		t.Fatalf("parse wrong: %+v", response)
	}
	if response.ToolCalls[0].Arguments["path"] != "a.txt" {
		t.Fatalf("arguments lost: %+v", response.ToolCalls[0])
	}
	if response.Usage.Thinking != 2 {
		t.Fatalf("reasoning tokens lost: %+v", response.Usage)
	}
}

func TestMockProviderScript(t *testing.T) {
	provider, err := Create("mock", &types.ProviderConfig{
		Type: types.KindMock, Model: "mock",
		MockScript: []types.MockStep{{Text: "one"}, {Text: "two"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	first, _ := provider.Complete(types.ProviderInput{})
	second, _ := provider.Complete(types.ProviderInput{})
	third, _ := provider.Complete(types.ProviderInput{})
	if first.Text != "one" || second.Text != "two" || third.Text != "two" {
		t.Fatalf("script replay wrong: %q %q %q", first.Text, second.Text, third.Text)
	}
}

func TestDeltaSinceReturnsOnlyNewTurns(t *testing.T) {
	messages := []types.Message{
		types.UserMessage("first"),
		{Role: types.MessageAssistant, Provider: "claude", Blocks: []types.ContentBlock{types.TextBlock("answer")}},
		types.UserMessage("second"),
	}
	delta := deltaSince(messages, "claude")
	if len(delta) != 1 || delta[0].Text() != "second" {
		t.Fatalf("delta wrong: %+v", delta)
	}
	// Nothing from this provider yet: the whole history is new to it.
	if len(deltaSince(messages, "codex")) != 3 {
		t.Fatal("a provider that has not spoken should get the full history")
	}
}
