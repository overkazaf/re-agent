// Package knowledge searches the imported reverse-engineering corpus and
// packs hits into a model-facing context block.
package knowledge

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/overkazaf/re-agent/internal/assets"
	"github.com/overkazaf/re-agent/internal/util"
)

type Entry struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Path    string   `json:"path"`
	Source  string   `json:"source"`
	Kind    string   `json:"kind"`
	Tags    []string `json:"tags"`
	Summary string   `json:"summary"`
	Preview string   `json:"preview,omitempty"`
}

type Index struct {
	GeneratedAt string   `json:"generatedAt"`
	SourceRoots []string `json:"sourceRoots"`
	Entries     []Entry  `json:"entries"`
}

func IndexPath() string { return assets.KnowledgeIndexPath() }

func LoadIndex() Index {
	data, err := os.ReadFile(IndexPath())
	if err != nil {
		return Index{}
	}
	var index Index
	if err := json.Unmarshal(data, &index); err != nil {
		return Index{}
	}
	return index
}

var termSplitRE = regexp.MustCompile(`[^\p{L}\p{N}_]+`)

func terms(query string) []string {
	var out []string
	for _, term := range termSplitRE.Split(strings.ToLower(query), -1) {
		if term != "" {
			out = append(out, term)
		}
	}
	return out
}

func Search(query string, limit int) []Entry {
	index := LoadIndex()
	needles := terms(query)
	type scored struct {
		entry Entry
		score int
	}
	var hits []scored
	for _, entry := range index.Entries {
		score := scoreEntry(entry, needles)
		if len(needles) > 0 && score == 0 {
			continue
		}
		hits = append(hits, scored{entry, score})
	}
	sort.SliceStable(hits, func(a, b int) bool {
		if hits[a].score != hits[b].score {
			return hits[a].score > hits[b].score
		}
		return hits[a].entry.Title < hits[b].entry.Title
	})
	if limit < 1 {
		limit = 1
	}
	if limit > 50 {
		limit = 50
	}
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]Entry, 0, len(hits))
	for _, hit := range hits {
		out = append(out, hit.entry)
	}
	return out
}

func scoreEntry(entry Entry, needles []string) int {
	if len(needles) == 0 {
		return 1
	}
	title := strings.ToLower(entry.Title)
	tags := strings.ToLower(strings.Join(entry.Tags, " "))
	pathText := strings.ToLower(entry.Path)
	summary := strings.ToLower(entry.Summary + "\n" + entry.Preview)
	score := 0
	for _, term := range needles {
		if strings.Contains(title, term) {
			score += 8
		}
		if strings.Contains(tags, term) {
			score += 6
		}
		if strings.Contains(pathText, term) {
			score += 3
		}
		if strings.Contains(summary, term) {
			score += 1
		}
	}
	return score
}

func ReadEntry(idOrPath string) *Entry {
	index := LoadIndex()
	needle := strings.ToLower(idOrPath)
	for i := range index.Entries {
		entry := index.Entries[i]
		if strings.ToLower(entry.ID) == needle || strings.ToLower(entry.Path) == needle {
			return &entry
		}
	}
	return nil
}

func ReadText(entry Entry, maxBytes int) string {
	if maxBytes < 1024 {
		maxBytes = 1024
	}
	data, err := os.ReadFile(entry.Path)
	if err != nil {
		fallback := entry.Preview
		if fallback == "" {
			fallback = entry.Summary
		}
		return util.Clip(fallback, maxBytes)
	}
	return util.Clip(string(data), maxBytes)
}

// --- packing -----------------------------------------------------------------

type PackedContext struct {
	Text      string
	Used      []Entry
	Truncated []Entry
}

type PackOptions struct {
	// MaxBytes is a hard ceiling on the packed text.
	MaxBytes int
	// FullTextCount is how many leading entries get their file body inlined.
	FullTextCount int
	// MaxEntryBytes is the ceiling per inlined body.
	MaxEntryBytes int
}

const (
	defaultPackBytes     = 40_000
	defaultFullTextCount = 3
	defaultEntryBytes    = 12_000
)

