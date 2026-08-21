package core

// Context budgeting for long sessions.
//
// The full transcript is always kept on disk and in memory; what this file
// produces is the *view* of it that gets sent to a provider. Two mechanical
// passes, cheapest first:
//
//  1. elide the bodies of old tool results (the bulk of an RE session)
//  2. drop whole oldest exchanges, replacing them with one compaction marker
//
// Both preserve the invariant strict chat APIs care about: an assistant message
// with tool calls is never separated from its tool results.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/overkazaf/re-agent/internal/snapcompact"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

type CompactionOptions struct {
	// BudgetTokens is the ceiling for the whole message list handed to the provider.
	BudgetTokens int
	// KeepRecentMessages are the newest exchanges that are never touched.
	KeepRecentMessages int
	// ElideToolResultsOver: tool results longer than this are elision candidates.
	ElideToolResultsOver int
	// Snapcompact archives the dropped exchanges as PNG frames a vision model
	// reads back, instead of a text marker. Requires a vision-capable provider.
	Snapcompact bool
}

type CompactionResult struct {
	Messages          []types.Message
	TokensBefore      int
	TokensAfter       int
	ElidedToolResults int
	DroppedMessages   int
}

const (
	defaultKeepRecent = 8
	defaultElideOver  = 400
)

// EstimateTokens is a deliberately cheap, provider-agnostic estimate: ~4 chars
// per token for latin text, ~1.5 for CJK, close enough to drive a budget
// without pulling in a tokenizer.
func EstimateTokens(text string) int {
	cjk := 0
	total := 0
	for _, char := range text {
		total++
		code := int(char)
		switch {
		case code >= 0x2e80 && code <= 0x9fff,
			code >= 0xf900 && code <= 0xfaff,
			code >= 0xff00 && code <= 0xffef:
			cjk++
		}
	}
	latin := total - cjk
	if latin < 0 {
		latin = 0
	}
	return int(math.Ceil(float64(latin)/4 + float64(cjk)/1.5))
}

func MessageTokens(message types.Message) int {
	body := message.Text()
	if message.Role == types.MessageSystem {
		body = message.System
	}
	toolCalls := ""
	if message.Role == types.MessageAssistant && len(message.ToolCalls) > 0 {
		if encoded, err := json.Marshal(message.ToolCalls); err == nil {
			toolCalls = string(encoded)
		}
	}
	// +4 for the role/envelope overhead every provider adds per message.
	return EstimateTokens(body) + EstimateTokens(toolCalls) + 4
}

func HistoryTokens(messages []types.Message) int {
	total := 0
	for _, message := range messages {
		total += MessageTokens(message)
	}
	return total
}

// CompactHistory applies the budget, returning the list to actually send.
func CompactHistory(messages []types.Message, options CompactionOptions) CompactionResult {
	tokensBefore := HistoryTokens(messages)
	keepRecent := options.KeepRecentMessages
	if keepRecent == 0 {
		keepRecent = defaultKeepRecent
	}
	elideOver := options.ElideToolResultsOver
	if elideOver == 0 {
		elideOver = defaultElideOver
	}
	if tokensBefore <= options.BudgetTokens {
		return CompactionResult{
			Messages:     append([]types.Message{}, messages...),
			TokensBefore: tokensBefore,
			TokensAfter:  tokensBefore,
		}
	}

	// Pass 1 — elide old tool result bodies. The call and its arguments stay, so
	// the model still knows what was run and can re-run or read the artifact.
	working := append([]types.Message{}, messages...)
	protectedFrom := len(working) - keepRecent
	if protectedFrom < 0 {
		protectedFrom = 0
	}
	elided := 0
	for i := 0; i < protectedFrom; i++ {
		message := working[i]
		if message.Role != types.MessageToolResult {
			continue
		}
		text := message.Text()
		if len(text) <= elideOver {
			continue
		}
		message.Blocks = []types.ContentBlock{types.TextBlock(elidedNote(message.ToolName, text))}
		working[i] = message
		elided++
	}

	// Pass 2 — drop whole exchanges from the front until the budget fits. The
	// keep-recent window is a preference, not a floor: when even it overflows,
	// eat into it rather than silently blowing the budget. The last exchange
	// always survives — without it there is no turn left to answer.
	hardFloor := lastExchangeStart(working)
	dropped := 0
	cursor := 0
	// The marker itself costs tokens (it lists earlier prompts), so it is
	// measured rather than guessed — otherwise the budget is quietly overshot.
	overBudget := func() bool {
		total := HistoryTokens(working[cursor:])
		if cursor > 0 {
			total += MessageTokens(CompactionMarker(messages[:cursor]))
		}
		return total > options.BudgetTokens
	}
	for cursor < protectedFrom && overBudget() {
		cursor = nextBoundary(working, cursor)
		dropped = cursor
	}
	for cursor < hardFloor && overBudget() {
		cursor = nextBoundary(working, cursor)
		dropped = cursor
	}

	kept := working[cursor:]
	out := kept
	if dropped > 0 {
		marker := CompactionMarker(messages[:dropped])
		if options.Snapcompact {
			marker = SnapcompactMarker(messages[:dropped])
		}
		out = append([]types.Message{marker}, kept...)
	}
	return CompactionResult{
		Messages:          out,
		TokensBefore:      tokensBefore,
		TokensAfter:       HistoryTokens(out),
		ElidedToolResults: elided,
		DroppedMessages:   dropped,
	}
}

