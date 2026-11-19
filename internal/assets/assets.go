// Package assets embeds the project's prompt and skill files so a single
// binary works from any directory, and resolves the on-disk project root when
// one is present (whose prompt and same-named skills override the embedded
// copies, so editing prompts or skills does not need a rebuild).
package assets

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	reagent "github.com/overkazaf/re-agent"
)

const rootEnv = "OXAF_RE_HOME"

type PromptDoc struct {
	Name string
	Text string
	Path string
	// Source is project, user, embedded, or fallback.
	Source string
}

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
	return Prompt("system").Text
}

func Prompt(name string) PromptDoc {
	name = normalizePromptName(name)
	if name == "" {
		name = "system"
	}
	for _, candidate := range promptCandidates(name) {
		if data, err := os.ReadFile(candidate.path); err == nil {
			return PromptDoc{Name: name, Text: string(data), Path: candidate.path, Source: candidate.source}
		}
	}
	if data, err := reagent.EmbeddedFS.ReadFile(embeddedPromptPath(name)); err == nil {
		return PromptDoc{Name: name, Text: string(data), Path: "embedded:" + embeddedPromptPath(name), Source: "embedded"}
	}
	return PromptDoc{Name: name, Text: fallbackPrompt(name), Source: "fallback"}
}

func DefaultPrompt(name string) PromptDoc {
	name = normalizePromptName(name)
	if data, err := reagent.EmbeddedFS.ReadFile(embeddedPromptPath(name)); err == nil {
		return PromptDoc{Name: name, Text: string(data), Path: "embedded:" + embeddedPromptPath(name), Source: "embedded"}
	}
	return PromptDoc{Name: name, Text: fallbackPrompt(name), Source: "fallback"}
}

func RolePrompt(name string) PromptDoc {
	return Prompt("roles/" + name)
}

func RolePrompts(names []string) map[string]PromptDoc {
	out := map[string]PromptDoc{}
	for _, name := range names {
		out[name] = RolePrompt(name)
	}
	return out
}

// EditablePromptPath returns where `/prompt edit` writes. Project-local prompts
// win when a project root is detected; otherwise edits are stored under the
// user's 0xAF config directory.
func EditablePromptPath(name string) string {
	name = normalizePromptName(name)
	if root := Root(); root != "" {
		return filepath.Join(root, "prompts", promptRelativePath(name))
	}
	return filepath.Join(userConfigDir(), "prompts", promptRelativePath(name))
}

func EnsureEditablePrompt(name string) (string, error) {
	name = normalizePromptName(name)
	if name == "" {
		return "", fmt.Errorf("empty prompt name")
	}
	target := EditablePromptPath(name)
	if _, err := os.Stat(target); err == nil {
		return target, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	seed := Prompt(name).Text
	if strings.TrimSpace(seed) == "" {
		seed = fallbackPrompt(name)
	}
	if err := os.WriteFile(target, []byte(ensureTrailingNewline(seed)), 0o600); err != nil {
		return "", err
	}
	return target, nil
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
	entries, err := fs.ReadDir(reagent.EmbeddedFS, "skills")
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data, err := reagent.EmbeddedFS.ReadFile("skills/" + entry.Name() + "/SKILL.md")
		if err != nil {
			continue
		}
		out[entry.Name()] = string(data)
	}
	return out
}

// ListSkillFiles returns companion files (excluding SKILL.md) inside a skill
// directory, merging embedded and on-disk files so standalone binaries work
// identically to a repository checkout.
func ListSkillFiles(skillDirName string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(rel string) {
		rel = strings.TrimPrefix(filepath.ToSlash(rel), "/")
		if rel == "" || rel == "SKILL.md" || seen[rel] {
			return
		}
		seen[rel] = true
		out = append(out, rel)
	}
	embRoot := path.Join("skills", skillDirName)
	_ = fs.WalkDir(reagent.EmbeddedFS, embRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		add(strings.TrimPrefix(p, embRoot+"/"))
		return nil
	})
	if skillsRoot := SkillsDir(); skillsRoot != "" {
		diskRoot := filepath.Join(skillsRoot, skillDirName)
		_ = filepath.WalkDir(diskRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if rel, relErr := filepath.Rel(diskRoot, p); relErr == nil {
				add(rel)
			}
			return nil
		})
	}
	return out
}

