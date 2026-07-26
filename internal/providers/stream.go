package providers

// Normalizes the JSONL event streams emitted by `claude -p --output-format
// stream-json` and `codex exec --json` into one event shape, so the UI can show
// real reasoning text, tool activity, and token usage while a CLI turn runs.

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

type StreamEvent struct {
	Kind string // status | thinking | text | tool | usage | final | plan
	// Text is the delta for thinking/text.
	Text string
	// Tool is the tool name for kind=tool.
	Tool string
	// Status is a short phase label.
	Status string
	Usage  *types.TokenUsage
	// FinalText is the complete assistant reply, carried by kind=final.
	FinalText string
	// Plan is a full replacement task list.
	Plan []types.PlanStep
	// PlanNote is an optional one-line rationale accompanying a plan.
	PlanNote string
}

type StreamFormat string

const (
	FormatClaudeJSON StreamFormat = "claude-json"
	FormatCodexJSON  StreamFormat = "codex-json"
)

func StreamFormatFor(command string, args []string) StreamFormat {
	contains := func(needle string) bool {
		for _, arg := range args {
			if arg == needle {
				return true
			}
		}
		return false
	}
	if command == "claude" && contains("stream-json") {
		return FormatClaudeJSON
	}
	if command == "codex" && contains("--json") {
		return FormatCodexJSON
	}
	return ""
}

// StreamParser is an incremental JSONL parser. Feed it raw chunks as they are
// appended to the CLI stdout log; it buffers partial lines and yields
// normalized events.
type StreamParser struct {
	format StreamFormat
	buffer string
	usage  types.TokenUsage
	final  string
	// tasks must match the *CLI session's* lifetime, not the parser's: with
	// cliResumeSession the native session outlives the turn, and a turn that
	// only sends TaskUpdate would otherwise find an empty table and publish
	// nothing. The provider therefore owns the table and passes it in.
	tasks *ClaudeTaskTable
}

func NewStreamParser(format StreamFormat, tasks *ClaudeTaskTable) *StreamParser {
	if tasks == nil {
		tasks = &ClaudeTaskTable{}
	}
	return &StreamParser{format: format, tasks: tasks}
}

func (p *StreamParser) Totals() types.TokenUsage { return p.usage }

func (p *StreamParser) LastText() string { return p.final }

func (p *StreamParser) Push(chunk string) []StreamEvent {
	p.buffer += chunk
	var events []StreamEvent
	for {
		newline := strings.IndexByte(p.buffer, '\n')
		if newline < 0 {
			break
		}
		line := strings.TrimSpace(p.buffer[:newline])
		p.buffer = p.buffer[newline+1:]
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			continue // tolerate interleaved non-JSON output
		}
		events = append(events, p.translate(parsed)...)
	}
	return events
}

func (p *StreamParser) translate(event map[string]any) []StreamEvent {
	var events []StreamEvent
	if p.format == FormatClaudeJSON {
		events = translateClaude(event, p.tasks)
	} else {
		events = translateCodex(event)
	}
	for _, item := range events {
		if item.Usage != nil {
			p.usage = p.usage.Merge(*item.Usage)
		}
		if item.Kind == "final" && item.FinalText != "" {
			p.final = item.FinalText
		}
	}
	return events
}

// --- helpers -----------------------------------------------------------------

func asRecord(value any) map[string]any {
	record, _ := value.(map[string]any)
	return record
}

func num(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	}
	return 0, false
}

func str(value any) string {
	text, _ := value.(string)
	return text
}

func planStatus(value any) types.PlanStepStatus {
	switch str(value) {
	case "in_progress":
		return types.StepInProgress
	case "completed":
		return types.StepCompleted
	}
	return types.StepPending
}

// toPlan maps a raw list into steps. Plans are a decorative layer: every
// unrecognized entry is dropped and an empty list means "no plan event", so a
// shape change can never fail a run.
func toPlan(raw any, convert func(map[string]any) (types.PlanStep, bool)) []types.PlanStep {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	var steps []types.PlanStep
	for _, entry := range items {
		record := asRecord(entry)
		if record == nil {
			continue
		}
		if step, ok := convert(record); ok {
			steps = append(steps, step)
		}
	}
	return steps
}