// SnapcompactMarker archives dropped messages as a text lead-in plus PNG frames
// of the full serialized transcript. A vision-capable model reads the frames
// back, so nothing is reduced to a summary. Falls back to the text marker when
// rendering fails or the archive would exceed the frame cap.
func SnapcompactMarker(dropped []types.Message) types.Message {
	archive := snapcompact.Serialize(dropped, snapcompact.SerializeOptions{})
	if strings.TrimSpace(archive) == "" {
		return CompactionMarker(dropped)
	}
	frames, err := snapcompact.Render(archive, snapcompact.RenderOptions{})
	if err != nil || len(frames) == 0 {
		return CompactionMarker(dropped)
	}
	blocks := []types.ContentBlock{types.TextBlock(snapcompactLeadIn(len(dropped), len(frames)))}
	for _, frame := range frames {
		blocks = append(blocks, types.ImageBlock(base64.StdEncoding.EncodeToString(frame), "image/png"))
	}
	return types.Message{Role: types.MessageUser, Blocks: blocks, Timestamp: types.NowMs()}
}

func snapcompactLeadIn(dropped, frames int) string {
	return fmt.Sprintf(
		"[context compacted as snapshots] %d earlier messages were archived into %d image frame(s). "+
			"Read the frames to recover the full history. The complete transcript is also on disk in the session JSONL.",
		dropped, frames,
	)
}

func hasImageBlock(blocks []types.ContentBlock) bool {
	for _, block := range blocks {
		if block.Type == "image" && block.Data != "" {
			return true
		}
	}
	return false
}

// nextBoundary advances past one whole exchange: a message plus, when it is an
// assistant turn with tool calls, all of its tool results.
func nextBoundary(messages []types.Message, from int) int {
	index := from + 1
	for index < len(messages) && messages[index].Role == types.MessageToolResult {
		index++
	}
	return index
}

// lastExchangeStart is the index where the final user→assistant→tools exchange
// begins.
func lastExchangeStart(messages []types.Message) int {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == types.MessageUser {
			return i
		}
	}
	return 0
}

func elidedNote(toolName, text string) string {
	head := util.Truncate(util.FirstLine(text), 120)
	return fmt.Sprintf("[older %s result elided to save context: %d chars. First line: %s]", toolName, len(text), head)
}

// CompactionMarker is one user message standing in for everything dropped.
func CompactionMarker(dropped []types.Message) types.Message {
	var prompts []string
	tools := []string{}
	seenTool := map[string]bool{}
	for _, message := range dropped {
		switch message.Role {
		case types.MessageUser:
			line := util.FirstLine(message.Text())
			if line != "" {
				prompts = append(prompts, "- "+util.Truncate(line, 100))
			}
		case types.MessageToolResult:
			if !seenTool[message.ToolName] {
				seenTool[message.ToolName] = true
				tools = append(tools, message.ToolName)
			}
		}
	}
	if len(prompts) > 6 {
		prompts = prompts[len(prompts)-6:]
	}
	lines := []string{
		fmt.Sprintf("[context compacted] %d earlier messages were dropped to stay inside the context budget.", len(dropped)),
	}
	if len(prompts) > 0 {
		lines = append(lines, "Earlier requests:\n"+strings.Join(prompts, "\n"))
	}
	if len(tools) > 0 {
		lines = append(lines, "Tools already used: "+strings.Join(tools, ", "))
	}
	lines = append(lines, "Full transcript is on disk in the session JSONL; re-run a tool if you need detail again.")
	return types.Message{
		Role:      types.MessageUser,
		Blocks:    []types.ContentBlock{types.TextBlock(strings.Join(lines, "\n"))},
		Timestamp: types.NowMs(),
	}
}

// SummarizationPrompt is what `/compact` uses to fold a session into a briefing.
func SummarizationPrompt() string {
	return strings.Join([]string{
		"Summarize this reverse engineering session for your own future self.",
		"Write dense notes, not prose. Cover:",
		"1. The target(s) and what has been established about them (formats, protections, key symbols/offsets).",
		"2. Commands and tools already run, with their conclusions — so they are not repeated.",
		"3. Current hypotheses, dead ends already ruled out, and the exact next steps.",
		"4. Any recovered values: flags, keys, tokens, file paths, artifact paths.",
		"Return only the notes.",
	}, "\n")
}
