package ui

// The permanent half of the visualization: one line per event, stamped with an
// offset from the start of the turn, committed into the scrollback while the
// diagram above it animates. Reading a finished turn afterwards should feel like
// reading a packet capture.

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

const gutter = "▏"

// planTool is the host-side task-list tool; its calls are narrated as plan
// transitions instead.
const planTool = "update_plan"

const traceBarCells = 10

type TraceOptions struct {
	// StartedAt is the turn start, so every line carries `t+…` rather than a
	// wall clock.
	StartedAt int64
	Now       int64
	Width     int
	// SlowestMs is the longest request seen so far, so the duration bars share
	// one scale.
	SlowestMs int64
	// PreviousPlan is the plan as it was before this event, so only the
	// transition is printed.
	PreviousPlan *types.PlanSnapshot
}

// TraceEvent renders one event as trace lines. It returns nothing for events
// that carry no new information worth a permanent line (token counters, partial
// text).
func TraceEvent(event core.LoopEvent, options TraceOptions) []string {
	now := options.Now
	if now == 0 {
		now = types.NowMs()
	}
	width := options.Width
	if width == 0 {
		width = TermWidth()
	}
	stamp := C.Faint(fmt.Sprintf("t+%6.3f ", float64(now-options.StartedAt)/1000))
	bodyWidth := width - 14
	if bodyWidth < 20 {
		bodyWidth = 20
	}
	line := func(mark string, markStyle Painter, body string) string {
		return stamp + C.Rule(gutter) + markStyle(mark) + " " + Truncate(body, bodyWidth)
	}

	switch event.Type {
	case "turn":
		if event.Turn == 1 {
			return nil
		}
		return []string{line("↻", C.Faint, C.Faint("turn")+" "+C.Text(fmt.Sprintf("%d", event.Turn)))}

	case "compaction":
		return []string{line("◈", C.Warn, fmt.Sprintf("%s %s %s",
			C.Faint("context"),
			C.Text(CompactNumber(float64(event.TokensBefore))+"→"+CompactNumber(float64(event.TokensAfter))+" tok"),
			C.Faint(fmt.Sprintf("%d dropped · %d elided", event.DroppedMessages, event.ElidedToolResults)),
		))}

	case "wire":
		if event.Phase == "send" {
			return []string{
				line("⇢", C.Accent, C.Accent("POST")+" "+C.Text(event.Endpoint)),
				strings.Repeat(" ", 9) + C.Rule(gutter) + "  " + C.Faint(fmt.Sprintf(
					"model=%s in=%s msgs=%d tools=%d",
					event.Model, CompactNumber(float64(event.Tokens)), event.Messages, event.Tools)),
			}
		}
		if !event.OK {
			reason := event.Error
			if reason == "" {
				reason = "failed"
			}
			return []string{line("⇠", C.Err, C.Err(reason)+" "+C.Faint(FormatDuration(event.Ms)))}
		}
		parts := []string{C.OK("200")}
		if event.Usage != nil {
			if event.Usage.Output != 0 {
				parts = append(parts, C.Faint("out=")+C.Text(CompactNumber(event.Usage.Output)))
			}
			if event.Usage.Thinking != 0 {
				parts = append(parts, C.Faint("think=")+C.Violet(CompactNumber(event.Usage.Thinking)))
			}
			if event.Usage.CacheRead != 0 {
				parts = append(parts, C.Faint("cache=")+C.OK(CompactNumber(event.Usage.CacheRead)))
			}
		}
		if event.ToolCalls > 0 {
			parts = append(parts, C.Faint("calls=")+C.Violet(fmt.Sprintf("%d", event.ToolCalls)))
		}
		slowest := options.SlowestMs
		if slowest == 0 {
			slowest = event.Ms
		}
		parts = append(parts, durationBar(event.Ms, slowest))
		return []string{line("⇠", C.OK, strings.Join(parts, " "))}

	// The plan tool is narrated by its own `plan` lines below, and its argument
	// is the entire task list as JSON — printing it twice is pure noise. A
	// failure still gets a line, because then nothing else reports it.
	case "tool_start":
		if event.Name == planTool {
			return nil
		}
		return []string{line(" ⚙", C.Violet, C.Violet(event.Name)+" "+C.Faint(summarizeArgs(event.Args)))}

	case "tool_end":
		if event.Name == planTool && event.OK {
			return nil
		}
		mark := " ✗"
		style := C.Err
		if event.OK {
			mark = " ✓"
			style = C.OK
		}
		return []string{line(mark, style, C.Faint(FormatDuration(event.Ms))+" "+C.Muted(event.Preview))}

	case "plan":
		return planLines(event.Snapshot, options.PreviousPlan, line)

	case "reply":
		body := C.Faint("reply") + " " + C.Text(CompactNumber(float64(len(event.Text)))+" chars")
		if event.Usage != nil && event.Usage.Output != 0 {
			body += " " + C.Faint("·") + " " + C.Text(CompactNumber(event.Usage.Output)+" tok")
		}
		return []string{line("◆", C.Accent, body)}
	}
	return nil
}

