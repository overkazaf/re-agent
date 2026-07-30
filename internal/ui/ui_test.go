package ui

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
)

func TestDisplayWidthCountsCJKAsTwo(t *testing.T) {
	if got := DisplayWidth("定位校验函数"); got != 12 {
		t.Fatalf("CJK width wrong: %d", got)
	}
	if got := DisplayWidth(C.Accent("abc")); got != 3 {
		t.Fatalf("ANSI escapes must not count: %d", got)
	}
}

func TestTruncateAndPad(t *testing.T) {
	if got := Truncate("abcdefgh", 4); DisplayWidth(got) > 4 {
		t.Fatalf("truncate overflowed: %q", got)
	}
	if got := PadEnd("定位", 8); DisplayWidth(got) != 8 {
		t.Fatalf("pad wrong: %q", got)
	}
}

func TestWrapAnsiBreaksCJKWithoutSpaces(t *testing.T) {
	lines := WrapAnsi(strings.Repeat("定", 20), 10, "")
	for _, line := range lines {
		if DisplayWidth(line) > 10 {
			t.Fatalf("CJK line overflowed the width: %q (%d)", line, DisplayWidth(line))
		}
	}
	if len(lines) < 4 {
		t.Fatalf("expected the CJK run to wrap, got %d lines", len(lines))
	}
}

// hudFits is the invariant the whole live redraw rests on: every line must
// measure at most `width` columns, and the body at most `maxRows` lines.
func hudFits(t *testing.T, model HudModel) []string {
	t.Helper()
	lines := RenderHud(model)
	for _, line := range lines {
		if DisplayWidth(line) > model.Width {
			t.Fatalf("HUD line overflowed %d columns: %q (%d)", model.Width, line, DisplayWidth(line))
		}
	}
	if model.MaxRows > 0 && len(lines) > model.MaxRows {
		t.Fatalf("HUD drew %d rows, budget was %d", len(lines), model.MaxRows)
	}
	return lines
}

func samplePlan() *types.PlanSnapshot {
	return &types.PlanSnapshot{
		Source: "codex", Note: "first pass",
		Steps: []types.PlanStep{
			{Text: "triage: file/arch/packer", Status: types.StepCompleted, StartedAt: 1000, CompletedAt: 2200},
			{Text: "定位校验函数并复现", Status: types.StepInProgress, StartedAt: 2200},
			{Text: "reproduce the flag path", Status: types.StepPending},
		},
	}
}

func TestHudRespectsWidthAndHeight(t *testing.T) {
	base := HudModel{
		Label: "codex", Phase: "thinking", Frame: "⠹", ElapsedMs: 128_000, Now: 5000,
		Stats: types.TokenUsage{Input: 12_000, Output: 4100, Thinking: 105, CacheRead: 416_000, CostUsd: 0.71},
		Spark: []float64{1, 4, 9, 20, 12, 6, 3, 1},
		Route: &HudRoute{Planner: "codex", Executor: "claude", Active: "codex"},
		Plan:  samplePlan(), Thinking: "the checker looks like sub_401a20; check xrefs before patching",
	}
	for _, width := range []int{120, 80, 61, 59, 40, 24} {
		for _, rows := range []int{40, 8, 6, 4, 3} {
			model := base
			model.Width = width
			model.MaxRows = rows
			hudFits(t, model)
		}
	}
}

func TestHudShowsTheActiveStepAtSixRows(t *testing.T) {
	model := HudModel{
		Label: "codex", Phase: "working", Frame: "⠹", Width: 100, MaxRows: 6, Now: 5000,
		Plan: samplePlan(),
	}
	body := strings.Join(hudFits(t, model), "\n")
	if !strings.Contains(body, "定位校验函数并复现") {
		t.Fatalf("the in-progress step must survive at the floor:\n%s", body)
	}
}

func TestHudFallsBackToOneLine(t *testing.T) {
	model := HudModel{Label: "codex", Phase: "working", Frame: "⠹", Width: 100, MaxRows: 2}
	if lines := RenderHud(model); len(lines) != 1 {
		t.Fatalf("expected the one-line fallback, got %d lines", len(lines))
	}
}