// taskCreatedRE is the only place a task id is ever stated: TaskCreate's
// arguments carry no id — the CLI mints it server-side and reports it back in
// this result text.
var taskCreatedRE = regexp.MustCompile(`Task #(\d+) created successfully:[ \t]*([^\n]+)`)

type taskEntry struct {
	id     string
	text   string
	status types.PlanStepStatus
	// bound is true once a `Task #N created successfully` result confirmed the
	// id. Until then the id is a guess and the entry may still be claimed.
	bound bool
}

// ClaudeTaskTable is the ordered task table rebuilt from Claude's incremental
// TaskCreate / TaskUpdate calls. Every mutator reports whether the visible list
// actually changed, so a no-op confirmation does not churn the UI. Nothing here
// fails: unrecognized input simply reports "no change".
type ClaudeTaskTable struct {
	entries []taskEntry
}

// Reset drops everything. Called when the CLI starts a fresh native session.
func (t *ClaudeTaskTable) Reset() { t.entries = nil }

func (t *ClaudeTaskTable) Steps() []types.PlanStep {
	out := make([]types.PlanStep, 0, len(t.entries))
	for _, entry := range t.entries {
		out = append(out, types.PlanStep{ID: entry.id, Text: entry.text, Status: entry.status})
	}
	return out
}

// Bind is the authoritative id binding from a tool_result. It claims a matching
// provisional entry when there is one, so the TaskCreate fallback never
// double-inserts.
func (t *ClaudeTaskTable) Bind(id, subject string) bool {
	for i := range t.entries {
		if !t.entries[i].bound && t.entries[i].text == subject {
			changed := t.entries[i].id != id
			t.entries[i].id = id
			t.entries[i].bound = true
			return changed
		}
	}
	// Already known under this id (a repeated result, or a create we missed).
	for _, entry := range t.entries {
		if entry.id == id {
			return false
		}
	}
	t.entries = append(t.entries, taskEntry{id: id, text: subject, status: types.StepPending, bound: true})
	return true
}

// Create is the fallback for a TaskCreate whose result never arrives: surface
// the step immediately under a guessed id, which Bind corrects if it lands.
func (t *ClaudeTaskTable) Create(subject string) bool {
	for _, entry := range t.entries {
		if !entry.bound && entry.text == subject {
			return false
		}
	}
	t.entries = append(t.entries, taskEntry{id: t.nextID(), text: subject, status: types.StepPending})
	return true
}

// Update applies a TaskUpdate. An unknown id is ignored rather than inserted:
// synthesising a step from an id alone would put a meaningless row ("task 7") in
// front of the operator.
func (t *ClaudeTaskTable) Update(id string, status any, subject any) bool {
	for i := range t.entries {
		if t.entries[i].id != id {
			continue
		}
		changed := false
		if text, ok := status.(string); ok && text != "" {
			next := planStatus(text)
			if next != t.entries[i].status {
				t.entries[i].status = next
				changed = true
			}
		}
		if text, ok := subject.(string); ok && text != "" && text != t.entries[i].text {
			t.entries[i].text = text
			changed = true
		}
		return changed
	}
	return false
}

// nextID guesses "one past the max"; Claude numbers tasks sequentially.
func (t *ClaudeTaskTable) nextID() string {
	max := 0
	for _, entry := range t.entries {
		if value, err := strconv.Atoi(entry.id); err == nil && value > max {
			max = value
		}
	}
	return strconv.Itoa(max + 1)
}

// taskID accepts both the string form seen in practice and the numeric one.
func taskID(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		if typed != "" {
			return typed, true
		}
	case float64:
		if typed == float64(int(typed)) {
			return strconv.Itoa(int(typed)), true
		}
	}
	return "", false
}

// applyStructuredResult applies the structured `tool_use_result` that rides at
// the top level of a `user` event. It states the id/subject binding and the
// status transition as data rather than as English, so it is preferred over the
// result text. `handled` reports whether the shape was recognized at all — only
// when it was not do we fall back to parsing the prose.
func applyStructuredResult(event map[string]any, tasks *ClaudeTaskTable) (handled, changed bool) {
	result := asRecord(event["tool_use_result"])
	if result == nil {
		return false, false
	}
	// TaskCreate: {"task":{"id":"1","subject":"Identify file type"}}
	if task := asRecord(result["task"]); task != nil {
		if id, ok := taskID(task["id"]); ok {
			if subject := str(task["subject"]); subject != "" {
				return true, tasks.Bind(id, subject)
			}
		}
	}
	// TaskUpdate: {"taskId":"1","statusChange":{"from":"pending","to":"completed"}}.
	// Honouring this makes the table self-correcting when the TaskUpdate
	// tool_use itself was missed — the one loss that would otherwise strand a step.
	if id, ok := taskID(result["taskId"]); ok {
		var to any
		if change := asRecord(result["statusChange"]); change != nil {
			to = change["to"]
		}
		return true, tasks.Update(id, to, result["subject"])
	}
	return false, false
}