// ReadSkillFile reads a companion file (such as scripts/arm64_emulator.py)
// inside a skill directory, checking disk overrides before embedded assets.
func ReadSkillFile(skillDirName, relFile string) (string, string, error) {
	cleaned := path.Clean(strings.TrimLeft(filepath.ToSlash(strings.TrimSpace(relFile)), "/"))
	if cleaned == "." || cleaned == "" || strings.HasPrefix(cleaned, "..") {
		return "", "", fmt.Errorf("invalid skill file path: %s", relFile)
	}
	if skillsRoot := SkillsDir(); skillsRoot != "" {
		diskBase := filepath.Join(skillsRoot, skillDirName)
		candidate := filepath.Join(diskBase, filepath.FromSlash(cleaned))
		if rel, err := filepath.Rel(diskBase, candidate); err == nil && !strings.HasPrefix(rel, "..") {
			if data, err := os.ReadFile(candidate); err == nil {
				return string(data), candidate, nil
			}
		}
	}
	embPath := path.Join("skills", skillDirName, cleaned)
	data, err := reagent.EmbeddedFS.ReadFile(embPath)
	if err != nil {
		return "", "", fmt.Errorf("skill file %q not found in %s", cleaned, skillDirName)
	}
	return string(data), "embedded:" + embPath, nil
}

// KnowledgeIndexPath is where the imported reverse-engineering corpus lives.
// Inside a project checkout (or $OXAF_RE_HOME), knowledge/reverse-index.json
// wins if present or when writing inside the repo; standalone binaries use
// ~/.0xaf-re-agent/knowledge/reverse-index.json instead of polluting random cwds.
func KnowledgeIndexPath() string {
	if root := Root(); root != "" {
		repoIndex := filepath.Join(root, "knowledge", "reverse-index.json")
		if _, err := os.Stat(repoIndex); err == nil {
			return repoIndex
		}
		userIndex := filepath.Join(userConfigDir(), "knowledge", "reverse-index.json")
		if _, err := os.Stat(userIndex); err == nil {
			return userIndex
		}
		return repoIndex
	}
	return filepath.Join(userConfigDir(), "knowledge", "reverse-index.json")
}

type promptCandidate struct {
	path   string
	source string
}

func promptCandidates(name string) []promptCandidate {
	relative := promptRelativePath(name)
	var out []promptCandidate
	if root := Root(); root != "" {
		out = append(out, promptCandidate{path: filepath.Join(root, "prompts", relative), source: "project"})
	}
	out = append(out, promptCandidate{path: filepath.Join(userConfigDir(), "prompts", relative), source: "user"})
	return out
}

func promptRelativePath(name string) string {
	name = normalizePromptName(name)
	if name == "system" {
		return "system.md"
	}
	return name + ".md"
}

func embeddedPromptPath(name string) string {
	return "prompts/" + promptRelativePath(name)
}

func normalizePromptName(name string) string {
	name = strings.TrimSpace(strings.TrimPrefix(name, "/"))
	name = strings.TrimSuffix(name, ".md")
	name = strings.TrimPrefix(name, "prompts/")
	switch name {
	case "", "system":
		return "system"
	case "planner", "executor", "researcher":
		return "roles/" + name
	}
	if strings.HasPrefix(name, "roles/") {
		return name
	}
	return name
}

func userConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ".0xaf-re-agent"
	}
	return filepath.Join(home, ".0xaf-re-agent")
}

func fallbackPrompt(name string) string {
	switch normalizePromptName(name) {
	case "roles/planner":
		return "## Active Role: planner\n\nPlan the reverse-engineering work before execution. Prefer hypotheses, evidence, and the smallest next experiment."
	case "roles/executor":
		return "## Active Role: executor\n\nExecute local inspection and tooling carefully. Preserve evidence and summarize command results concisely."
	case "roles/researcher":
		return "## Active Role: researcher\n\nResearch the target, surrounding ecosystem, prior art, APIs, formats, and references. Cite sources or local evidence when possible."
	default:
		return "You are 0xAF-Re, a reverse engineering and CTF assistant."
	}
}

func ensureTrailingNewline(text string) string {
	if strings.HasSuffix(text, "\n") {
		return text
	}
	return text + "\n"
}
