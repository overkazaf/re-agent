package ui

// A unified live dashboard: one box with labeled FLOW / TOOLS / PLAN / THINK /
// TELE sections, replacing the side-by-side panes. It deliberately stays inside
// the existing redraw contract — every line is bounded, and tight terminals
// fall back to the compact HUD (hud.go).

import (
	"fmt"
	"math"
	"strings"

	"github.com/overkazaf/re-agent/internal/plan"
	"github.com/overkazaf/re-agent/internal/types"
)

const (
	// dashboardMinWidth/Rows are the floor under which the sectioned box stops
	// being an improvement over the compact HUD fallback.
	dashboardMinWidth = 60
	dashboardMinRows  = 9
	// flowSectionRoom leaves room inside the box for the section label plus the
	// box borders, so the flow strip never pushes a wrapped line into the box.
	flowSectionRoom = 12
	sectionGap      = 2
	// toolCardRows caps the recent tool runs the TOOLS section shows.
	toolCardRows = 2
)

func sectionLabel(name string) string {
	return C.Faint(name) + strings.Repeat(" ", sectionGap)
}

// RenderDashboard renders one frame as a single box with labeled sections.
// Wide, tall terminals get the full dashboard; anything else falls back to the
// compact HUD.
func RenderDashboard(flow *FlowState, model HudModel) []string {
	width := model.Width
	if width < 1 {
		width = 1
	}
	maxRows := model.MaxRows
	if maxRows <= 0 || width < dashboardMinWidth || maxRows < dashboardMinRows {
		return renderDashboardFallback(model)
	}

	options := dashboardOptionsFor(model)
	body := dashboardBuild(flow, model, width, options)

	// Transient narration goes before state you cannot recover by scrolling:
	// flow strip, tool cards, reasoning tail, telemetry, then the plan note and
	// the task list collapse. The plan itself is the last thing to go. Asked-for
	// content (`/think expand`) sheds last instead.
	shed := func(cond func() bool, apply func()) {
		for len(body) > maxRows && cond() {
			apply()
			body = dashboardBuild(flow, model, width, options)
		}
	}
	if model.ThinkDisplay == ThinkDisplayExpanded {
		shed(func() bool { return options.note }, func() { options.note = false })
		shed(func() bool { return options.collapseAfter > 1 }, func() { options.collapseAfter-- })
		shed(func() bool { return options.showTele }, func() { options.showTele = false })
		shed(func() bool { return options.showToolCards }, func() { options.showToolCards = false })
		shed(func() bool { return options.showFlow }, func() { options.showFlow = false })
		shed(func() bool { return options.thinkWindow > 0 }, func() { options.thinkWindow-- })
	} else {
		shed(func() bool { return options.showFlow }, func() { options.showFlow = false })
		shed(func() bool { return options.showToolCards }, func() { options.showToolCards = false })
		shed(func() bool { return options.thinkWindow > 0 }, func() { options.thinkWindow-- })
		shed(func() bool { return options.showTele }, func() { options.showTele = false })
		shed(func() bool { return options.note }, func() { options.note = false })
		shed(func() bool { return options.collapseAfter > 1 }, func() { options.collapseAfter-- })
	}
	if len(body) > maxRows {
		// A terminal too short even for the tightest box still keeps its head
		// and its closing edge, so the box never reads as truncated mid-draw.
		trimmed := append([]string{}, body[:maxRows-1]...)
		body = append(trimmed, body[len(body)-1])
	}
	return body
}

type dashboardOptions struct {
	showFlow      bool
	showToolCards bool
	thinkWindow   int
	showTele      bool
	note          bool
	collapseAfter int
}

func dashboardOptionsFor(model HudModel) dashboardOptions {
	thinkWindow := defaultThinkWindow
	if model.ThinkingWindow > 0 {
		thinkWindow = model.ThinkingWindow
	}
	switch model.ThinkDisplay {
	case ThinkDisplayCollapsed:
		thinkWindow = 0
	case ThinkDisplayExpanded:
		thinkWindow = expandedThinkWindow
	}
	collapseAfter := defaultCollapse
	switch model.PlanDisplay {
	case PlanDisplayCollapsed:
		collapseAfter = 1
	case PlanDisplayExpanded:
		collapseAfter = math.MaxInt32 / 4
	}
	return dashboardOptions{
		showFlow:      true,
		showToolCards: true,
		thinkWindow:   thinkWindow,
		showTele:      true,
		note:          true,
		collapseAfter: collapseAfter,
	}
}

func renderDashboardFallback(model HudModel) []string {
	if model.Width > HudMaxWidth {
		model.Width = HudMaxWidth
	}
	return RenderHud(model)
}

