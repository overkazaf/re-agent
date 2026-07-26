package tools

// Tool output budgeting. Reverse engineering commands are exactly the kind that
// emit megabytes (`objdump -d`, `strings` on a fat binary), and a raw dump into
// the transcript costs the whole context window. Anything over budget is spilled
// to a file next to the session log; the model gets head+tail plus the path, and
// can read the rest deliberately with read_file/grep.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
)

type SpillResult struct {
	Text string
	// Artifact is the absolute path of the full output, when it did not fit.
	Artifact      string
	OriginalChars int
}

// headShare splits the budget: an error usually lands at the end, a header at
// the start.
const headShare = 0.6

func Preview(text string, maxChars int) (string, bool) {
	runes := []rune(text)
	if len(runes) <= maxChars {
		return text, false
	}
	head := int(float64(maxChars) * headShare)
	if head < 1 {
		head = 1
	}
	tail := maxChars - head
	if tail < 1 {
		tail = 1
	}
	elided := len(runes) - head - tail
	return fmt.Sprintf("%s\n\n… [%d chars elided] …\n\n%s",
		string(runes[:head]), elided, string(runes[len(runes)-tail:])), true
}

type SpillOptions struct {
	Context  types.ToolContext
	Label    string
	MaxChars int
}

// SpillIfLarge caps text at the policy budget. When it overflows, the full text
// is written to <sessionDir>/artifacts/ and referenced from the preview.
func SpillIfLarge(text string, options SpillOptions) SpillResult {
	maxChars := options.MaxChars
	if maxChars <= 0 {
		maxChars = options.Context.Policy.MaxToolOutputChars
	}
	length := len([]rune(text))
	if length <= maxChars {
		return SpillResult{Text: text, OriginalChars: length}
	}

	preview, _ := Preview(text, maxChars)
	artifact, err := writeArtifact(text, options.Context, options.Label)
	var note string
	if err == nil {
		note = fmt.Sprintf("\n\n[full output: %d chars saved to %s — read_file/grep it for the rest]", length, artifact)
	} else {
		artifact = ""
		note = fmt.Sprintf("\n\n[full output was %d chars; could not save an artifact copy]", length)
	}
	return SpillResult{Text: preview + note, Artifact: artifact, OriginalChars: length}
}

func writeArtifact(text string, tc types.ToolContext, label string) (string, error) {
	dir := filepath.Join(tc.SessionDir, "artifacts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	file := filepath.Join(dir, fmt.Sprintf("%s-%s.txt", stamp, slug(label)))
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		return "", err
	}
	return file, nil
}

var slugRE = regexp.MustCompile(`[^a-z0-9]+`)

func slug(label string) string {
	cleaned := strings.Trim(slugRE.ReplaceAllString(strings.ToLower(strings.TrimSpace(label)), "-"), "-")
	if cleaned == "" {
		cleaned = "output"
	}
	if len(cleaned) > 40 {
		cleaned = cleaned[:40]
	}
	return cleaned
}
