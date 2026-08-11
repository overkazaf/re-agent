package providers

import (
	"strings"
	"testing"
)

func TestFormatCLIFailureExplainsSelectedModelErrors(t *testing.T) {
	stdout := `{"type":"result","is_error":true,"stop_reason":"stop_sequence","result":"There's an issue with the selected model (glm-5.2\u001b[1m). It may not exist or you may not have access."}`

	got := FormatCLIFailure("claude", "claude", 1, stdout, "", "/tmp/0xaf-run", FormatClaudeJSON)
	if !strings.Contains(got, "rejected the configured model") {
		t.Fatalf("selected model failure should be called out:\n%s", got)
	}
	if strings.Contains(got, "ended with stop_reason=stop_sequence") {
		t.Fatalf("stop_sequence should not be presented as the root cause:\n%s", got)
	}
	if strings.Contains(got, "\x1b") {
		t.Fatalf("ANSI escapes should be stripped:\n%q", got)
	}
}
