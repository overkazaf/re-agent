package ui

// The static plan box: the same task list the live HUD draws, minus the parts
// that only make sense while something is running. The CLI archives one of
// these into the scrollback after the pane stops, and `/plan` reprints it, so it
// carries no spinner frame and no live counters — just the list, its completion
// bar, and how long each finished step took.
//
// All the box and row primitives live in hud.go, so the archived snapshot and
// the live pane cannot drift apart visually.

import (
	"fmt"
	"regexp"

	"github.com/overkazaf/re-agent/internal/plan"
	"github.com/overkazaf/re-agent/internal/types"
)

const planCollapseAfter = 8

type RenderPlanOptions struct {
	// Width is the total columns the box may occupy. Zero defaults to the width
	// the live HUD used.
	Width int
	// Frame is the spinner glyph for the in-progress row.
	Frame string
	// CollapseAfter is the step rows shown before the list starts collapsing.
	CollapseAfter int
	// NoTimings omits per-step elapsed labels.
	NoTimings bool
	// Live shows a running elapsed on the in-progress step. Off by default here:
	// this box is printed once, so a duration that keeps growing after the frame
	// was captured would be a lie the reader cannot see.
	Live bool
}

// RenderPlan renders a plan snapshot as box-drawn lines (no trailing newlines):
//
//	╭─ PLAN 2/4 ▰▰▰▰▱▱▱▱ 50% ────────────╮
//	│ ✔ triage: file/arch/packer    1.2s  │
//	│ ⠿ 定位校验函数                 4.0s │
//	│ ○ 复现 flag 路径                    │
//	╰─────────────────────────────────────╯
//
// Never emits more than CollapseAfter + 3 lines, so callers can budget the
// height of an in-place redraw up front. Every line measures at most Width
// columns via DisplayWidth, which is what keeps the live redraw from wrapping.
func RenderPlan(snapshot *types.PlanSnapshot, options RenderPlanOptions) []string {
	if snapshot == nil || len(snapshot.Steps) == 0 {
		return nil
	}
	width := options.Width
	if width == 0 {
		width = TerminalColumns(80) - 1
		if width > HudMaxWidth {
			width = HudMaxWidth
		}
	}
	if width < MinBoxWidth {
		width = MinBoxWidth
	}
	inner := BoxInner(width)
	done, total := plan.Counts(snapshot)

	head := []Chip{chip("PLAN", C.Bold(C.Accent("PLAN")))}
	head = append(head, chip(fmt.Sprintf("%d/%d", done, total),
		C.OK(fmt.Sprintf("%d", done))+C.Faint("/")+C.Text(fmt.Sprintf("%d", total))))
	if progress, ok := ProgressChip(done, total, barCells); ok {
		head = append(head, progress)
	}

	lines := []string{BoxTop(width, head)}
	if snapshot.Note != "" {
		lines = append(lines, BoxRow(C.Faint(Truncate(snapshot.Note, inner)), width))
	}

	collapseAfter := options.CollapseAfter
	if collapseAfter == 0 {
		collapseAfter = planCollapseAfter
	}
	rows := PlanRows(snapshot.Steps, PlanRowOptions{
		CollapseAfter: collapseAfter,
		Frame:         options.Frame,
		NoTimings:     options.NoTimings,
		Live:          options.Live,
	})
	for _, row := range rows {
		lines = append(lines, BoxRow(PaintPlanRow(row, inner), width))
	}
	return append(lines, BoxBottom(width))
}

func mustCompile(pattern string) *regexp.Regexp { return regexp.MustCompile(pattern) }
