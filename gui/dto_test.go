package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

func flowStage(t *testing.T, name string) ui.FlowStage {
	t.Helper()
	switch name {
	case "idle", "send", "wait", "think", "calls", "tool", "write", "done", "error":
		return ui.FlowStage(name)
	}
	t.Fatalf("unknown stage %q", name)
	return ""
}

// TestFlowDTOEveryStage walks every FlowStage enum value and checks the fields
// the dashboard panels key off, so a ui-side stage rename cannot slip through
// the mapping silently.
func TestFlowDTOEveryStage(t *testing.T) {
	cases := []struct {
		stage      string
		wantActive bool // stages where the model wire is "hot"
	}{
		{stage: "idle"}, {stage: "send", wantActive: true}, {stage: "wait", wantActive: true},
		{stage: "think", wantActive: true}, {stage: "calls", wantActive: true},
		{stage: "tool", wantActive: true}, {stage: "write", wantActive: true},
		{stage: "done"}, {stage: "error"},
	}
	for _, tc := range cases {
		t.Run(tc.stage, func(t *testing.T) {
			state := ui.FlowState{
				Stage: flowStage(t, tc.stage), Turn: 3, Provider: "mock", Model: "mock-reasoner",
				Endpoint: "mock://mock-reasoner", Messages: 7, SentTokens: 1234,
				Usage:      types.TokenUsage{Input: 10, Output: 4, CostUsd: 0.5},
				ReplyChars: 42, Frame: 9, Since: 1700000000000,
			}
			dto := NewFlowDTO(state)
			if dto.Stage != tc.stage {
				t.Fatalf("stage = %q, want %q", dto.Stage, tc.stage)
			}
			if dto.Turn != 3 || dto.Provider != "mock" || dto.Model != "mock-reasoner" {
				t.Fatalf("identity fields wrong: %+v", dto)
			}
			if dto.Endpoint != "mock://mock-reasoner" || dto.Messages != 7 || dto.SentTokens != 1234 {
				t.Fatalf("wire fields wrong: %+v", dto)
			}
			if dto.Usage != (WireTokenUsage{Input: 10, Output: 4, CostUsd: 0.5}) {
				t.Fatalf("usage wrong: %+v", dto.Usage)
			}
			if dto.ReplyChars != 42 || dto.Frame != 9 || dto.Since != 1700000000000 {
				t.Fatalf("misc fields wrong: %+v", dto)
			}
			if len(dto.Packets) != 5 {
				t.Fatalf("packets rows = %d, want 5 (one per ui edge)", len(dto.Packets))
			}
			for i, row := range dto.Packets {
				if row == nil {
					t.Fatalf("packets[%d] is nil, want []", i)
				}
			}
			if dto.ToolRuns == nil {
				t.Fatal("toolRuns is nil, want []")
			}
			if dto.Plan != nil {
				t.Fatal("plan should stay nil without a badge")
			}
		})
	}
}

