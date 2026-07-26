package knowledge

// Parsing and rendering of the four-section knowledge answer. Forgiving about
// shape: any heading level, bold headings, English aliases, numbered or
// bulleted lists, sections out of order or missing. Unforgiving about
// citations — an id that does not resolve lands in InventedCitations rather
// than being dropped, because a knowledge tool that cites entries which do not
// exist is worse than one that cites nothing.

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/overkazaf/re-agent/internal/util"
)

type Answer struct {
	Conclusion string
	Steps      []string
	Pitfalls   []string
	// Citations are cited ids resolved against the supplied entries,
	// de-duplicated, in first-seen order.
	Citations []Entry
	// InventedCitations are cited ids that resolve to nothing — surfaced to the
	// operator, never dropped.
	InventedCitations []string
	// Parsed is false when no section marker was found and the whole reply fell
	// back to Raw.
	Parsed bool
	Raw    string
}

type sectionKey string

const (
	secConclusion sectionKey = "conclusion"
	secSteps      sectionKey = "steps"
	secPitfalls   sectionKey = "pitfalls"
	secSources    sectionKey = "sources"
)

var sectionAliases = map[string]sectionKey{
	"结论": secConclusion, "总结": secConclusion, "conclusion": secConclusion,
	"步骤": secSteps, "steps": secSteps, "step": secSteps,
	"坑": secPitfalls, "坑点": secPitfalls, "踩坑": secPitfalls,
	"pitfalls": secPitfalls, "pitfall": secPitfalls, "gotchas": secPitfalls,
	"出处": secSources, "来源": secSources, "引用": secSources,
	"sources": secSources, "source": secSources, "citations": secSources, "references": secSources,
}

var (
	headingRE = regexp.MustCompile(`^[ \t]{0,3}(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*([A-Za-z\x{4e00}-\x{9fff}][A-Za-z \x{4e00}-\x{9fff}]{0,18})[ \t]*(?:\*\*|__)?[ \t]*(?:[:：][ \t]*(.*))?$`)
	bulletRE  = regexp.MustCompile(`^[ \t]*(?:[-*+•·]|\(\d{1,3}\)|\d{1,3}[.)、])[ \t]*(.+)$`)
	// `[id]` not followed by `(` so markdown links are not mistaken for citations.
	citationRE     = regexp.MustCompile(`\[([^\[\]]{1,200})\]`)
	bareCitationRE = regexp.MustCompile(`\[([^\[\]\s]{1,120})\]`)
	idShapeRE      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/#:@-]{0,80}$`)
	tokenSplitRE   = regexp.MustCompile(`[\s,，、;；]+`)
	spaceRE        = regexp.MustCompile(`\s+`)
)

func ParseAnswer(text string, entries []Entry) Answer {
	raw := text
	sections := map[sectionKey][]string{}
	order := []sectionKey{}
	var current sectionKey
	hasCurrent := false

	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		if key, rest, ok := matchHeading(line); ok {
			current, hasCurrent = key, true
			if _, seen := sections[key]; !seen {
				order = append(order, key)
				sections[key] = nil
			}
			if rest != "" {
				sections[key] = append(sections[key], rest)
			}
			continue
		}
		if hasCurrent {
			sections[current] = append(sections[current], line)
		}
	}

	parsed := len(sections) > 0
	sourceLines, hasSources := sections[secSources]
	citationText := raw
	if hasSources {
		citationText = strings.Join(sourceLines, "\n")
	}
	tokens := citationTokens(citationText, entries, hasSources)
	citations, invented := resolveCitations(tokens, entries)

	answer := Answer{Citations: citations, InventedCitations: invented, Parsed: parsed, Raw: raw}
	if parsed {
		answer.Conclusion = joinLines(sections[secConclusion])
		answer.Steps = toItems(sections[secSteps])
		answer.Pitfalls = toItems(sections[secPitfalls])
	}
	return answer
}

func matchHeading(line string) (sectionKey, string, bool) {
	match := headingRE.FindStringSubmatch(line)
	if match == nil {
		return "", "", false
	}
	name := strings.ToLower(spaceRE.ReplaceAllString(match[1], ""))
	key, ok := sectionAliases[name]
	if !ok {
		return "", "", false
	}
	return key, strings.TrimSpace(match[2]), true
}