func TestPlanRowsCollapseButKeepTheActiveStep(t *testing.T) {
	var steps []types.PlanStep
	for index := 0; index < 6; index++ {
		steps = append(steps, types.PlanStep{Text: "done step", Status: types.StepCompleted})
	}
	steps = append(steps, types.PlanStep{Text: "current step", Status: types.StepInProgress})
	rows := PlanRows(steps, PlanRowOptions{CollapseAfter: 3})
	if len(rows) > 3 {
		t.Fatalf("collapse ignored: %d rows", len(rows))
	}
	joined := ""
	for _, row := range rows {
		joined += row.Text + "|"
	}
	if !strings.Contains(joined, "current step") || !strings.Contains(joined, "6 done") {
		t.Fatalf("collapse lost the important rows: %s", joined)
	}
}

func TestHudPlanDisplayMode(t *testing.T) {
	var steps []types.PlanStep
	for index := 0; index < 6; index++ {
		steps = append(steps, types.PlanStep{Text: "done step", Status: types.StepCompleted})
	}
	steps = append(steps, types.PlanStep{Text: "current step", Status: types.StepInProgress})
	steps = append(steps, types.PlanStep{Text: "later step", Status: types.StepPending})
	plan := &types.PlanSnapshot{Source: "test", Steps: steps}

	collapsed := strings.Join(hudFits(t, HudModel{
		Label: "codex", Phase: "working", Frame: "⠹", Width: 100, MaxRows: 20,
		Plan: plan, PlanDisplay: PlanDisplayCollapsed,
	}), "\n")
	if !strings.Contains(collapsed, "current step") || strings.Contains(collapsed, "later step") {
		t.Fatalf("collapsed plan should keep active row and hide tail:\n%s", collapsed)
	}

	expanded := strings.Join(hudFits(t, HudModel{
		Label: "codex", Phase: "working", Frame: "⠹", Width: 100, MaxRows: 20,
		Plan: plan, PlanDisplay: PlanDisplayExpanded,
	}), "\n")
	if !strings.Contains(expanded, "later step") {
		t.Fatalf("expanded plan should show pending tail:\n%s", expanded)
	}
}

func TestHudThinkDisplayMode(t *testing.T) {
	// Distinct markers per line so the test can tell how deep the tail runs.
	var reasoning []string
	for index := 0; index < 12; index++ {
		reasoning = append(reasoning, fmt.Sprintf("reasoning-line-%02d padding padding padding padding", index))
	}
	base := HudModel{
		Label: "codex", Phase: "thinking", Frame: "⠹", Width: 100, MaxRows: 24,
		Thinking: strings.Join(reasoning, " "),
	}

	auto := strings.Join(hudFits(t, base), "\n")
	if !strings.Contains(auto, "reasoning-line-11") {
		t.Fatalf("auto should tail the newest reasoning:\n%s", auto)
	}
	if strings.Contains(auto, "reasoning-line-00") {
		t.Fatalf("auto window is %d rows and should not reach the oldest line:\n%s", defaultThinkWindow, auto)
	}

	folded := base
	folded.ThinkDisplay = ThinkDisplayCollapsed
	collapsed := strings.Join(hudFits(t, folded), "\n")
	if strings.Contains(collapsed, "reasoning-line-") {
		t.Fatalf("collapsed should drop every reasoning row:\n%s", collapsed)
	}

	opened := base
	opened.ThinkDisplay = ThinkDisplayExpanded
	expandedThink := strings.Join(hudFits(t, opened), "\n")
	if !strings.Contains(expandedThink, "reasoning-line-00") {
		t.Fatalf("expanded should reach further back than auto:\n%s", expandedThink)
	}
}