// TraceEnd is the closing line of a turn: the total, so the trace block reads as
// one unit.
func TraceEnd(startedAt, ms int64, provider string, interrupted bool) string {
	mark := C.Accent("■")
	what := C.Faint("turn complete")
	if interrupted {
		mark = C.Warn("⊘")
		what = C.Warn("interrupted")
	}
	return C.Faint(fmt.Sprintf("t+%6.3f ", float64(ms)/1000)) + C.Rule(gutter) + mark + " " + what +
		" " + C.Faint("via") + " " + C.Accent(provider) + " " + C.Faint(FormatDuration(ms))
}

// planLines renders a plan update as a *transition*, never as a dump — the full
// list is archived to the scrollback once, at the end of the turn. Pure appends
// are silent: a list being constructed step by step (Claude sends one TaskCreate
// per step) is not a timeline event, and would otherwise print a line per step.
func planLines(next, previous *types.PlanSnapshot, line func(string, Painter, string) string) []string {
	if next == nil {
		return nil
	}
	done := 0
	for _, step := range next.Steps {
		if step.Status == types.StepCompleted {
			done++
		}
	}
	head := C.Faint("plan") + " " + C.Text(fmt.Sprintf("%d/%d", done, len(next.Steps)))
	const mark = "◇"

	if previous == nil {
		return []string{line(mark, C.Accent, head+" "+C.Faint("opened via "+next.Source))}
	}

	// The shared prefix has to line up by text for this to be the same list
	// growing; anything else (a shrink, a reorder, an edit) is a rewrite.
	prefixIntact := true
	for index, step := range previous.Steps {
		if index >= len(next.Steps) || next.Steps[index].Text != step.Text {
			prefixIntact = false
			break
		}
	}
	if !prefixIntact {
		return []string{line(mark, C.Warn,
			head+" "+C.Faint(fmt.Sprintf("rewritten (was %d steps)", len(previous.Steps))))}
	}

	// Status changes anywhere in the shared prefix, plus any *new* step that did
	// not arrive as plain `pending`. Appending pending steps is list
	// construction and stays silent — but an append that also closes a step is
	// two real transitions, and the whole-list sources send exactly that shape
	// whenever a model finds work while finishing work.
	var changed []types.PlanStep
	for index, before := range previous.Steps {
		if index < len(next.Steps) && before.Status != next.Steps[index].Status {
			changed = append(changed, next.Steps[index])
		}
	}
	for _, step := range next.Steps[minOf(len(previous.Steps), len(next.Steps)):] {
		if step.Status != types.StepPending {
			changed = append(changed, step)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	if len(changed) > 3 {
		return []string{line(mark, C.Accent, head+" "+C.Faint(fmt.Sprintf("%d steps advanced", len(changed))))}
	}
	out := make([]string, 0, len(changed))
	for _, step := range changed {
		out = append(out, line(mark, statusStyle(step), head+" "+stepBody(step)))
	}
	return out
}

func statusStyle(step types.PlanStep) Painter {
	switch step.Status {
	case types.StepCompleted:
		return C.OK
	case types.StepInProgress:
		return C.Violet
	}
	return C.Faint
}

func stepBody(step types.PlanStep) string {
	glyph := C.Faint("○")
	switch step.Status {
	case types.StepCompleted:
		glyph = C.OK("✔")
	case types.StepInProgress:
		glyph = C.Violet("▸")
	}
	took := ""
	// Same rule as the HUD: only report a duration that was actually elapsed.
	if step.Status == types.StepCompleted && step.StartedAt != 0 && step.CompletedAt > step.StartedAt {
		took = " " + C.Faint(FormatDuration(step.CompletedAt-step.StartedAt))
	}
	return glyph + " " + C.Text(step.Text) + took
}

// durationBar is a relative bar scaled against the slowest request of the turn.
func durationBar(ms, slowestMs int64) string {
	ratio := 0.0
	if slowestMs > 0 {
		ratio = float64(ms) / float64(slowestMs)
		if ratio > 1 {
			ratio = 1
		}
	}
	filled := int(ratio*float64(traceBarCells) + 0.5)
	if filled < 1 {
		filled = 1
	}
	if filled > traceBarCells {
		filled = traceBarCells
	}
	return C.AccentDim(strings.Repeat("█", filled)) +
		C.Rule(strings.Repeat("░", traceBarCells-filled)) + " " + C.Faint(FormatDuration(ms))
}

func summarizeArgs(args map[string]any) string {
	if len(args) == 0 {
		return ""
	}
	var parts []string
	for key, value := range args {
		rendered, ok := value.(string)
		if !ok {
			encoded, _ := json.Marshal(value)
			rendered = string(encoded)
		}
		parts = append(parts, key+"="+rendered)
	}
	sort.Strings(parts)
	joined := strings.Join(parts, " ")
	if DisplayWidth(joined) > 60 {
		return Truncate(joined, 58)
	}
	return joined
}

func minOf(a, b int) int {
	if a < b {
		return a
	}
	return b
}
