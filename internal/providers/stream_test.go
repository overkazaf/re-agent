package providers

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func push(parser *StreamParser, lines ...string) []StreamEvent {
	var events []StreamEvent
	for _, line := range lines {
		events = append(events, parser.Push(line+"\n")...)
	}
	return events
}

func lastPlan(events []StreamEvent) []types.PlanStep {
	var plan []types.PlanStep
	for _, event := range events {
		if event.Kind == "plan" {
			plan = event.Plan
		}
	}
	return plan
}

func TestStreamFormatDetection(t *testing.T) {
	if StreamFormatFor("claude", []string{"--output-format", "stream-json"}) != FormatClaudeJSON {
		t.Fatal("claude stream-json not detected")
	}
	if StreamFormatFor("codex", []string{"exec", "--json"}) != FormatCodexJSON {
		t.Fatal("codex --json not detected")
	}
	if StreamFormatFor("claude", []string{"-p"}) != "" {
		t.Fatal("plain output must not be treated as a stream")
	}
}

func TestParserBuffersPartialLines(t *testing.T) {
	parser := NewStreamParser(FormatClaudeJSON, nil)
	if events := parser.Push(`{"type":"stream_event","event":{"type":"content_block_delta",`); len(events) != 0 {
		t.Fatal("a partial line must not emit events")
	}
	events := parser.Push(`"delta":{"type":"text_delta","text":"hi"}}}` + "\n")
	if len(events) != 1 || events[0].Kind != "text" || events[0].Text != "hi" {
		t.Fatalf("split line was not reassembled: %+v", events)
	}
	if len(parser.Push("not json at all\n")) != 0 {
		t.Fatal("interleaved plain text must be ignored")
	}
}

func TestClaudeTaskListFromCreateAndUpdate(t *testing.T) {
	parser := NewStreamParser(FormatClaudeJSON, nil)
	events := push(parser,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TaskCreate","input":{"subject":"identify file type"}}]}}`,
		`{"type":"user","tool_use_result":{"task":{"id":"1","subject":"identify file type"}}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}}]}}`,
	)
	plan := lastPlan(events)
	if len(plan) != 1 {
		t.Fatalf("expected one step, got %+v", plan)
	}
	if plan[0].Status != types.StepCompleted || plan[0].ID != "1" {
		t.Fatalf("task not bound/updated: %+v", plan[0])
	}
}

func TestClaudeBindsTaskIDFromResultText(t *testing.T) {
	parser := NewStreamParser(FormatClaudeJSON, nil)
	events := push(parser,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TaskCreate","input":{"subject":"locate the check"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"Task #7 created successfully: locate the check"}]}}`,
	)
	plan := lastPlan(events)
	if len(plan) != 1 || plan[0].ID != "7" {
		t.Fatalf("id was not bound from the result text: %+v", plan)
	}
}

func TestClaudeIgnoresSubAgentTasks(t *testing.T) {
	parser := NewStreamParser(FormatClaudeJSON, nil)
	events := push(parser,
		`{"type":"assistant","parent_tool_use_id":"abc","message":{"content":[{"type":"tool_use","name":"TaskCreate","input":{"subject":"sub-agent work"}}]}}`,
	)
	if len(lastPlan(events)) != 0 {
		t.Fatal("a sub-agent's task list must not reach the operator's plan")
	}
}

func TestClaudeUsageAndFinal(t *testing.T) {
	parser := NewStreamParser(FormatClaudeJSON, nil)
	push(parser,
		`{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":42,"cache_read_input_tokens":1000}}}`,
		`{"type":"result","result":"the answer","usage":{"input_tokens":10,"output_tokens":50},"total_cost_usd":0.02}`,
	)
	totals := parser.Totals()
	if totals.Output != 50 || totals.Input != 10 || totals.CostUsd != 0.02 {
		t.Fatalf("usage not merged: %+v", totals)
	}
	if parser.LastText() != "the answer" {
		t.Fatalf("final text lost: %q", parser.LastText())
	}
}

func TestClaudeRedactedThinkingStillReportsPhase(t *testing.T) {
	parser := NewStreamParser(FormatClaudeJSON, nil)
	events := push(parser,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","estimated_tokens":128}}}`,
	)
	if len(events) != 1 || events[0].Kind != "thinking" {
		t.Fatalf("redacted reasoning must still emit a phase: %+v", events)
	}
	if events[0].Usage == nil || events[0].Usage.Thinking != 128 {
		t.Fatalf("thinking estimate lost: %+v", events[0].Usage)
	}
}

func TestCodexPlanAndReasoning(t *testing.T) {
	parser := NewStreamParser(FormatCodexJSON, nil)
	events := push(parser,
		`{"msg":{"type":"agent_reasoning_delta","delta":"thinking about it"}}`,
		`{"msg":{"type":"plan_update","explanation":"first pass","plan":[{"step":"triage","status":"completed"},{"step":"solve","status":"in_progress"}]}}`,
		`{"msg":{"type":"exec_command_begin","command":["file","chall"]}}`,
		`{"type":"turn.completed","msg":{"type":"turn.completed","info":{"total_token_usage":{"input_tokens":7,"output_tokens":9}}}}`,
	)
	if events[0].Kind != "thinking" || events[0].Text != "thinking about it" {
		t.Fatalf("reasoning delta lost: %+v", events[0])
	}
	plan := lastPlan(events)
	if len(plan) != 2 || plan[0].Status != types.StepCompleted || plan[1].Status != types.StepInProgress {
		t.Fatalf("codex plan not translated: %+v", plan)
	}
	foundTool := false
	for _, event := range events {
		if event.Kind == "tool" && strings.Contains(event.Tool, "file chall") {
			foundTool = true
		}
	}
	if !foundTool {
		t.Fatal("exec_command_begin should surface as a tool event")
	}
	if parser.Totals().Output != 9 {
		t.Fatalf("turn.completed usage lost: %+v", parser.Totals())
	}
}

func TestCodexItemEnvelope(t *testing.T) {
	parser := NewStreamParser(FormatCodexJSON, nil)
	events := push(parser,
		`{"type":"item.completed","item":{"type":"todo_list","items":[{"text":"step one","completed":true},{"text":"step two"}]}}`,
		`{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}`,
	)
	plan := lastPlan(events)
	if len(plan) != 2 || plan[0].Status != types.StepCompleted {
		t.Fatalf("item-shaped plan not translated: %+v", plan)
	}
	if parser.LastText() != "final answer" {
		t.Fatalf("item-shaped final text lost: %q", parser.LastText())
	}
}

func TestTaskTableResetScopesToSession(t *testing.T) {
	table := &ClaudeTaskTable{}
	table.Bind("1", "old step")
	table.Reset()
	if len(table.Steps()) != 0 {
		t.Fatal("reset must drop the previous session's steps")
	}
	if table.Update("1", "completed", nil) {
		t.Fatal("an unknown id must be ignored rather than synthesised")
	}
}