// Expanding is a request, not an override: the row budget still wins, and the
// reasoning the operator asked for is the last thing shed rather than the first.
func TestHudThinkExpandedShedsLast(t *testing.T) {
	var steps []types.PlanStep
	for index := 0; index < 8; index++ {
		steps = append(steps, types.PlanStep{Text: fmt.Sprintf("step %d", index), Status: types.StepCompleted})
	}
	plan := &types.PlanSnapshot{Source: "test", Steps: steps, Note: "a note that can be shed"}
	model := HudModel{
		Label: "codex", Phase: "thinking", Frame: "⠹", Width: 100, MaxRows: 10,
		Plan: plan, Thinking: "keep-this-reasoning-visible under pressure",
	}

	// Guard against the budget quietly going slack and making this test vacuous:
	// at this height auto must genuinely lose the tail.
	if strings.Contains(strings.Join(hudFits(t, model), "\n"), "keep-this-reasoning-visible") {
		t.Fatal("budget is not tight enough for this test to mean anything")
	}

	model.ThinkDisplay = ThinkDisplayExpanded
	lines := strings.Join(hudFits(t, model), "\n")
	if !strings.Contains(lines, "keep-this-reasoning-visible") {
		t.Fatalf("expanded reasoning should survive a tight budget:\n%s", lines)
	}
}

func TestRenderPlanBoxIsBounded(t *testing.T) {
	lines := RenderPlan(samplePlan(), RenderPlanOptions{Width: 60})
	for _, line := range lines {
		if DisplayWidth(line) > 60 {
			t.Fatalf("plan box overflowed: %q (%d)", line, DisplayWidth(line))
		}
	}
	if !strings.Contains(lines[0], "PLAN") {
		t.Fatalf("plan header missing: %q", lines[0])
	}
	if RenderPlan(nil, RenderPlanOptions{}) != nil {
		t.Fatal("a nil snapshot renders nothing")
	}
}

func TestSparklineNeedsMovement(t *testing.T) {
	if Sparkline([]float64{0, 0, 0}, 8) != "" {
		t.Fatal("a flat idle window must render nothing")
	}
	if got := Sparkline([]float64{1, 5, 9}, 8); DisplayWidth(got) != 3 {
		t.Fatalf("sparkline width wrong: %q", got)
	}
}

func TestTraceEventShapes(t *testing.T) {
	options := TraceOptions{StartedAt: 0, Now: 1234}
	send := TraceEvent(core.LoopEvent{
		Type: "wire", Phase: "send", Provider: "deepseek", Model: "deepseek-chat",
		Endpoint: "https://api.deepseek.com/v1/chat/completions", Messages: 3, Tokens: 17, Tools: 23,
	}, options)
	if len(send) != 2 || !strings.Contains(send[0], "POST") || !strings.Contains(send[1], "model=deepseek-chat") {
		t.Fatalf("send trace wrong: %+v", send)
	}
	recv := TraceEvent(core.LoopEvent{
		Type: "wire", Phase: "recv", OK: true, Ms: 3680,
		Usage: &types.TokenUsage{Output: 103, CacheRead: 3500}, ToolCalls: 2,
	}, options)
	if len(recv) != 1 || !strings.Contains(recv[0], "200") || !strings.Contains(recv[0], "calls=") {
		t.Fatalf("recv trace wrong: %+v", recv)
	}
	if lines := TraceEvent(core.LoopEvent{Type: "turn", Turn: 1}, options); len(lines) != 0 {
		t.Fatal("the first turn needs no line")
	}
	if lines := TraceEvent(core.LoopEvent{Type: "tool_start", Name: "update_plan"}, options); len(lines) != 0 {
		t.Fatal("the plan tool is narrated by its plan lines, not as a tool call")
	}
}

