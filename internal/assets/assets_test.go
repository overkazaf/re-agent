package assets

import (
	"strings"
	"testing"
)

func TestDefaultRolePromptFallbacksAreEmbedded(t *testing.T) {
	doc := DefaultPrompt("roles/researcher")
	if doc.Source != "embedded" {
		t.Fatalf("expected embedded researcher prompt, got %s", doc.Source)
	}
	if !strings.Contains(doc.Text, "Active Role: researcher") {
		t.Fatalf("unexpected researcher prompt: %q", doc.Text)
	}
}
