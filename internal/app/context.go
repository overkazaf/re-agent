package app

// Operator-provided reference context. `--context` lets a task start with the
// knowledge base and reference material already in the model's system prompt:
//
//	--context "know:android apk packer"   search the knowledge index
//	--context "file:notes/plan.md"        read a workspace file (bounded)
//	--context "some raw note"             pass text through verbatim
//
// The specs are rendered into one section appended to the runtime system
// prompt, so every turn of the session sees them.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/overkazaf/re-agent/internal/knowledge"
	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// referenceContextMaxBytes caps an inlined reference file so one stray huge
// file cannot blow the system prompt.
const referenceContextMaxBytes = 24_000

// buildReferenceContext renders the operator's `--context` specs into one
// system-prompt section. It returns "" when there is nothing to add.
func buildReferenceContext(specs []string, workspace, sessionDir string, policy *types.ExecutionPolicy) (string, error) {
	if len(specs) == 0 {
		return "", nil
	}
	var sections []string
	for _, spec := range specs {
		section, err := referenceContextSection(spec, workspace, policy)
		if err != nil {
			return "", err
		}
		if section != "" {
			sections = append(sections, section)
		}
	}
	if len(sections) == 0 {
		return "", nil
	}
	return strings.Join(sections, "\n\n"), nil
}

func referenceContextSection(spec, workspace string, policy *types.ExecutionPolicy) (string, error) {
	trimmed := strings.TrimSpace(spec)
	if trimmed == "" {
		return "", nil
	}
	verb, rest, hasVerb := strings.Cut(trimmed, ":")
	switch {
	case hasVerb && verb == "know":
		return knowledgeContextSection(strings.TrimSpace(rest))
	case hasVerb && verb == "file":
		return fileContextSection(strings.TrimSpace(rest), workspace, policy)
	default:
		return "## Operator Notes\n\n" + trimmed, nil
	}
}

func knowledgeContextSection(query string) (string, error) {
	if query == "" {
		return "", fmt.Errorf("--context know:<query> needs a query")
	}
	matches := knowledge.Search(query, 8)
	if len(matches) == 0 {
		return "## Knowledge base\n\n(no entries matched \"" + query + "\")", nil
	}
	packed := knowledge.Pack(matches, knowledge.PackOptions{})
	section := "## Knowledge base: " + query + "\n\n" + packed.Text
	if len(packed.Truncated) > 0 {
		section += fmt.Sprintf("\n\n(%d more entries matched but were elided by the context budget)", len(packed.Truncated))
	}
	return section, nil
}

func fileContextSection(path, workspace string, policy *types.ExecutionPolicy) (string, error) {
	if path == "" {
		return "", fmt.Errorf("--context file:<path> needs a path")
	}
	resolved, err := util.ResolveInside(workspace, path)
	if err != nil {
		return "", err
	}
	if err := security.ValidatePathRead(resolved, policy); err != nil {
		return "", err
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return "", err
	}
	body := string(data)
	if len(body) > referenceContextMaxBytes {
		body = body[:referenceContextMaxBytes] + "\n…[truncated]"
	}
	rel := resolved
	if base, err := filepath.Rel(workspace, resolved); err == nil && !strings.HasPrefix(base, "..") {
		rel = base
	}
	return "## Reference file: " + rel + "\n\n" + body, nil
}