func TestFlowDTOToolRunsAndPlan(t *testing.T) {
	state := ui.FlowState{
		Stage: ui.FlowStage("tool"), ActiveTool: "run_command", ToolStartedAt: 1700000000000, ToolMs: 3200,
		ToolsOK: 2, ToolsFailed: 1, PendingCalls: 1,
		ToolRuns: []ui.ToolRunSnapshot{
			{ID: 1, Name: "file_info", ArgsText: "path=./x", Preview: "ELF64", Status: ui.ToolRunDone,
				StartedAt: 100, FinishedAt: 200, Ms: 100, OK: true},
			{ID: 2, Name: "run_command", Status: ui.ToolRunRunning, StartedAt: 300},
			{ID: 3, Name: "entropy_scan", Preview: "boom", Status: ui.ToolRunFailed, Ms: 5, OK: false},
		},
		HasCompacted: true, CompactedDrop: 4, CompactedElide: 2,
	}
	dto := NewFlowDTO(state)
	if len(dto.ToolRuns) != 3 || dto.ToolRuns[0].Status != "done" || !dto.ToolRuns[0].OK {
		t.Fatalf("tool runs mapping wrong: %+v", dto.ToolRuns)
	}
	if dto.ToolRuns[1].Status != "running" || dto.ToolRuns[2].Status != "failed" || dto.ToolRuns[2].OK {
		t.Fatalf("tool run statuses wrong: %+v", dto.ToolRuns)
	}
	if dto.ToolRuns[0].ArgsText != "path=./x" || dto.ToolRuns[0].Preview != "ELF64" || dto.ToolRuns[0].Ms != 100 {
		t.Fatalf("tool run detail wrong: %+v", dto.ToolRuns[0])
	}
	if dto.ActiveTool != "run_command" || dto.ToolStartedAt != 1700000000000 || dto.ToolMs != 3200 || dto.PendingCalls != 1 {
		t.Fatalf("active tool fields wrong: %+v", dto)
	}
	if dto.ToolsOK != 2 || dto.ToolsFailed != 1 {
		t.Fatalf("tool tally wrong: %+v", dto)
	}
	if !dto.HasCompacted || dto.CompactedDrop != 4 || dto.CompactedElide != 2 {
		t.Fatalf("compaction fields wrong: %+v", dto)
	}
	// planBadge is unexported in ui; build one through FlowModel.Apply instead.
	model := ui.NewFlowModel("mock")
	model.Apply(core.LoopEvent{Type: "plan", Snapshot: &types.PlanSnapshot{
		Source: "test",
		Steps: []types.PlanStep{
			{Text: "done step", Status: types.StepCompleted},
			{Text: "open step", Status: types.StepPending},
		},
	}})
	snap := model.Snapshot()
	if snap.Plan == nil {
		t.Fatal("expected a plan badge after a plan event")
	}
	mapped := NewFlowDTO(snap)
	if mapped.Plan == nil || mapped.Plan.Total != 2 || mapped.Plan.Done != 1 || mapped.Plan.Source != "test" {
		t.Fatalf("plan badge mapping wrong: %+v", mapped.Plan)
	}
	if mapped.PlanKind != "open" {
		t.Fatalf("planKind = %q, want open", mapped.PlanKind)
	}
}

func TestFlowDTOPacketsCopied(t *testing.T) {
	state := ui.FlowState{Stage: ui.FlowStage("send")}
	state.Packets[0] = []int{1, 2, 3}
	dto := NewFlowDTO(state)
	dto.Packets[0][0] = 99 // mutate the DTO; the source must be untouched
	if !reflect.DeepEqual(state.Packets[0], []int{1, 2, 3}) {
		t.Fatalf("mapping aliased the source packets: %v", state.Packets[0])
	}
}

// TestHudDTOMapping covers the HUD strip fields the manager tracks per turn.
func TestHudDTOMapping(t *testing.T) {
	snapshot := HudSnapshot{
		Phase: "thinking", Frame: "⠙", ElapsedMs: 4200,
		Stats:      types.TokenUsage{Input: 8, Thinking: 15},
		Spark:      []float64{0, 2, 5},
		Route:      &ui.HudRoute{Planner: "planner", Executor: "mock", Active: "mock"},
		QueueCount: 2, PlanDisplay: "auto", ThinkDisplay: "expanded",
	}
	dto := NewHudDTO(snapshot)
	if dto.Phase != "thinking" || dto.Frame != "⠙" || dto.ElapsedMs != 4200 {
		t.Fatalf("hud basics wrong: %+v", dto)
	}
	if dto.Route == nil || dto.Route.Planner != "planner" || dto.Route.Active != "mock" {
		t.Fatalf("route wrong: %+v", dto.Route)
	}
	if !reflect.DeepEqual(dto.Spark, []float64{0, 2, 5}) {
		t.Fatalf("spark wrong: %v", dto.Spark)
	}
	// Mutating the DTO spark must not touch the source slice.
	dto.Spark[0] = 9
	if !reflect.DeepEqual(snapshot.Spark, []float64{0, 2, 5}) {
		t.Fatalf("hud mapping aliased the spark buffer: %v", snapshot.Spark)
	}
	if dto.QueueCount != 2 || dto.PlanDisplay != "auto" || dto.ThinkDisplay != "expanded" {
		t.Fatalf("hud display fields wrong: %+v", dto)
	}

	empty := NewHudDTO(HudSnapshot{})
	if empty.Spark == nil || empty.Route != nil {
		t.Fatalf("empty hud should carry nil route and empty spark: %+v", empty)
	}
}

