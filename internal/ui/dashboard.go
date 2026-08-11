package ui

// A Herdr-inspired live dashboard: the same turn state as the HUD, split into
// small panes so the operator can scan status, flow, tools, plan, and reasoning
// independently. It deliberately stays inside the existing redraw contract:
// every line is bounded, and tight terminals fall back to the compact HUD.

import (
	"fmt"
	"strings"
)

const (
	dashboardMinWidth = 72
	dashboardMinRows  = 14
	dashboardGap      = " "
)

type dashboardPanel struct {
	Title string
	Width int
	Rows  int
	Body  []string
}

func RenderDashboard(flow *FlowState, model HudModel) []string {
	width := model.Width
	if width < 1 {
		width = 1
	}
	maxRows := model.MaxRows
	if maxRows <= 0 {
		return RenderHud(model)
	}
	if width < dashboardMinWidth || maxRows < dashboardMinRows {
		return RenderHud(model)
	}

	statusBody := dashboardStatusRows(model, BoxInner(width))
	statusRows := 4
	if len(statusBody) > 2 && maxRows >= dashboardMinRows+1 {
		statusRows = 5
	}
	status := renderDashboardPanel(dashboardPanel{
		Title: "STATUS", Width: width, Rows: statusRows, Body: statusBody,
	})
	remaining := maxRows - len(status)
	if remaining < 8 {
		return RenderHud(model)
	}

	topRows := remaining / 2
	if topRows < 4 {
		topRows = 4
	}
	bottomRows := remaining - topRows
	if bottomRows < 4 {
		return RenderHud(model)
	}

	flowW, toolW, ok := splitDashboardWidths(width, 44, 24, 62)
	if !ok {
		return RenderHud(model)
	}
	planW, thinkW, ok := splitDashboardWidths(width, 40, 28, 58)
	if !ok {
		return RenderHud(model)
	}

	flowPane := renderDashboardPanel(dashboardPanel{
		Title: "FLOW", Width: flowW, Rows: topRows,
		Body: dashboardFlowRows(flow, BoxInner(flowW), model.Now),
	})
	toolsPane := renderDashboardPanel(dashboardPanel{
		Title: "TOOLS", Width: toolW, Rows: topRows,
		Body: dashboardToolRows(flow, model.Now, BoxInner(toolW)),
	})
	planPane := renderDashboardPanel(dashboardPanel{
		Title: "PLAN", Width: planW, Rows: bottomRows,
		Body: dashboardPlanRows(model, BoxInner(planW), bottomRows-2),
	})
	thinkPane := renderDashboardPanel(dashboardPanel{
		Title: "THINK", Width: thinkW, Rows: bottomRows,
		Body: dashboardThinkRows(model, BoxInner(thinkW), bottomRows-2),
	})

	out := append([]string{}, status...)
	out = append(out, joinDashboardPanels(flowPane, toolsPane)...)
	out = append(out, joinDashboardPanels(planPane, thinkPane)...)
	if len(out) > maxRows {
		return RenderHud(model)
	}
	for _, line := range out {
		if DisplayWidth(line) > width {
			return RenderHud(model)
		}
	}
	return out
}

func splitDashboardWidths(total, leftMin, rightMin, leftPercent int) (int, int, bool) {
	if total < leftMin+rightMin+DisplayWidth(dashboardGap) {
		return 0, 0, false
	}
	usable := total - DisplayWidth(dashboardGap)
	left := usable * leftPercent / 100
	if left < leftMin {
		left = leftMin
	}
	right := usable - left
	if right < rightMin {
		right = rightMin
		left = usable - right
	}
	if left < leftMin || right < rightMin {
		return 0, 0, false
	}
	return left, right, true
}

func renderDashboardPanel(panel dashboardPanel) []string {
	if panel.Rows < 3 {
		panel.Rows = 3
	}
	head := []Chip{chip(panel.Title, C.Bold(C.Accent(panel.Title)))}
	lines := []string{BoxTop(panel.Width, head)}
	bodyRows := panel.Rows - 2
	for index := 0; index < bodyRows; index++ {
		line := ""
		if index < len(panel.Body) {
			line = panel.Body[index]
		}
		lines = append(lines, BoxRow(line, panel.Width))
	}
	return append(lines, BoxBottom(panel.Width))
}

func joinDashboardPanels(left, right []string) []string {
	height := len(left)
	if len(right) > height {
		height = len(right)
	}
	out := make([]string, 0, height)
	for index := 0; index < height; index++ {
		l := ""
		if index < len(left) {
			l = left[index]
		}
		r := ""
		if index < len(right) {
			r = right[index]
		}
		out = append(out, l+dashboardGap+r)
	}
	return out
}

func dashboardStatusRows(model HudModel, inner int) []string {
	rows := []string{statusRow(model, inner), compactStatusRow(model, inner)}
	if row := queueRow(model, inner); row != "" {
		rows = append(rows, row)
	}
	return rows
}