func TestTracePlanTransitionsOnly(t *testing.T) {
	previous := &types.PlanSnapshot{Source: "codex", Steps: []types.PlanStep{
		{Text: "one", Status: types.StepInProgress}, {Text: "two", Status: types.StepPending},
	}}
	// A pure append of pending steps is list construction, not a transition.
	appended := &types.PlanSnapshot{Source: "codex", Steps: []types.PlanStep{
		{Text: "one", Status: types.StepInProgress},
		{Text: "two", Status: types.StepPending},
		{Text: "three", Status: types.StepPending},
	}}
	if lines := TraceEvent(core.LoopEvent{Type: "plan", Snapshot: appended},
		TraceOptions{PreviousPlan: previous}); len(lines) != 0 {
		t.Fatalf("a pure append must stay silent: %+v", lines)
	}
	advanced := &types.PlanSnapshot{Source: "codex", Steps: []types.PlanStep{
		{Text: "one", Status: types.StepCompleted, StartedAt: 1, CompletedAt: 1200},
		{Text: "two", Status: types.StepPending},
	}}
	lines := TraceEvent(core.LoopEvent{Type: "plan", Snapshot: advanced}, TraceOptions{PreviousPlan: previous})
	if len(lines) != 1 || !strings.Contains(lines[0], "one") {
		t.Fatalf("a status change should print one line: %+v", lines)
	}
	rewritten := &types.PlanSnapshot{Source: "codex", Steps: []types.PlanStep{{Text: "totally new", Status: types.StepPending}}}
	lines = TraceEvent(core.LoopEvent{Type: "plan", Snapshot: rewritten}, TraceOptions{PreviousPlan: previous})
	if len(lines) != 1 || !strings.Contains(lines[0], "rewritten") {
		t.Fatalf("a rewrite should be reported: %+v", lines)
	}
	opened := TraceEvent(core.LoopEvent{Type: "plan", Snapshot: previous}, TraceOptions{})
	if len(opened) != 1 || !strings.Contains(opened[0], "opened via codex") {
		t.Fatalf("a first plan should report its source: %+v", opened)
	}
}

func TestFlowDiagramFitsAndReactsToEvents(t *testing.T) {
	model := NewFlowModel("deepseek")
	model.Begin("deepseek")
	model.Apply(core.LoopEvent{
		Type: "wire", Phase: "send", Provider: "deepseek", Model: "deepseek-chat",
		Messages: 3, Tokens: 7000, Tools: 23,
	})
	for i := 0; i < 20; i++ {
		model.Tick()
	}
	state := model.Snapshot()
	lines := RenderFlowPlain(state, 80, types.NowMs())
	if len(lines) != 5 {
		t.Fatalf("expected five diagram rows, got %d", len(lines))
	}
	for _, line := range lines {
		if DisplayWidth(line) > 80 {
			t.Fatalf("diagram row overflowed: %q", line)
		}
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "[you]") || !strings.Contains(joined, "((deepseek))") {
		t.Fatalf("diagram missing its nodes:\n%s", joined)
	}
	if !strings.Contains(joined, "7.0ktok") {
		t.Fatalf("context token count missing:\n%s", joined)
	}
	// Too narrow to be honest about: draw nothing rather than a broken diagram.
	if lines := RenderFlowPlain(state, 30, types.NowMs()); lines != nil {
		t.Fatalf("expected no diagram below the minimum width, got %+v", lines)
	}
}

func TestFlowPlanBadgeUsesCountsOnly(t *testing.T) {
	model := NewFlowModel("codex")
	model.Begin("codex")
	model.Apply(core.LoopEvent{Type: "wire", Phase: "send", Provider: "codex"})
	model.Apply(core.LoopEvent{Type: "plan", Snapshot: samplePlan()})
	lines := RenderFlowPlain(model.Snapshot(), 100, types.NowMs())
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "[plan 1/3]") {
		t.Fatalf("plan badge missing:\n%s", joined)
	}
	if strings.Contains(joined, "定位校验函数") {
		t.Fatal("step text must stay out of the diagram")
	}
}

func TestComposePaneKeepsTheHudFloor(t *testing.T) {
	model := NewFlowModel("codex")
	model.Begin("codex")
	model.Apply(core.LoopEvent{Type: "wire", Phase: "send", Provider: "codex"})
	state := model.Snapshot()
	hud := HudModel{Label: "codex", Phase: "working", Frame: "⠹", Width: 80, Plan: samplePlan(), Now: 5000}

	// Plenty of room: both layers are drawn.
	full := ComposePane(types.NowMs(), 80, 40, &state, hud)
	if len(full) <= 5 {
		t.Fatalf("expected diagram + HUD, got %d lines", len(full))
	}
	for _, line := range full {
		if DisplayWidth(line) > 80 {
			t.Fatalf("pane line overflowed: %q (%d columns)", line, DisplayWidth(line))
		}
	}
	// Tight budget: the diagram is dropped whole rather than clipped.
	tight := ComposePane(types.NowMs(), 80, 8, &state, hud)
	if len(tight) > 8 {
		t.Fatalf("pane overran its budget: %d lines", len(tight))
	}
	if strings.Contains(strings.Join(tight, "\n"), "[you]") {
		t.Fatal("a partial diagram is worse than none")
	}
}

