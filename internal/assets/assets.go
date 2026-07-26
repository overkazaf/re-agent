// Package assets embeds the project's prompt and skill files so a single
// binary works from any directory, and resolves the on-disk project root when
// one is present (which then wins, so editing a skill does not need a rebuild).
package assets

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

//go:embed embedded/prompts/system.md embedded/skills
var embedded embed.FS

const rootEnv = "OXAF_RE_HOME"

var (
	rootOnce sync.Once
	rootPath string
)

// Root is the directory holding prompts/, skills/, knowledge/ and demos/.
// Resolution order: $OXAF_RE_HOME, the executable's directory and its parents,
// then the working directory and its parents. Empty means "use the embedded
// copies".
func Root() string {
	rootOnce.Do(func() { rootPath = resolveRoot() })
	return rootPath
}

func resolveRoot() string {
	if fromEnv := strings.TrimSpace(os.Getenv(rootEnv)); fromEnv != "" {
		if abs, err := filepath.Abs(fromEnv); err == nil {
			return abs
		}
	}
	var starts []string
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		starts = append(starts, filepath.Dir(executable))
	}
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	for _, start := range starts {
		if found := walkUp(start); found != "" {
			return found
		}
	}
	return ""
}

// walkUp looks for the project marker, tolerating a binary that lives in
// go/bin/ or a working directory somewhere inside the project.
func walkUp(start string) string {
	current := start
	for depth := 0; depth < 6; depth++ {
		if isProjectRoot(current) {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return ""
}

func isProjectRoot(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "prompts", "system.md")); err != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, "skills")); err != nil {
		return false
	}
	return true
}

// SystemPrompt prefers the on-disk prompt, falling back to the embedded copy.
func SystemPrompt() string {
	if root := Root(); root != "" {
		if data, err := os.ReadFile(filepath.Join(root, "prompts", "system.md")); err == nil {
			return string(data)
		}
	}
	if data, err := embedded.ReadFile("embedded/prompts/system.md"); err == nil {
		return string(data)
	}
	return "You are 0xAF-Re, a reverse engineering and CTF assistant."
}

// SkillsDir is the on-disk skills directory, or "" when only the embedded
// copies are available.
func SkillsDir() string {
	if root := Root(); root != "" {
		dir := filepath.Join(root, "skills")
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
	}
	return ""
}

// EmbeddedSkills returns name -> SKILL.md body for the built-in skills.
func EmbeddedSkills() map[string]string {
	out := map[string]string{}
	entries, err := fs.ReadDir(embedded, "embedded/skills")
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data, err := embedded.ReadFile("embedded/skills/" + entry.Name() + "/SKILL.md")
		if err != nil {
			continue
		}
		out[entry.Name()] = string(data)
	}
	return out
}

// KnowledgeIndexPath is where the imported reverse-engineering corpus lives.
func KnowledgeIndexPath() string {
	root := Root()
	if root == "" {
		if cwd, err := os.Getwd(); err == nil {
			root = cwd
		}
	}
	return filepath.Join(root, "knowledge", "reverse-index.json")
}