func joinLines(lines []string) string {
	var kept []string
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			kept = append(kept, trimmed)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// toItems turns a section body into items. Bullets and numbered lists start new
// items; a plain line after one continues it; a blank line closes it.
func toItems(lines []string) []string {
	var items []string
	open := false
	for _, line := range lines {
		if match := bulletRE.FindStringSubmatch(line); match != nil {
			items = append(items, strings.TrimSpace(match[1]))
			open = true
			continue
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			open = false
			continue
		}
		if open && len(items) > 0 {
			items[len(items)-1] = items[len(items)-1] + " " + trimmed
		} else {
			items = append(items, trimmed)
			open = true
		}
	}
	var out []string
	for _, item := range items {
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

// citationTokens pulls citation tokens out of the 出处 section (or, when there
// is none, out of the whole reply). Bracketed ids win; a bare id list is
// accepted only for tokens that actually resolve, so prose is not mistaken for
// a citation.
func citationTokens(text string, entries []Entry, fromSection bool) []string {
	pattern := citationRE
	if !fromSection {
		pattern = bareCitationRE
	}
	var tokens []string
	for _, match := range pattern.FindAllStringSubmatchIndex(text, -1) {
		// Skip markdown links: `[text](url)`.
		if match[1] < len(text) && text[match[1]] == '(' {
			continue
		}
		body := text[match[2]:match[3]]
		for _, token := range tokenSplitRE.Split(body, -1) {
			cleaned := strings.Trim(strings.TrimSpace(token), "`'\".,;")
			if cleaned == "" {
				continue
			}
			if fromSection || idShapeRE.MatchString(cleaned) {
				tokens = append(tokens, cleaned)
			}
		}
	}
	if len(tokens) > 0 || !fromSection {
		return tokens
	}
	known := map[string]bool{}
	for _, entry := range entries {
		known[strings.ToLower(entry.ID)] = true
	}
	var bare []string
	for _, token := range tokenSplitRE.Split(text, -1) {
		trimmed := strings.TrimSpace(token)
		if trimmed != "" && known[strings.ToLower(trimmed)] {
			bare = append(bare, trimmed)
		}
	}
	return bare
}

func resolveCitations(tokens []string, entries []Entry) ([]Entry, []string) {
	byID := map[string]Entry{}
	for _, entry := range entries {
		byID[strings.ToLower(entry.ID)] = entry
	}
	var citations []Entry
	var invented []string
	seen := map[string]bool{}
	for _, token := range tokens {
		key := strings.ToLower(token)
		if seen[key] {
			continue
		}
		seen[key] = true
		if entry, ok := byID[key]; ok {
			citations = append(citations, entry)
		} else {
			invented = append(invented, token)
		}
	}
	return citations, invented
}

// FormatAnswer is the plain-text rendering; the call site owns any coloring.
func FormatAnswer(answer Answer) string {
	var parts []string
	if !answer.Parsed {
		parts = append(parts, "! 模型未按要求的格式输出，以下为原始回答。")
		body := strings.TrimSpace(answer.Raw)
		if body == "" {
			body = "(空回答)"
		}
		parts = append(parts, body)
	} else {
		if answer.Conclusion != "" {
			parts = append(parts, "▸ 结论\n"+indent(answer.Conclusion))
		}
		if len(answer.Steps) > 0 {
			rows := []string{"▸ 步骤"}
			for i, step := range answer.Steps {
				rows = append(rows, fmt.Sprintf("  %d. %s", i+1, step))
			}
			parts = append(parts, strings.Join(rows, "\n"))
		}
		if len(answer.Pitfalls) > 0 {
			rows := []string{"▸ 坑"}
			for _, pitfall := range answer.Pitfalls {
				rows = append(rows, "  • "+pitfall)
			}
			parts = append(parts, strings.Join(rows, "\n"))
		}
		if len(parts) == 0 {
			body := strings.TrimSpace(answer.Raw)
			if body == "" {
				body = "(空回答)"
			}
			parts = append(parts, body)
		}
	}
	if len(answer.Citations) > 0 {
		rows := []string{"▸ 出处"}
		for _, entry := range answer.Citations {
			rows = append(rows, fmt.Sprintf("  [%s] %s", entry.ID, entry.Title))
		}
		parts = append(parts, strings.Join(rows, "\n"))
	}
	if len(answer.InventedCitations) > 0 {
		ids := make([]string, 0, len(answer.InventedCitations))
		for _, id := range answer.InventedCitations {
			ids = append(ids, "["+id+"]")
		}
		parts = append(parts, "! 警告：以下引用在知识索引中不存在，请勿采信："+strings.Join(ids, " "))
	}
	return strings.Join(parts, "\n\n")
}

func indent(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = "  " + line
	}
	return strings.Join(lines, "\n")
}

func FormatMatches(entries []Entry) string {
	if len(entries) == 0 {
		return "No matching reverse-engineering knowledge entries."
	}
	blocks := make([]string, 0, len(entries))
	for _, entry := range entries {
		tags := strings.Join(entry.Tags, ", ")
		if tags == "" {
			tags = "-"
		}
		blocks = append(blocks, strings.Join([]string{
			fmt.Sprintf("## %s  %s", entry.ID, entry.Title),
			"path: " + entry.Path,
			"tags: " + tags,
			entry.Summary,
		}, "\n"))
	}
	return strings.Join(blocks, "\n\n")
}

// FormatDigest is the agent-ready view: retrieved evidence plus the contract
// for turning it into an answer.
func FormatDigest(query string, entries []Entry) string {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		trimmed = "(empty)"
	}
	if len(entries) == 0 {
		return strings.Join([]string{
			"KNOWLEDGE QUERY DIGEST",
			"query: " + trimmed,
			"hits: 0",
			"",
			"conclusion:",
			"- No local reverse-engineering knowledge entries matched.",
		}, "\n")
	}

	lines := []string{
		"KNOWLEDGE QUERY DIGEST",
		"query: " + trimmed,
		fmt.Sprintf("hits: %d", len(entries)),
		"",
		"agent contract:",
		"- Treat these hits as retrieved local evidence, not as the final answer.",
		"- Synthesize the user-facing reply into: 结论, 步骤, 坑, 出处.",
		"- Cite only ids shown below, formatted like [entry-id].",
		"- If the summaries are not enough, call knowledge_read on the strongest id before answering.",
		"",
		"evidence:",
	}
	for index, entry := range entries {
		tags := strings.Join(entry.Tags, ", ")
		if tags == "" {
			tags = "-"
		}
		source := entry.Source
		if source == "" {
			source = entry.Kind
		}
		if source == "" {
			source = "-"
		}
		reasons := digestReasons(trimmed, entry)
		why := strings.Join(reasons, ", ")
		if why == "" {
			why = "ranked by local search"
		}
		summary := entry.Summary
		if summary == "" {
			summary = entry.Preview
		}
		if summary == "" {
			summary = "(no summary)"
		}
		lines = append(lines,
			fmt.Sprintf("%d. [%s] %s", index+1, entry.ID, entry.Title),
			"   tags: "+tags,
			fmt.Sprintf("   source: %s · %s", source, entry.Path),
			"   why: "+why,
			"   summary: "+oneLine(summary),
		)
	}

	citable := entries
	if len(citable) > 5 {
		citable = citable[:5]
	}
	ids := make([]string, 0, len(citable))
	for _, entry := range citable {
		ids = append(ids, "["+entry.ID+"]")
	}
	lines = append(lines,
		"",
		"answer scaffold:",
		"### 结论",
		"- <summarize the operational answer from the evidence>",
		"### 步骤",
		"1. <next action; read a cited entry first when more detail is needed>",
		"### 坑",
		"- <gotcha documented in evidence, or 无>",
		"### 出处",
		strings.Join(ids, " "),
	)
	return strings.Join(lines, "\n")
}

func digestReasons(query string, entry Entry) []string {
	needles := terms(query)
	if len(needles) == 0 {
		return nil
	}
	fields := [][2]string{
		{"title", entry.Title},
		{"tags", strings.Join(entry.Tags, " ")},
		{"path", entry.Path},
		{"summary", entry.Summary + "\n" + entry.Preview},
	}
	var reasons []string
	for _, field := range fields {
		lower := strings.ToLower(field[1])
		var matched []string
		for _, term := range needles {
			if strings.Contains(lower, term) {
				matched = append(matched, term)
				if len(matched) == 3 {
					break
				}
			}
		}
		if len(matched) > 0 {
			reasons = append(reasons, fmt.Sprintf("%s matches %s", field[0], strings.Join(matched, "/")))
		}
	}
	return reasons
}

func oneLine(text string) string {
	return util.Clip(strings.TrimSpace(spaceRE.ReplaceAllString(text, " ")), 260)
}