func TestComposePaneBoundsLongToolRows(t *testing.T) {
	model := NewFlowModel("codex")
	model.Begin("codex")
	model.Apply(core.LoopEvent{Type: "wire", Phase: "send", Provider: "codex", Tokens: 871000, Messages: 15})
	model.Apply(core.LoopEvent{Type: "tool_start", Name: `shell: /bin/zsh -lc "python3 -c 'import json,struct,subprocess,bisect; path=\"libtb_crypto.so\"'"`})
	for index := 0; index < 20; index++ {
		model.Tick()
	}
	state := model.Snapshot()
	hud := HudModel{
		Label: "codex", Phase: `shell: /bin/zsh -lc "python3 -c 'import json,struct,subprocess,bisect'"`,
		Frame: "⠹", Width: 72, MaxRows: 10, Now: types.NowMs(),
		Stats: types.TokenUsage{Input: 871000},
	}
	lines := ComposePane(types.NowMs(), 72, 10, &state, hud)
	if len(lines) > 10 {
		t.Fatalf("pane overran its budget: %d lines", len(lines))
	}
	for _, line := range lines {
		if DisplayWidth(line) > 72 {
			t.Fatalf("pane line overflowed: %q (%d columns)", line, DisplayWidth(line))
		}
	}
}

func TestSafeCommitLinesTruncatesAndSplits(t *testing.T) {
	lines := safeCommitLines("short\n"+strings.Repeat("x", 80), 24)
	if len(lines) != 2 {
		t.Fatalf("expected two lines, got %d", len(lines))
	}
	for _, line := range lines {
		if DisplayWidth(line) > 24 {
			t.Fatalf("commit line overflowed: %q (%d columns)", line, DisplayWidth(line))
		}
	}
	if !strings.Contains(lines[1], "…") {
		t.Fatalf("long commit line should be visibly truncated: %q", lines[1])
	}
}

func TestMarkdownRendering(t *testing.T) {
	source := "# Heading\n\nSome **bold** and `code`.\n\n- first\n- second\n\n```sh\nfile ./chall\n```\n"
	rendered := RenderMarkdown(source, 60)
	for _, line := range strings.Split(rendered, "\n") {
		if DisplayWidth(line) > 60 {
			t.Fatalf("markdown line overflowed: %q (%d)", line, DisplayWidth(line))
		}
	}
	if !strings.Contains(rendered, "Heading") || !strings.Contains(rendered, "file ./chall") {
		t.Fatalf("markdown lost content:\n%s", rendered)
	}
	if strings.Contains(rendered, "**") || strings.Contains(rendered, "`") {
		t.Fatalf("markdown markers survived:\n%s", rendered)
	}
}

func TestMarkdownTable(t *testing.T) {
	source := "| tool | risk |\n| --- | --- |\n| grep | read |\n"
	rendered := RenderMarkdown(source, 40)
	if !strings.Contains(rendered, "grep") || !strings.Contains(rendered, "risk") {
		t.Fatalf("table lost content:\n%s", rendered)
	}
}