func TestReDTOMapping(t *testing.T) {
	if NewReDTO(nil) != nil {
		t.Fatal("nil RE state must map to nil")
	}
	re := NewReDTO(&ui.REHudModel{
		SampleType: "ctf", Phase: "static", PhaseIndex: 1, PhaseCount: 7,
		Hypotheses: 2, Evidence: 5,
	})
	if re.SampleType != "ctf" || re.Phase != "static" || re.PhaseIndex != 1 || re.PhaseCount != 7 {
		t.Fatalf("re mapping wrong: %+v", re)
	}
	if re.Hypotheses != 2 || re.Evidence != 5 {
		t.Fatalf("re counts wrong: %+v", re)
	}
}

func TestTickDTOAssembly(t *testing.T) {
	plan := &types.PlanSnapshot{Source: "test", UpdatedAt: 5}
	tick := NewTickDTO(
		ui.FlowState{Stage: ui.FlowStage("wait"), Turn: 1},
		HudSnapshot{Phase: "working"}, nil, plan,
	)
	if tick.Flow.Stage != "wait" || tick.Hud.Phase != "working" || tick.Re != nil || tick.Plan != plan {
		t.Fatalf("tick assembly wrong: %+v", tick)
	}
}

// TestZeroUsageWireShape guards the TokenUsage omitempty trap: core's struct
// marshals a zero value as {} on the wire, which the frontend reads as
// undefined and crashed TelePanel/TranscriptStream. The DTO layer must map to
// WireTokenUsage so every field is always present in the JSON.
func TestZeroUsageWireShape(t *testing.T) {
	tick := NewTickDTO(ui.FlowState{}, HudSnapshot{}, nil, nil)

	flowJSON, err := json.Marshal(tick.Flow)
	if err != nil {
		t.Fatalf("marshal flow: %v", err)
	}
	raw := string(flowJSON)
	start := strings.Index(raw, `"usage":`)
	if start < 0 {
		t.Fatalf("flow JSON has no usage object: %s", raw)
	}
	end := strings.Index(raw[start:], "}")
	usage := raw[start+len(`"usage":`) : start+len(`"usage":`)+end+1]
	for _, field := range []string{`"input":0`, `"output":0`, `"thinking":0`, `"cacheRead":0`, `"cacheWrite":0`, `"costUsd":0`} {
		if !strings.Contains(usage, field) {
			t.Fatalf("zero usage JSON missing %s: %s (full: %s)", field, usage, raw)
		}
	}

	hudJSON, err := json.Marshal(tick.Hud)
	if err != nil {
		t.Fatalf("marshal hud: %v", err)
	}
	rawHud := string(hudJSON)
	hStart := strings.Index(rawHud, `"stats":`)
	if hStart < 0 {
		t.Fatalf("hud JSON has no stats object: %s", rawHud)
	}
	hEnd := strings.Index(rawHud[hStart:], "}")
	stats := rawHud[hStart+len(`"stats":`) : hStart+len(`"stats":`)+hEnd+1]
	for _, field := range []string{`"input":0`, `"costUsd":0`} {
		if !strings.Contains(stats, field) {
			t.Fatalf("zero stats JSON missing %s: %s (full: %s)", field, stats, rawHud)
		}
	}
}
