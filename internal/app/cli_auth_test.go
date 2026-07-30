package app

import "testing"

func TestClassifyBareCLIAuthLine(t *testing.T) {
	cases := []struct {
		line    string
		action  bareCLIAuthAction
		command string
	}{
		{"codex login status", bareCLIAuthStatus, "codex login status"},
		{"codex login", bareCLIAuthLogin, "codex login"},
		{"claude auth status --text", bareCLIAuthStatus, "claude auth status --text"},
		{"claude auth login --console", bareCLIAuthLogin, "claude auth login"},
		{"codex explain login status", bareCLIAuthNone, ""},
		{"!codex login status", bareCLIAuthNone, ""},
	}
	for _, tc := range cases {
		action, command := classifyBareCLIAuthLine(tc.line)
		if action != tc.action || command != tc.command {
			t.Fatalf("%q: got (%q, %q), want (%q, %q)", tc.line, action, command, tc.action, tc.command)
		}
	}
}