func TestSlashCompletions(t *testing.T) {
	providers := []string{"codex", "claude", "mock"}
	commands := SlashCompletions("/the", providers, nil)
	if len(commands) != 1 || commands[0].Value != "/theme" {
		t.Fatalf("command completion wrong: %+v", commands)
	}
	arguments := SlashCompletions("/agent ", providers, nil)
	if len(arguments) != 4 || arguments[0].Value != "auto" {
		t.Fatalf("argument completion wrong: %+v", arguments)
	}
	efforts := SlashCompletions("/effort codex hi", providers, nil)
	if len(efforts) != 1 || efforts[0].Value != "high" {
		t.Fatalf("second-argument completion wrong: %+v", efforts)
	}
	if SlashCompletions("not a command", providers, nil) != nil {
		t.Fatal("plain prompts must not complete")
	}
	replacements := CompletionReplacements("/the", providers, nil)
	if len(replacements) != 1 || replacements[0] != "/theme " {
		t.Fatalf("replacement wrong: %+v", replacements)
	}
}

func TestPaletteRendersWithinWidth(t *testing.T) {
	panel := FormatSlashCommandPalette("/", []string{"codex"}, PaletteOptions{Limit: 5})
	for _, line := range strings.Split(panel, "\n") {
		if DisplayWidth(line) > TermWidth() {
			t.Fatalf("palette line overflowed: %q", line)
		}
	}
	if !strings.Contains(panel, "COMMANDS") {
		t.Fatalf("palette title missing:\n%s", panel)
	}
}

func TestShellStreamWriterBuffersPartialLines(t *testing.T) {
	var out strings.Builder
	writer := NewShellStreamWriter(func(text string) { out.WriteString(text) })
	writer.Push("stdout", "hello ")
	if out.Len() != 0 {
		t.Fatal("a partial line must be held back")
	}
	writer.Push("stdout", "world\ntail")
	if !strings.Contains(out.String(), "hello world") {
		t.Fatalf("completed line not written: %q", out.String())
	}
	writer.Flush()
	if !strings.Contains(out.String(), "tail") {
		t.Fatalf("flush lost the trailing partial line: %q", out.String())
	}
}

func TestFormatDurationAndCompactNumber(t *testing.T) {
	cases := map[int64]string{500: "500ms", 3680: "3.7s", 128_000: "2m08s"}
	for ms, want := range cases {
		if got := FormatDuration(ms); got != want {
			t.Fatalf("duration %d: got %s want %s", ms, got, want)
		}
	}
	if got := CompactNumber(3500); got != "3.5k" {
		t.Fatalf("compact number wrong: %s", got)
	}
	if got := CompactNumber(1_200_000); got != "1.2M" {
		t.Fatalf("compact number wrong: %s", got)
	}
}

// The model box embeds a provider name straight from the config. Byte length
// would shift every column right of it once that name is not ASCII.
func TestFlowDiagramSurvivesAWideProviderName(t *testing.T) {
	model := NewFlowModel("模型")
	model.Begin("模型")
	model.Apply(core.LoopEvent{Type: "wire", Phase: "send", Provider: "模型", Tokens: 7000, Messages: 3})
	model.Apply(core.LoopEvent{Type: "tool_start", Name: "反编译 sub_401a20"})
	for index := 0; index < 12; index++ {
		model.Tick()
	}
	lines := RenderFlowPlain(model.Snapshot(), 80, types.NowMs())
	if len(lines) != 5 {
		t.Fatalf("expected five rows, got %d", len(lines))
	}
	for _, line := range lines {
		if DisplayWidth(line) > 80 {
			t.Fatalf("row overflowed the width: %q (%d columns)", line, DisplayWidth(line))
		}
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "((模型))") {
		t.Fatalf("the model node lost its name:\n%s", joined)
	}
	// The token label must not be overwritten by the node that follows it.
	if !strings.Contains(joined, "7.0ktok") {
		t.Fatalf("the context label was clobbered:\n%s", joined)
	}
}

// Stop racing Resume used to signal whichever channel happened to be installed.
func TestLivePaneStopIsSafeUnderPauseResume(t *testing.T) {
	pane := NewLivePane("codex", LivePaneOptions{})
	var wg sync.WaitGroup
	for index := 0; index < 4; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pane.Pause()
			pane.SetPhase("thinking")
			pane.Resume()
			pane.SetStats(types.TokenUsage{Output: 10})
		}()
	}
	wg.Wait()
	pane.Stop()
	pane.Stop() // idempotent
}