func dashboardBuild(flow *FlowState, model HudModel, width int, options dashboardOptions) []string {
	inner := BoxInner(width)

	var head []Chip
	if model.Frame != "" {
		head = append(head, chip(model.Frame, C.Accent(model.Frame)))
	}
	head = append(head, chip(HudTitle, C.Bold(C.Accent(HudTitle))))

	lines := []string{BoxTop(width, head), BoxRow(statusRow(model, inner), width)}
	if row := queueRow(model, inner); row != "" {
		lines = append(lines, BoxRow(row, width))
	}

	// FLOW / TOOLS: the dataflow strip, labelled by which half of the loop it is.
	if options.showFlow {
		if flow == nil {
			lines = append(lines, BoxRow(sectionLabel("FLOW")+C.Faint("waiting for turn events"), width))
		} else if flowLines := RenderFlow(*flow, inner-flowSectionRoom, model.Now); len(flowLines) > 0 {
			lines = append(lines, BoxRow(sectionLabel("FLOW")+flowLines[0], width))
			if len(flowLines) > 1 {
				lines = append(lines, BoxRow(sectionLabel("TOOLS")+flowLines[1], width))
			}
		}
	}

	// TOOLS: recent tool runs as compact cards, indented under the strip.
	if options.showToolCards && flow != nil && len(flow.ToolRuns) > 0 {
		start := 0
		if len(flow.ToolRuns) > toolCardRows {
			start = len(flow.ToolRuns) - toolCardRows
		}
		for _, run := range flow.ToolRuns[start:] {
			lines = append(lines, BoxRow("  "+dashboardToolRunHeader(run, model, inner-2), width))
			if run.ArgsText != "" {
				lines = append(lines, BoxRow("  "+dashboardToolDetail("args", run.ArgsText, inner-2), width))
			}
			if run.Preview != "" {
				lines = append(lines, BoxRow("  "+dashboardToolDetail("out", run.Preview, inner-2), width))
			}
		}
	}

	// PLAN: one header row (counts + progress bar), then the indented task list.
	var steps []types.PlanStep
	if model.Plan != nil {
		steps = model.Plan.Steps
	}
	if len(steps) > 0 {
		done, total := plan.Counts(model.Plan)
		chips := []Chip{
			chip(fmt.Sprintf("%d/%d", done, total),
				C.OK(fmt.Sprintf("%d", done))+C.Faint("/")+C.Text(fmt.Sprintf("%d", total))),
		}
		if progress, ok := ProgressChip(done, total, barCells); ok {
			chips = append(chips, progress)
		}
		lines = append(lines, BoxRow(sectionLabel("PLAN")+joinChips(chips, "  "), width))
		if options.note && model.Plan.Note != "" {
			lines = append(lines, BoxRow(C.Faint(Truncate(model.Plan.Note, inner)), width))
		}
		rows := PlanRows(steps, PlanRowOptions{
			CollapseAfter: options.collapseAfter, Frame: model.Frame, Now: model.Now, Live: true,
		})
		for _, row := range rows {
			lines = append(lines, BoxRow("  "+PaintPlanRow(row, inner-2), width))
		}
	} else if options.note && model.Plan != nil && model.Plan.Note != "" {
		lines = append(lines, BoxRow(C.Faint(Truncate(model.Plan.Note, inner)), width))
	}

	// THINK: the label rides the first wrapped line so the section costs no
	// extra rows; continuation lines align under it.
	thinkLabel := DisplayWidth("THINK") + sectionGap
	thinking := thinkingRows(model, inner, options.thinkWindow, thinkLabel)
	if len(thinking) > 0 {
		lines = append(lines, BoxRow(sectionLabel("THINK")+thinking[0], width))
		for _, tail := range thinking[1:] {
			lines = append(lines, BoxRow(strings.Repeat(" ", thinkLabel)+tail, width))
		}
	}

	// TELE: one compact row of counters, last so the box closes on data.
	if options.showTele {
		if tele := telemetryLine(model, inner); tele != nil {
			lines = append(lines, BoxRow(sectionLabel("TELE")+tele.Painted, width))
		}
	}

	return append(lines, BoxBottom(width))
}

func joinChips(chips []Chip, gap string) string {
	var painteds []string
	for _, item := range chips {
		painteds = append(painteds, item.Painted)
	}
	return strings.Join(painteds, gap)
}

// dashboardToolRunHeader renders one tool run card header (glyph, name, time).
func dashboardToolRunHeader(run ToolRunSnapshot, model HudModel, inner int) string {
	glyphPlain, glyphPaint, paint := dashboardToolGlyph(run, model.Frame)
	duration := dashboardToolDuration(run, model.Now)
	suffixWidth := 0
	if duration != "" {
		suffixWidth = 1 + DisplayWidth(duration)
	}
	room := inner - DisplayWidth(glyphPlain) - 1 - suffixWidth
	if room < 1 {
		return C.Faint(Truncate(glyphPlain+" "+run.Name, inner))
	}
	name := Truncate(run.Name, room)
	line := glyphPaint + " " + paint(name)
	if duration != "" {
		line += " " + C.Faint(duration)
	}
	return line
}

func dashboardToolGlyph(run ToolRunSnapshot, frame string) (string, string, Painter) {
	switch run.Status {
	case ToolRunDone:
		return doneGlyph, C.OK(doneGlyph), C.Text
	case ToolRunFailed:
		return "✗", C.Err("✗"), C.Err
	default:
		if frame == "" {
			frame = spinGlyph
		}
		return frame, C.Accent(frame), C.Accent
	}
}

func dashboardToolDuration(run ToolRunSnapshot, now int64) string {
	if run.Status == ToolRunRunning {
		if run.StartedAt == 0 || now <= run.StartedAt {
			return "running"
		}
		return FormatDuration(now - run.StartedAt)
	}
	if run.Ms != 0 {
		return FormatDuration(run.Ms)
	}
	if run.FinishedAt > run.StartedAt && run.StartedAt != 0 {
		return FormatDuration(run.FinishedAt - run.StartedAt)
	}
	return ""
}

func dashboardToolDetail(label, value string, inner int) string {
	text := label + ": " + value
	room := inner - 2
	if room < 1 {
		return C.Faint(Truncate(text, inner))
	}
	return C.Faint("  " + Truncate(text, room))
}
