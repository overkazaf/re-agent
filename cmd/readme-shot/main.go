// Command readme-shot renders authentic README screenshots of the live
// dashboard (and friends) to stdout with FORCE_COLOR=1, so docs can be
// regenerated from the real renderer instead of hand-drawn mockups.
//
//	FORCE_COLOR=1 go run ./cmd/readme-shot [--frame N] [--width 100]
package main

import (
	"flag"
	"fmt"
	"time"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

func main() {
	frame := flag.Int("frame", 0, "animation frame index (drives spinner + elapsed)")
	width := flag.Int("width", 100, "terminal width")
	mode := flag.String("mode", "dashboard", "dashboard | remote")
	flag.Parse()

	if *mode == "remote" {
		printRemote(*width)
		return
	}
	state := dashboardState(*frame)
	hud := dashboardHud(*frame, *width)
	for _, line := range ui.RenderDashboard(state, hud) {
		fmt.Println(line)
	}
}

func printRemote(width int) {
	rows := [][]string{
		{ui.C.Text("lab"), ui.C.Faint("dev@10.0.0.5"), ui.C.Muted("password")},
		{ui.C.Text("srv"), ui.C.Faint("root@srv.local"), ui.C.Muted("key:~/.ssh/id_ed25519")},
	}
	fmt.Print(ui.FormatTable("REMOTE HOSTS", []string{"name", "target", "auth"}, rows))
	fmt.Println(ui.RenderNotice("remote mode: lab — run_command and !shell execute there"))
	fmt.Println(ui.RenderNotice("encrypted at ~/.0xaf-re-agent/remote.json (AES-256-GCM)"))
}

func dashboardState(frame int) *ui.FlowState {
	model := ui.NewFlowModel("deepseek")
	model.Begin("deepseek")
	now := int64(time.Now().UnixMilli()) - int64(1600+frame*160)
	model.Apply(core.LoopEvent{Type: "wire", Phase: "send", Provider: "deepseek", Model: "deepseek-chat", Messages: 3, Tokens: 3600, Tools: 23})
	model.Apply(core.LoopEvent{Type: "plan", Snapshot: &types.PlanSnapshot{Source: "codex", Note: "first pass", Steps: []types.PlanStep{
		{Text: "triage: file/arch/packer", Status: types.StepCompleted, StartedAt: now - 5000, CompletedAt: now - 1000},
		{Text: "定位校验函数并复现", Status: types.StepInProgress, StartedAt: now - 1000},
		{Text: "reproduce the flag path", Status: types.StepPending},
	}}})
	model.Apply(core.LoopEvent{Type: "wire", Phase: "recv", Provider: "deepseek", OK: true, ToolCalls: 1, Usage: &types.TokenUsage{Output: 96, CacheRead: 3500}})
	model.Apply(core.LoopEvent{Type: "tool_start", Name: "run_command", Args: map[string]any{"command": "strings ./chall"}})
	state := model.Snapshot()
	state.Frame = frame
	state.ToolStartedAt = now
	state.Since = now
	return &state
}

func dashboardHud(frame, width int) ui.HudModel {
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	return ui.HudModel{
		Label: "deepseek", Phase: "run_command", Frame: frames[frame%len(frames)],
		Width: width, MaxRows: 30, ElapsedMs: int64(2500 + frame*160),
		Now:   time.Now().UnixMilli(),
		Stats: types.TokenUsage{Input: 3600, Output: 120, Thinking: 2048, CacheRead: 3500, CostUsd: 0.0123},
		Spark: []float64{4, 9, 2, 14, 7, 12, 20, 6, 3, 9, 15, 8, 11, 5, 2, 13},
		Route: &ui.HudRoute{Planner: "codex", Executor: "claude", Active: "claude"},
		Plan: &types.PlanSnapshot{Source: "codex", Note: "first pass", Steps: []types.PlanStep{
			{Text: "triage: file/arch/packer", Status: types.StepCompleted},
			{Text: "定位校验函数并复现", Status: types.StepInProgress},
			{Text: "reproduce the flag path", Status: types.StepPending},
		}},
		Thinking: "Looking at the binary's entry point. The packer looks like UPX based on section names. Trying to find the main function now.",
	}
}