// isSubAgentEvent: a non-null parent_tool_use_id marks a call made by a spawned
// sub-agent. Sub-agents keep their own task lists, which are not the operator's
// plan, so their task events must not reach the table.
func isSubAgentEvent(event map[string]any) bool {
	return str(event["parent_tool_use_id"]) != ""
}

// resultTexts: a tool_result's `content` is a plain string in some events and
// text blocks in others.
func resultTexts(content any) []string {
	if text, ok := content.(string); ok {
		return []string{text}
	}
	items, ok := content.([]any)
	if !ok {
		return nil
	}
	var texts []string
	for _, raw := range items {
		if text, ok := raw.(string); ok {
			texts = append(texts, text)
			continue
		}
		// Non-text blocks (tool_reference, images, …) carry no subject.
		if record := asRecord(raw); record != nil {
			if text := str(record["text"]); text != "" {
				texts = append(texts, text)
			}
		}
	}
	return texts
}

func claudeUsage(raw map[string]any) *types.TokenUsage {
	if raw == nil {
		return nil
	}
	usage := types.TokenUsage{}
	found := false
	set := func(target *float64, value any) {
		if parsed, ok := num(value); ok {
			*target = parsed
			found = true
		}
	}
	set(&usage.Input, raw["input_tokens"])
	set(&usage.Output, raw["output_tokens"])
	set(&usage.CacheRead, raw["cache_read_input_tokens"])
	set(&usage.CacheWrite, raw["cache_creation_input_tokens"])
	if details := asRecord(raw["output_tokens_details"]); details != nil {
		set(&usage.Thinking, details["thinking_tokens"])
	}
	if !found {
		return nil
	}
	return &usage
}