// Pack builds the model-facing context block for a set of search hits.
//
// The first FullTextCount entries are inlined with their file body; the rest
// contribute id/title/tags/summary only. Any entry that would push the block
// past MaxBytes is skipped and reported in Truncated. Packing keeps going after
// a skip: one oversized body must not cost the model the cheap metadata of
// every hit behind it.
func Pack(entries []Entry, options PackOptions) PackedContext {
	maxBytes := options.MaxBytes
	if maxBytes < 256 {
		maxBytes = defaultPackBytes
	}
	fullTextCount := options.FullTextCount
	if fullTextCount == 0 {
		fullTextCount = defaultFullTextCount
	}
	maxEntryBytes := options.MaxEntryBytes
	if maxEntryBytes < 256 {
		maxEntryBytes = defaultEntryBytes
	}

	var (
		blocks    []string
		used      []Entry
		truncated []Entry
		size      int
	)
	for i, entry := range entries {
		body := ""
		hasBody := i < fullTextCount
		if hasBody {
			body = ReadText(entry, maxEntryBytes)
		}
		block := renderEntryBlock(entry, body, hasBody)
		cost := len(block)
		if len(blocks) > 0 {
			cost += 2
		}
		if size+cost > maxBytes {
			truncated = append(truncated, entry)
			continue
		}
		blocks = append(blocks, block)
		used = append(used, entry)
		size += cost
	}
	return PackedContext{Text: strings.Join(blocks, "\n\n"), Used: used, Truncated: truncated}
}

// renderEntryBlock delimits one packed entry and stamps it with the id the
// model must cite.
func renderEntryBlock(entry Entry, body string, hasBody bool) string {
	tags := strings.Join(entry.Tags, ", ")
	if tags == "" {
		tags = "-"
	}
	lines := []string{
		fmt.Sprintf("<<< ENTRY [%s] >>>", entry.ID),
		"title: " + entry.Title,
		"path: " + entry.Path,
		"tags: " + tags,
		"summary: " + entry.Summary,
	}
	if hasBody {
		lines = append(lines, "--- content ---", body)
	}
	lines = append(lines, fmt.Sprintf("<<< END [%s] >>>", entry.ID))
	return strings.Join(lines, "\n")
}

var SystemPrompt = strings.Join([]string{
	"You are 0xAF-Re's reverse-engineering knowledge assistant.",
	"",
	"You answer ONLY from the knowledge entries supplied in the user message.",
	"The entries are the whole world: do not add tools, flags, versions, APIs, or steps that are",
	"not in them, even when you happen to know them. When the entries do not cover the question,",
	"say so plainly in the 结论 section and state what they do cover instead - never paper over the",
	"gap with your own recollection.",
	"",
	"Answer in the language of the question. Write for an operator at a terminal: terse, decided,",
	"no hedging, no restating the question, no closing summary.",
	"",
	"Reply with exactly these four markers, in this order, nothing before or after:",
	"",
	"### 结论",
	"<2-4 sentences: what to actually do, decided>",
	"### 步骤",
	"1. <actionable step, command inline when there is one>",
	"### 坑",
	"- <known failure mode / gotcha>",
	"### 出处",
	"[entry-id] [entry-id]",
	"",
	"Rules:",
	"- 出处 lists only ids that literally appear in the supplied entries. Never invent an id, never",
	"  cite a file path, URL, or title - ids only, in square brackets, separated by spaces.",
	"- 步骤 is numbered and actionable; put the command inline on the step it belongs to.",
	"- 坑 records failure modes the entries actually document. Write `- 无` when they record none.",
	"- Keep every section short. One line per step, one line per 坑.",
}, "\n")

// BuildPrompt renders the user-side prompt: the question, the packed entries,
// and the citable ids.
func BuildPrompt(query string, packed PackedContext) string {
	ids := make([]string, 0, len(packed.Used))
	for _, entry := range packed.Used {
		ids = append(ids, "["+entry.ID+"]")
	}
	question := strings.TrimSpace(query)
	if question == "" {
		question = "(empty query)"
	}
	lines := []string{"# 问题", question, "", "# 知识条目"}
	if len(packed.Used) == 0 {
		lines = append(lines, "(检索没有命中任何条目)")
	} else {
		lines = append(lines, packed.Text)
	}
	lines = append(lines, "")
	if len(packed.Truncated) > 0 {
		lines = append(lines, fmt.Sprintf("(另有 %d 条命中因上下文预算被略去，不要引用它们)", len(packed.Truncated)))
	}
	joined := strings.Join(ids, " ")
	if joined == "" {
		joined = "(无)"
	}
	lines = append(lines, "可引用的 id："+joined)
	lines = append(lines, "按规定的四个标记回答，出处只写上面出现过的 id。")
	return strings.Join(lines, "\n")
}