func dashboardFlowRows(flow *FlowState, inner int, now int64) []string {
	if flow == nil {
		return []string{C.Faint("waiting for turn events")}
	}
	lines := RenderFlow(*flow, inner, now)
	if len(lines) == 0 {
		return []string{
			dashboardKV("stage", string(flow.Stage), C.Violet, inner),
			dashboardKV("provider", firstNonEmpty(flow.Provider, flow.Model), C.Text, inner),
		}
	}
	return lines
}

func dashboardToolRows(flow *FlowState, now int64, inner int) []string {
	if flow == nil {
		return []string{C.Faint("no tool activity yet")}
	}
	rows := []string{
		dashboardKV("stage", string(flow.Stage), C.Violet, inner),
	}
	if model := flowModelLabel(flow); model != "" {
		rows = append(rows, dashboardKV("agent", model, C.Text, inner))
	}
	if flow.ActiveTool != "" {
		rows = append(rows, dashboardKV("tool", flow.ActiveTool, C.Accent, inner))
	}
	if flow.PendingCalls > 0 || flow.ToolsOK > 0 || flow.ToolsFailed > 0 {
		value := fmt.Sprintf("pending %d  ok %d  fail %d", flow.PendingCalls, flow.ToolsOK, flow.ToolsFailed)
		rows = append(rows, dashboardKV("calls", value, C.Text, inner))
	}
	if flow.ToolStartedAt != 0 && now > flow.ToolStartedAt {
		rows = append(rows, dashboardKV("tool time", FormatDuration(now-flow.ToolStartedAt), C.OK, inner))
	} else if flow.ToolMs != 0 {
		rows = append(rows, dashboardKV("last tool", FormatDuration(flow.ToolMs), C.OK, inner))
	}
	if flow.ReplyChars > 0 {
		rows = append(rows, dashboardKV("reply", fmt.Sprintf("%d chars", flow.ReplyChars), C.Text, inner))
	}
	if flow.HasCompacted {
		value := fmt.Sprintf("%d dropped  %d elided", flow.CompactedDrop, flow.CompactedElide)
		rows = append(rows, dashboardKV("ctx", value, C.Warn, inner))
	}
	if flow.Error != "" {
		rows = append(rows, dashboardKV("error", flow.Error, C.Err, inner))
	}
	return rows
}

func dashboardPlanRows(model HudModel, inner, bodyRows int) []string {
	if bodyRows <= 0 {
		return nil
	}
	if model.Plan == nil || len(model.Plan.Steps) == 0 {
		return []string{C.Faint("waiting for plan updates")}
	}
	rows := make([]string, 0, bodyRows)
	if model.Plan.Note != "" && bodyRows > 2 && model.PlanDisplay != PlanDisplayCollapsed {
		rows = append(rows, C.Faint(Truncate(model.Plan.Note, inner)))
	}
	collapseAfter := bodyRows - len(rows)
	if collapseAfter < 1 {
		collapseAfter = 1
	}
	switch model.PlanDisplay {
	case PlanDisplayCollapsed:
		collapseAfter = 1
	case PlanDisplayExpanded:
		collapseAfter = len(model.Plan.Steps)
	}
	planRows := PlanRows(model.Plan.Steps, PlanRowOptions{
		CollapseAfter: collapseAfter,
		Frame:         model.Frame,
		Now:           model.Now,
		Live:          true,
	})
	for _, row := range planRows {
		if len(rows) >= bodyRows {
			break
		}
		rows = append(rows, PaintPlanRow(row, inner))
	}
	return rows
}

func dashboardThinkRows(model HudModel, inner, bodyRows int) []string {
	if bodyRows <= 0 {
		return nil
	}
	if model.ThinkDisplay == ThinkDisplayCollapsed {
		return []string{C.Faint("folded · /think expand")}
	}
	window := defaultThinkWindow
	if model.ThinkingWindow > 0 {
		window = model.ThinkingWindow
	}
	if model.ThinkDisplay == ThinkDisplayExpanded {
		window = bodyRows
	}
	if window > bodyRows {
		window = bodyRows
	}
	rows := thinkingRows(model, inner, window)
	if len(rows) == 0 {
		return []string{C.Faint("waiting for reasoning stream")}
	}
	return rows
}

func dashboardKV(key, value string, paint Painter, inner int) string {
	keyText := key + ":"
	room := inner - DisplayWidth(keyText) - 1
	if room < 1 {
		return C.Faint(Truncate(keyText, inner))
	}
	value = Truncate(value, room)
	return C.Faint(keyText) + " " + paint(value)
}

func flowModelLabel(flow *FlowState) string {
	if flow == nil {
		return ""
	}
	parts := []string{}
	if flow.Provider != "" {
		parts = append(parts, flow.Provider)
	}
	if flow.Model != "" && flow.Model != flow.Provider {
		parts = append(parts, flow.Model)
	}
	return strings.Join(parts, " · ")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