func translateClaude(event map[string]any, tasks *ClaudeTaskTable) []StreamEvent {
	switch str(event["type"]) {
	case "system":
		if str(event["subtype"]) == "status" {
			if status := str(event["status"]); status != "" {
				return []StreamEvent{{Kind: "status", Status: status}}
			}
		}
		return nil

	case "stream_event":
		inner := asRecord(event["event"])
		if inner == nil {
			return nil
		}
		switch str(inner["type"]) {
		case "content_block_delta":
			delta := asRecord(inner["delta"])
			if delta == nil {
				return nil
			}
			switch str(delta["type"]) {
			case "thinking_delta":
				// Claude Code redacts the reasoning text and reports only a
				// running token estimate, so emit the phase regardless of
				// whether text is present and carry the estimate as live usage.
				out := StreamEvent{Kind: "thinking", Text: str(delta["thinking"])}
				if estimated, ok := num(delta["estimated_tokens"]); ok {
					out.Usage = &types.TokenUsage{Thinking: estimated}
				}
				return []StreamEvent{out}
			case "text_delta":
				if text := str(delta["text"]); text != "" {
					return []StreamEvent{{Kind: "text", Text: text}}
				}
			}
			return nil

		case "content_block_start":
			block := asRecord(inner["content_block"])
			if block == nil {
				return nil
			}
			if str(block["type"]) == "tool_use" {
				if name := str(block["name"]); name != "" {
					return []StreamEvent{{Kind: "tool", Tool: name}}
				}
			}
			if str(block["type"]) == "thinking" {
				return []StreamEvent{{Kind: "thinking"}}
			}
			return nil

		case "message_start":
			if message := asRecord(inner["message"]); message != nil {
				if usage := claudeUsage(asRecord(message["usage"])); usage != nil {
					return []StreamEvent{{Kind: "usage", Usage: usage}}
				}
			}
			return nil

		case "message_delta":
			if usage := claudeUsage(asRecord(inner["usage"])); usage != nil {
				return []StreamEvent{{Kind: "usage", Usage: usage}}
			}
			return nil
		}
		return nil

	// The streamed content_block_start above sees a tool name but never its
	// arguments; the assembled call arrives in this non-streamed event, which is
	// the only place a task-list call is complete.
	case "assistant":
		if isSubAgentEvent(event) {
			return nil
		}
		message := asRecord(event["message"])
		if message == nil {
			return nil
		}
		content, ok := message["content"].([]any)
		if !ok {
			return nil
		}
		var events []StreamEvent
		for _, raw := range content {
			block := asRecord(raw)
			if block == nil || str(block["type"]) != "tool_use" {
				continue
			}
			input := asRecord(block["input"])
			switch str(block["name"]) {
			case "TodoWrite":
				// Claude Code 2.1.x has no TodoWrite, but other versions and
				// configs do, and there it is still a whole-list replacement.
				steps := toPlan(input["todos"], func(entry map[string]any) (types.PlanStep, bool) {
					text := str(entry["content"])
					if text == "" {
						return types.PlanStep{}, false
					}
					return types.PlanStep{Text: text, Status: planStatus(entry["status"])}, true
				})
				if len(steps) > 0 {
					events = append(events, StreamEvent{Kind: "plan", Plan: steps})
				}
			case "TaskCreate":
				// TaskCreate states no id; the `Task #N created` tool_result
				// binds one. Insert on the call anyway so a missing result
				// cannot hide a step.
				if subject := str(input["subject"]); subject != "" && tasks.Create(subject) {
					events = append(events, StreamEvent{Kind: "plan", Plan: tasks.Steps()})
				}
			case "TaskUpdate":
				if id, ok := taskID(input["taskId"]); ok && tasks.Update(id, input["status"], input["subject"]) {
					events = append(events, StreamEvent{Kind: "plan", Plan: tasks.Steps()})
				}
			}
		}
		return events

	// Tool results ride back in as `user` events. They are the only place a task
	// id is ever stated, which makes them the authoritative binding.
	case "user":
		if isSubAgentEvent(event) {
			return nil
		}
		var events []StreamEvent
		// Structured first: `tool_use_result` states the binding as data. The
		// result text is only parsed when that shape is absent or unrecognized.
		handled, changed := applyStructuredResult(event, tasks)
		if changed {
			events = append(events, StreamEvent{Kind: "plan", Plan: tasks.Steps()})
		}
		if handled {
			return events
		}
		message := asRecord(event["message"])
		if message == nil {
			return events
		}
		blocks, _ := message["content"].([]any)
		for _, raw := range blocks {
			block := asRecord(raw)
			if block == nil || str(block["type"]) != "tool_result" {
				continue
			}
			for _, text := range resultTexts(block["content"]) {
				if match := taskCreatedRE.FindStringSubmatch(text); match != nil {
					if tasks.Bind(match[1], strings.TrimSpace(match[2])) {
						events = append(events, StreamEvent{Kind: "plan", Plan: tasks.Steps()})
					}
				}
			}
		}
		return events

	case "result":
		usage := claudeUsage(asRecord(event["usage"]))
		if usage == nil {
			usage = &types.TokenUsage{}
		}
		if cost, ok := num(event["total_cost_usd"]); ok {
			usage.CostUsd = cost
		}
		return []StreamEvent{{Kind: "final", FinalText: str(event["result"]), Usage: usage}}
	}
	return nil
}

