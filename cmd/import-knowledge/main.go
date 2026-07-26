// Command import-knowledge indexes a local reverse-engineering markdown corpus
// into knowledge/reverse-index.json, which `knowledge_search` and `/know` read.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/assets"
	"github.com/overkazaf/re-agent/internal/knowledge"
)

func defaultRoots() []string {
	home, _ := os.UserHomeDir()
	var out []string
	for _, base := range []string{"reverse-engineering", "reverse_engineering"} {
		root := filepath.Join(home, "frida", base)
		out = append(out,
			filepath.Join(root, "android_reversing", "docs"),
			filepath.Join(root, "web_reversing", "docs"),
			filepath.Join(root, "README.md"),
			filepath.Join(root, "QUICK_START.md"),
		)
	}
	return out
}

var skipParts = map[string]bool{
	".git": true, ".claude": true, ".agents": true, "node_modules": true,
	"venv": true, "__pycache__": true, "output": true, "public": true, "site": true,
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func run(argv []string) error {
	roots := argv
	if len(roots) == 0 {
		roots = defaultRoots()
	}
	var files []string
	for _, root := range roots {
		info, err := os.Stat(root)
		if err != nil {
			continue
		}
		if info.IsDir() {
			walk(root, &files)
			continue
		}
		if isMarkdown(root) {
			files = append(files, root)
		}
	}
	sort.Strings(files)

	var entries []knowledge.Entry
	for _, file := range files {
		if entry, ok := entryFor(file); ok {
			entries = append(entries, entry)
		}
	}
	index := knowledge.Index{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		SourceRoots: roots,
		Entries:     entries,
	}
	out := assets.KnowledgeIndexPath()
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(out, append(encoded, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("indexed %d documents -> %s\n", len(entries), out)
	return nil
}

func walk(dir string, out *[]string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if skipParts[entry.Name()] {
			continue
		}
		full := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			walk(full, out)
			continue
		}
		if isMarkdown(full) {
			*out = append(*out, full)
		}
	}
}

func entryFor(file string) (knowledge.Entry, bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return knowledge.Entry{}, false
	}
	text := string(data)
	title := titleOf(text)
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(file), filepath.Ext(file))
	}
	relative := relativeKnowledgePath(file)
	source := "frida/reverse_engineering"
	if strings.Contains(file, "/frida/reverse-engineering/") {
		source = "frida/reverse-engineering"
	}
	preview := stripMarkdown(text)
	if len(preview) > 2400 {
		preview = preview[:2400]
	}
	return knowledge.Entry{
		ID:      slug(relative),
		Title:   title,
		Path:    file,
		Source:  source,
		Kind:    "markdown",
		Tags:    tagsFor(file, text),
		Summary: summarize(text),
		Preview: preview,
	}, true
}

func isMarkdown(file string) bool {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".md", ".mdx", ".markdown":
		return true
	}
	return false
}

var (
	frontmatterTitleRE = regexp.MustCompile(`(?s)^---.*?\ntitle:\s*["']?(.+?)["']?\n.*?---`)
	headingTitleRE     = regexp.MustCompile(`(?m)^#\s+(.+)$`)
	frontmatterRE      = regexp.MustCompile(`(?s)^---.*?\n---\s*`)
	codeFenceRE        = regexp.MustCompile("(?s)```.*?```")
	imageRE            = regexp.MustCompile(`!\[[^\]]*\]\([^)]+\)`)
	linkRE             = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)
	markupRE           = regexp.MustCompile("[#>*_`|~-]")
	spaceRE            = regexp.MustCompile(`\s+`)
	slugRE             = regexp.MustCompile(`[^a-z0-9\x{4e00}-\x{9fff}]+`)
	splitRE            = regexp.MustCompile(`[/_.\-\s]+`)
)

func titleOf(text string) string {
	if match := frontmatterTitleRE.FindStringSubmatch(text); match != nil {
		return strings.TrimSpace(match[1])
	}
	if match := headingTitleRE.FindStringSubmatch(text); match != nil {
		return strings.TrimSpace(match[1])
	}
	return ""
}

func summarize(text string) string {
	var kept []string
	for _, line := range strings.Split(stripMarkdown(text), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "```") {
			kept = append(kept, trimmed)
		}
	}
	clean := strings.Join(kept, " ")
	if len(clean) > 700 {
		return clean[:697] + "..."
	}
	return clean
}

func stripMarkdown(text string) string {
	out := frontmatterRE.ReplaceAllString(text, "")
	out = codeFenceRE.ReplaceAllString(out, " ")
	out = imageRE.ReplaceAllString(out, " ")
	out = linkRE.ReplaceAllString(out, "$1")
	out = markupRE.ReplaceAllString(out, " ")
	return strings.TrimSpace(spaceRE.ReplaceAllString(out, " "))
}

var keywords = []string{
	"android", "frida", "unidbg", "xposed", "magisk", "jni", "dex", "apk", "so", "web",
	"wasm", "javascript", "crypto", "tls", "webrtc", "anti-debug", "hook", "root", "emulator",
	"drm", "flutter", "unity", "native", "proxy", "captcha", "fingerprint",
}

func tagsFor(file, text string) []string {
	bag := map[string]bool{}
	var order []string
	add := func(tag string) {
		if tag == "" || bag[tag] {
			return
		}
		bag[tag] = true
		order = append(order, tag)
	}
	for _, part := range splitRE.Split(strings.ToLower(relativeKnowledgePath(file)), -1) {
		if len(part) > 2 {
			add(part)
		}
	}
	lower := strings.ToLower(text)
	for _, keyword := range keywords {
		if strings.Contains(lower, keyword) {
			add(keyword)
		}
	}
	if len(order) > 16 {
		order = order[:16]
	}
	return order
}

func relativeKnowledgePath(file string) string {
	for _, marker := range []string{"/frida/reverse-engineering/", "/frida/reverse_engineering/"} {
		if index := strings.Index(file, marker); index >= 0 {
			return file[index+len(marker):]
		}
	}
	return file
}

func slug(value string) string {
	cleaned := strings.Trim(slugRE.ReplaceAllString(strings.ToLower(value), "-"), "-")
	if len(cleaned) > 96 {
		cleaned = cleaned[:96]
	}
	return cleaned
}