// Codex has iterated on its JSONL shape across versions, so match several known
// layouts and ignore anything unrecognized rather than guessing.
func translateCodex(event map[string]any) []StreamEvent {
	msg := asRecord(event["msg"])
	if msg == nil {
		msg = event
	}
	kind := str(msg["type"])
	if kind == "" {
		kind = str(event["type"])
	}

	switch kind {
	case "agent_reasoning_delta", "reasoning_delta":
		text := str(msg["delta"])
		if text == "" {
			text = str(msg["text"])
		}
		if text != "" {
			return []StreamEvent{{Kind: "thinking", Text: text}}
		}
	case "agent_reasoning", "reasoning":
		if text := str(msg["text"]); text != "" {
			return []StreamEvent{{Kind: "thinking", Text: text}}
		}
	case "agent_message_delta":
		if text := str(msg["delta"]); text != "" {
			return []StreamEvent{{Kind: "text", Text: text}}
		}
	case "agent_message":
		text := str(msg["message"])
		if text == "" {
			text = str(msg["text"])
		}
		if text != "" {
			return []StreamEvent{{Kind: "final", FinalText: text}}
		}
	case "exec_command_begin", "exec_command":
		command := ""
		if parts, ok := msg["command"].([]any); ok {
			var words []string
			for _, part := range parts {
				words = append(words, str(part))
			}
			command = strings.Join(words, " ")
		} else {
			command = str(msg["command"])
		}
		if command != "" {
			return []StreamEvent{{Kind: "tool", Tool: "shell: " + command}}
		}
		return []StreamEvent{{Kind: "tool", Tool: "shell"}}
	case "token_count", "usage", "turn.completed":
		// `turn.completed` carries the authoritative per-turn usage in current
		// Codex builds; `token_count` is the older streaming counter.
		info := asRecord(msg["info"])
		if info == nil {
			info = msg
		}
		total := asRecord(event["usage"])
		if total == nil {
			total = asRecord(info["total_token_usage"])
		}
		if total == nil {
			total = asRecord(info["usage"])
		}
		if total == nil {
			total = info
		}
		usage := types.TokenUsage{}
		found := false
		pick := func(target *float64, keys ...string) {
			for _, key := range keys {
				if value, ok := num(total[key]); ok {
					*target = value
					found = true
					return
				}
			}
		}
		pick(&usage.Input, "input_tokens", "prompt_tokens")
		pick(&usage.Output, "output_tokens", "completion_tokens")
		pick(&usage.Thinking, "reasoning_output_tokens", "reasoning_tokens")
		pick(&usage.CacheRead, "cached_input_tokens")
		if found {
			return []StreamEvent{{Kind: "usage", Usage: &usage}}
		}
	case "plan_update", "update_plan":
		// Legacy plan shape: UpdatePlanArgs { explanation, plan: [PlanItemArg] }.
		steps := toPlan(msg["plan"], func(entry map[string]any) (types.PlanStep, bool) {
			text := str(entry["step"])
			if text == "" {
				return types.PlanStep{}, false
			}
			return types.PlanStep{Text: text, Status: planStatus(entry["status"])}, true
		})
		if len(steps) == 0 {
			return nil
		}
		return []StreamEvent{{Kind: "plan", Plan: steps, PlanNote: str(msg["explanation"])}}
	case "turn.started":
		return []StreamEvent{{Kind: "status", Status: "requesting"}}
	case "item.completed", "item.started":
		// Newer item-based envelope: {"type":"item.completed","item":{...}}
		item := asRecord(event["item"])
		if item == nil {
			item = asRecord(msg["item"])
		}
		if item == nil {
			return nil
		}
		itemType := str(item["type"])
		switch itemType {
		case "reasoning":
			if text := str(item["text"]); text != "" {
				return []StreamEvent{{Kind: "thinking", Text: text}}
			}
			return nil
		case "agent_message":
			if text := str(item["text"]); text != "" {
				return []StreamEvent{{Kind: "final", FinalText: text}}
			}
			return nil
		case "command_execution":
			if command := str(item["command"]); command != "" {
				return []StreamEvent{{Kind: "tool", Tool: "shell: " + command}}
			}
			return []StreamEvent{{Kind: "tool", Tool: "shell"}}
		}
		// Item-shaped plan. The tag lives under `type` in some builds and
		// `item_type` in others, and the list is `items` or `todo_items`.
		if itemType == "" {
			itemType = str(item["item_type"])
		}
		if itemType == "todo_list" {
			raw := item["items"]
			if _, ok := raw.([]any); !ok {
				raw = item["todo_items"]
			}
			steps := toPlan(raw, func(entry map[string]any) (types.PlanStep, bool) {
				text := str(entry["text"])
				if text == "" {
					text = str(entry["step"])
				}
				if text == "" {
					return types.PlanStep{}, false
				}
				status := planStatus(entry["status"])
				if completed, ok := entry["completed"].(bool); ok && completed {
					status = types.StepCompleted
				}
				return types.PlanStep{Text: text, Status: status}, true
			})
			if len(steps) > 0 {
				return []StreamEvent{{Kind: "plan", Plan: steps}}
			}
		}
	}
	return nil
}
