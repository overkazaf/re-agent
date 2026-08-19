package ui

// The HUD: the compact boxed dashboard used as the fallback when the terminal
// is too narrow or too short for the sectioned dashboard (dashboard.go), and by
// archived snapshots. It carries routing, progress, the task list, streamed
// reasoning, and telemetry in one box.
//
// Everything here is pure composition: a HudModel in, []string out, with no
// timers, no cursor moves, and no I/O. The caller (live.go) owns the redraw, so
// the only hard contract this file has to honour is that *every* returned line
// renders in exactly `width` columns or fewer, measured with DisplayWidth. A
// single soft-wrapped line permanently desynchronises the caller's erase walk,
// which is why width math here is done on plain text and painted afterwards.

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/overkazaf/re-agent/internal/plan"
	"github.com/overkazaf/re-agent/internal/types"
)

// Chip is text plus its painted form. Width math always runs on Plain.
type Chip struct {
	Plain   string
	Painted string
}

func chip(plain string, painted ...string) Chip {
	if len(painted) > 0 {
		return Chip{Plain: plain, Painted: painted[0]}
	}
	return Chip{Plain: plain, Painted: plain}
}

const (
	boxTL = "╭"
	boxTR = "╮"
	boxBL = "╰"
	boxBR = "╯"
	boxH  = "─"
	boxV  = "│"
)

const (
	sparkGlyphs  = "▁▂▃▄▅▆▇█"
	barOn        = "▰"
	barOff       = "▱"
	doneGlyph    = "✔"
	pendingGlyph = "○"
	spinGlyph    = "⠿"
	moreGlyph    = "…"
	thinkGlyph   = "┊"
	clockGlyph   = "◷"
	activeGlyph  = "▸"
	arrowGlyph   = "→"
)

// HudTitle deliberately avoids characters with Emoji_Presentation=Yes (⏱ ⏺ and
// friends): terminals render those double-width while this codebase's width
// table calls them narrow, which breaks the box by one column per glyph.
const HudTitle = "0xAF·RE"

const (
	// NarrowColumns is where the two-column layout stops being readable.
	NarrowColumns = 60
	// HudMaxWidth: past this the box stops being a dashboard and becomes a wall.
	HudMaxWidth = 120
	// MinBoxWidth: narrower than this and the box costs more columns than it
	// organises, so the HUD drops to a single unboxed status line. Never clamp
	// *up* to reach it: a box wider than the terminal soft-wraps.
	MinBoxWidth = 20

	rightMin           = 18
	rightMax           = 32
	leftMin            = 14
	sparkMax           = 16
	barCells           = 8
	defaultCollapse    = 8
	defaultThinkWindow = 3
	// expandedThinkWindow is what `/think expand` asks for. It is a ceiling, not
	// a promise: the height budget still sheds it down to whatever fits.
	expandedThinkWindow = 24
	// telemetryFloor: `◷ elapsed` and `▸ phase` are never shed.
	telemetryFloor = 2
)

type HudStats = types.TokenUsage

// HudRoute is the planner → executor chain, with the side currently answering
// marked.
type HudRoute struct {
	Planner  string
	Executor string
	// Active names the provider currently answering; empty highlights neither.
	Active string
}

type PlanDisplayMode string

const (
	PlanDisplayAuto      PlanDisplayMode = "auto"
	PlanDisplayCollapsed PlanDisplayMode = "collapsed"
	PlanDisplayExpanded  PlanDisplayMode = "expanded"
)

// ThinkDisplayMode controls how much of the streamed reasoning tail the HUD
// shows. Collapsed hides the text but not the `think` token counter, so a
// folded HUD still says that reasoning is happening — only the words go away.
type ThinkDisplayMode string

const (
	ThinkDisplayAuto      ThinkDisplayMode = "auto"
	ThinkDisplayCollapsed ThinkDisplayMode = "collapsed"
	ThinkDisplayExpanded  ThinkDisplayMode = "expanded"
)

type HudModel struct {
	// Label is the route label used when no dual-model Route is supplied.
	Label string
	Phase string
	// Frame is the spinner glyph; empty renders a static one (archived snapshots).
	Frame     string
	ElapsedMs int64
	// Now is the clock reading for this frame, so live step timings tick coherently.
	Now   int64
	Width int
	Stats HudStats
	// Spark holds output-token deltas sampled on a fixed cadence, oldest first.
	Spark []float64
	Route *HudRoute
	Plan  *types.PlanSnapshot
	// PlanDisplay lets the operator explicitly fold or expand the task list
	// while a turn is running. The height budget still wins.
	PlanDisplay PlanDisplayMode
	QueueCount  int
	QueueDraft  string
	// Thinking is raw streamed reasoning; the HUD wraps and tails it.
	Thinking       string
	ThinkingWindow int
	// ThinkDisplay lets the operator fold the reasoning away or open it up mid
	// turn. Expanding also moves the tail to the back of the shed order below,
	// since content you asked for should not be the first thing dropped.
	ThinkDisplay ThinkDisplayMode
	// MaxRows is a hard ceiling on returned lines. The HUD sheds content for it.
	MaxRows int
}

// --- box primitives ----------------------------------------------------------

// BoxInner is the columns available between the `│ ` and ` │` of a content row.
func BoxInner(width int) int {
	inner := width - 4
	if inner < 1 {
		return 1
	}
	return inner
}

// BoxRow renders a content row. `content` must already measure at most
// BoxInner(width); anything longer is clipped as a last-resort safety valve,
// which costs its colour but keeps the caller's erase walk in sync.
func BoxRow(content string, width int) string {
	inner := BoxInner(width)
	body := content
	if DisplayWidth(body) > inner {
		body = Truncate(body, inner)
	}
	return C.Rule(boxV) + " " + PadEnd(body, inner) + " " + C.Rule(boxV)
}

// BoxTop renders `╭─ chip chip ──────╮`, dropping trailing head chips that do
// not fit.
func BoxTop(width int, head []Chip) string {
	var used []Chip
	for _, item := range head {
		if item.Plain != "" {
			used = append(used, item)
		}
	}
	for len(used) > 1 && 5+joinedWidth(used) > width {
		used = used[:len(used)-1]
	}
	var plains, painteds []string
	for _, item := range used {
		plains = append(plains, item.Plain)
		painteds = append(painteds, item.Painted)
	}
	plain := strings.Join(plains, " ")
	painted := strings.Join(painteds, " ")
	if 5+DisplayWidth(plain) > width {
		room := width - 5
		if room < 0 {
			room = 0
		}
		plain = Truncate(plain, room)
		painted = C.Faint(plain)
	}
	lead := C.Rule(boxTL + boxH)
	if plain == "" {
		fill := width - 3
		if fill < 0 {
			fill = 0
		}
		return lead + C.Rule(strings.Repeat(boxH, fill)+boxTR)
	}
	fill := width - 5 - DisplayWidth(plain)
	if fill < 0 {
		fill = 0
	}
	return lead + " " + painted + " " + C.Rule(strings.Repeat(boxH, fill)+boxTR)
}

func BoxBottom(width int) string {
	fill := width - 2
	if fill < 0 {
		fill = 0
	}
	return C.Rule(boxBL + strings.Repeat(boxH, fill) + boxBR)
}

func joinedWidth(chips []Chip) int {
	var plains []string
	for _, item := range chips {
		plains = append(plains, item.Plain)
	}
	return DisplayWidth(strings.Join(plains, " "))
}

// --- plan rows ---------------------------------------------------------------

// PlanRow is one task-list line, before it is fitted to a column.
type PlanRow struct {
	Glyph      string
	GlyphPaint Painter
	Text       string
	Paint      Painter
	// Timing is an elapsed label, right-aligned inside the row when there is room.
	Timing string
}

type PlanRowOptions struct {
	CollapseAfter int
	// Frame is the spinner glyph for the in-progress row.
	Frame string
	// Now is the clock reading used for the live elapsed on the in-progress step.
	Now int64
	// NoTimings drops every elapsed label.
	NoTimings bool
	// Live decides whether the in-progress step shows a running elapsed. Off for
	// archived output, where a duration measured against "whenever this was
	// printed" says more about the reader's clock than about the run.
	Live bool
}

// PlanRows bounds the step list to at most CollapseAfter rows. The finished head
// folds into one `✔ N done` counter, since what matters live is the current step
// and what is still ahead; anything still over budget is clipped from the tail
// with a `… N more` marker.
func PlanRows(steps []types.PlanStep, options PlanRowOptions) []PlanRow {
	collapseAfter := options.CollapseAfter
	if collapseAfter < 1 {
		collapseAfter = defaultCollapse
	}
	frame := options.Frame
	if frame == "" {
		frame = spinGlyph
	}
	now := options.Now
	if now == 0 {
		now = types.NowMs()
	}
	timings := !options.NoTimings
	liveNow := int64(0)
	if options.Live {
		liveNow = now
	}
	row := func(step types.PlanStep) PlanRow { return stepRow(step, frame, liveNow, timings) }

	rows := make([]PlanRow, 0, len(steps))
	for _, step := range steps {
		rows = append(rows, row(step))
	}
	if len(steps) <= collapseAfter {
		return rows
	}

	active := -1
	for index, step := range steps {
		if step.Status != types.StepCompleted {
			active = index
			break
		}
	}
	folded := false
	if active < 0 {
		// Everything is done: the list has nothing left to say but the count.
		rows = []PlanRow{summaryRow(doneGlyph, fmt.Sprintf("%d done", len(steps)), C.OK, spanOf(steps, timings))}
		folded = true
	} else if active > 1 {
		// Folding a single completed row into a counter would save no space.
		rows = []PlanRow{summaryRow(doneGlyph, fmt.Sprintf("%d done", active), C.OK, spanOf(steps[:active], timings))}
		for _, step := range steps[active:] {
			rows = append(rows, row(step))
		}
		folded = true
	}
	if len(rows) <= collapseAfter {
		return rows
	}

	// One row is reserved for the `… N more` marker. When that leaves room for a
	// single row only, the step being worked on beats the finished-count header.
	keep := collapseAfter - 1
	if keep < 1 {
		keep = 1
	}
	start := 0
	if folded && keep < 2 {
		start = 1
	}
	end := start + keep
	if end > len(rows) {
		end = len(rows)
	}
	shown := append([]PlanRow{}, rows[start:end]...)
	remaining := len(rows) - start - keep
	if remaining < 0 {
		remaining = 0
	}
	return append(shown, summaryRow(moreGlyph, fmt.Sprintf("%d more", remaining), C.Faint, ""))
}

func stepRow(step types.PlanStep, frame string, now int64, timings bool) PlanRow {
	switch step.Status {
	case types.StepCompleted:
		row := PlanRow{Glyph: doneGlyph, GlyphPaint: C.OK, Text: step.Text, Paint: C.Faint}
		if timings {
			row.Timing = elapsedLabel(step.StartedAt, step.CompletedAt)
		}
		return row
	case types.StepInProgress:
		row := PlanRow{
			Glyph: frame, GlyphPaint: C.Accent, Text: step.Text,
			Paint: func(value string) string { return C.Bold(C.Text(value)) },
		}
		if timings {
			row.Timing = elapsedLabel(step.StartedAt, now)
		}
		return row
	}
	return PlanRow{Glyph: pendingGlyph, GlyphPaint: C.Faint, Text: step.Text, Paint: C.Faint}
}

func summaryRow(glyph, text string, glyphPaint Painter, timing string) PlanRow {
	return PlanRow{Glyph: glyph, GlyphPaint: glyphPaint, Text: text, Paint: C.Faint, Timing: timing}
}

func elapsedLabel(from, to int64) string {
	if from == 0 || to == 0 {
		return ""
	}
	ms := to - from
	// A step that was created and completed by the same update never actually
	// ran; reporting "0ms" implies a measurement that was never taken.
	if ms <= 0 {
		return ""
	}
	return FormatDuration(ms)
}

// spanOf is the wall time a folded run of completed steps took, first start to
// last finish.
func spanOf(steps []types.PlanStep, timings bool) string {
	if !timings {
		return ""
	}
	var starts, ends []int64
	for _, step := range steps {
		if step.StartedAt != 0 {
			starts = append(starts, step.StartedAt)
		}
		if step.CompletedAt != 0 {
			ends = append(ends, step.CompletedAt)
		}
	}
	if len(starts) == 0 || len(ends) == 0 {
		return ""
	}
	sort.Slice(starts, func(a, b int) bool { return starts[a] < starts[b] })
	sort.Slice(ends, func(a, b int) bool { return ends[a] < ends[b] })
	return elapsedLabel(starts[0], ends[len(ends)-1])
}

// PaintPlanRow fits a row to exactly `width` columns: glyph, text, then the
// elapsed label pushed to the right edge. The timing is dropped rather than
// allowed to crowd the text out — a step you cannot read is worse than one you
// cannot time.
func PaintPlanRow(row PlanRow, width int) string {
	glyphWidth := DisplayWidth(row.Glyph)
	available := width - glyphWidth - 1
	if available <= 0 {
		return row.GlyphPaint(row.Glyph)
	}
	timing := row.Timing
	textMax := available
	if timing != "" {
		need := DisplayWidth(timing) + 1
		if available-need >= 4 {
			textMax = available - need
		} else {
			timing = ""
		}
	}
	text := Truncate(row.Text, textMax)
	gap := available - DisplayWidth(text)
	if timing != "" {
		gap -= DisplayWidth(timing)
	}
	tail := ""
	if timing != "" {
		pad := gap
		if pad < 1 {
			pad = 1
		}
		tail = strings.Repeat(" ", pad) + C.Faint(timing)
	} else if gap > 0 {
		tail = strings.Repeat(" ", gap)
	}
	return row.GlyphPaint(row.Glyph) + " " + row.Paint(text) + tail
}

// --- meters ------------------------------------------------------------------

// Sparkline renders output-token throughput as block glyphs, normalised to the
// window maximum. It renders nothing below two samples or while nothing is
// flowing: a flat row of `▁` would read as measured-and-idle rather than
// not-yet-measured.
func Sparkline(samples []float64, cells int) string {
	if cells < 2 || len(samples) < 2 {
		return ""
	}
	window := samples
	if len(window) > cells {
		window = window[len(window)-cells:]
	}
	max := 0.0
	for _, value := range window {
		if value > max {
			max = value
		}
	}
	if max <= 0 {
		return ""
	}
	glyphs := []rune(sparkGlyphs)
	var out strings.Builder
	for _, value := range window {
		if value < 0 {
			value = 0
		}
		level := int(math.Round(value / max * float64(len(glyphs)-1)))
		if level < 0 {
			level = 0
		}
		if level > len(glyphs)-1 {
			level = len(glyphs) - 1
		}
		out.WriteRune(glyphs[level])
	}
	return out.String()
}

func ProgressChip(done, total, cells int) (Chip, bool) {
	if total <= 0 || cells < 3 {
		return Chip{}, false
	}
	ratio := float64(done) / float64(total)
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	filled := int(math.Round(ratio * float64(cells)))
	if filled > cells {
		filled = cells
	}
	percent := fmt.Sprintf("%d%%", int(math.Round(ratio*100)))
	bar := strings.Repeat(barOn, filled) + strings.Repeat(barOff, cells-filled)
	painted := C.Accent(strings.Repeat(barOn, filled)) + C.Rule(strings.Repeat(barOff, cells-filled))
	return chip(bar+" "+percent, painted+" "+C.Faint(percent)), true
}

// RouteChip renders `planner → executor`, with the answering side lit and the
// other dimmed.
func RouteChip(model HudModel) Chip {
	route := model.Route
	if route == nil {
		return chip(model.Label, C.Bold(C.Accent(model.Label)))
	}
	// A pinned provider (`/agent deepseek`) answers alone: showing the
	// planner → executor chain would name two models that are not being used.
	if route.Active != "" && route.Active != route.Planner && route.Active != route.Executor {
		return chip(route.Active, C.Bold(C.Violet(route.Active)))
	}
	if route.Planner == route.Executor {
		return chip(route.Planner, C.Bold(C.Accent(route.Planner)))
	}
	paint := func(name string, tone Painter) string {
		if route.Active == "" {
			return C.Text(name)
		}
		if route.Active == name {
			return C.Bold(tone(name))
		}
		return C.Faint(name)
	}
	return chip(
		route.Planner+" "+arrowGlyph+" "+route.Executor,
		paint(route.Planner, C.Accent)+" "+C.Rule(arrowGlyph)+" "+paint(route.Executor, C.Violet),
	)
}

func costChip(costUsd float64) (Chip, bool) {
	if costUsd == 0 {
		return Chip{}, false
	}
	value := fmt.Sprintf("%.4f", costUsd)
	if costUsd >= 0.01 {
		value = fmt.Sprintf("%.2f", costUsd)
	}
	return chip("$"+value, C.Faint("$")+C.Warn(value)), true
}

// --- telemetry ---------------------------------------------------------------

type telemetryCell struct {
	chip Chip
	// priority: lower survives shedding longer.
	priority int
}

// telemetryCells builds the right-hand column. Ordered for reading (throughput,
// counters, clock, activity) but shed by priority, so a short terminal loses
// token counters before it loses what the agent is doing right now.
func telemetryCells(model HudModel, width, limit int) []Chip {
	var cells []telemetryCell
	stats := model.Stats

	if stats.Output != 0 {
		value := CompactNumber(stats.Output)
		room := width - DisplayWidth("out  "+value)
		if room > sparkMax {
			room = sparkMax
		}
		spark := Sparkline(model.Spark, room)
		if spark != "" {
			cells = append(cells, telemetryCell{chip: chip("out "+spark+" "+value,
				C.Faint("out")+" "+C.Accent(spark)+" "+C.Text(value)), priority: 2})
		} else {
			cells = append(cells, telemetryCell{chip: chip("out "+value,
				C.Faint("out")+" "+C.Text(value)), priority: 2})
		}
	}

	for _, line := range PackChips(counterChips(stats), width, "  ") {
		cells = append(cells, telemetryCell{chip: line, priority: 3})
	}

	elapsed := FormatDuration(model.ElapsedMs)
	cells = append(cells, telemetryCell{
		chip: chip(clockGlyph+" "+elapsed, C.Faint(clockGlyph)+" "+C.OK(elapsed)), priority: 0,
	})

	phaseRoom := width - 2
	if phaseRoom < 1 {
		phaseRoom = 1
	}
	phase := Truncate(model.Phase, phaseRoom)
	cells = append(cells, telemetryCell{
		chip: chip(activeGlyph+" "+phase, C.VioletDim(activeGlyph)+" "+C.Violet(phase)), priority: 1,
	})

	if len(cells) <= limit {
		out := make([]Chip, 0, len(cells))
		for _, cell := range cells {
			out = append(out, cell.chip)
		}
		return out
	}
	// Drop the least important cells while keeping the reading order intact.
	type indexed struct {
		cell  telemetryCell
		index int
	}
	ranked := make([]indexed, 0, len(cells))
	for index, cell := range cells {
		ranked = append(ranked, indexed{cell, index})
	}
	sort.SliceStable(ranked, func(a, b int) bool {
		if ranked[a].cell.priority != ranked[b].cell.priority {
			return ranked[a].cell.priority > ranked[b].cell.priority
		}
		return ranked[a].index > ranked[b].index
	})
	doomed := map[int]bool{}
	for _, entry := range ranked[:len(cells)-limit] {
		doomed[entry.index] = true
	}
	var out []Chip
	for index, cell := range cells {
		if !doomed[index] {
			out = append(out, cell.chip)
		}
	}
	return out
}

func counterChips(stats HudStats) []Chip {
	var out []Chip
	add := func(label string, value float64, tone Painter) {
		if value == 0 {
			return
		}
		text := CompactNumber(value)
		out = append(out, chip(label+" "+text, C.Faint(label)+" "+tone(text)))
	}
	add("think", stats.Thinking, C.Violet)
	add("in", stats.Input, C.Text)
	add("cache", stats.CacheRead, C.OK)
	return out
}

// PackChips greedily packs chips onto lines of at most `width` columns.
func PackChips(chips []Chip, width int, gap string) []Chip {
	var lines []Chip
	var current *Chip
	for index := range chips {
		item := chips[index]
		if current == nil {
			clone := item
			current = &clone
			continue
		}
		plain := current.Plain + gap + item.Plain
		if DisplayWidth(plain) <= width {
			merged := chip(plain, current.Painted+gap+item.Painted)
			current = &merged
		} else {
			lines = append(lines, *current)
			clone := item
			current = &clone
		}
	}
	if current != nil {
		lines = append(lines, *current)
	}
	return lines
}

// --- layout ------------------------------------------------------------------

type frameLayout struct {
	layout     string // columns | stacked | compact
	leftWidth  int
	rightWidth int
}

func chooseLayout(width int, hasPlanRows bool) frameLayout {
	inner := BoxInner(width)
	if width < NarrowColumns {
		return frameLayout{"compact", inner, 0}
	}
	if !hasPlanRows {
		return frameLayout{"stacked", inner, inner}
	}
	for _, right := range []int{rightMax, 28, 24, rightMin} {
		left := inner - right - 3
		if left >= leftMin {
			if right > inner {
				right = inner
			}
			return frameLayout{"columns", left, right}
		}
	}
	return frameLayout{"compact", inner, 0}
}

// statusRow is row 1: routing on the left, progress and spend pushed right.
func statusRow(model HudModel, inner int) string {
	route := RouteChip(model)
	done, total := plan.Counts(model.Plan)
	var tail []Chip
	if progress, ok := ProgressChip(done, total, barCells); ok {
		tail = append(tail, progress)
	}
	if cost, ok := costChip(model.Stats.CostUsd); ok {
		tail = append(tail, cost)
	}
	for len(tail) > 0 {
		var plains, painteds []string
		for _, item := range tail {
			plains = append(plains, item.Plain)
			painteds = append(painteds, item.Painted)
		}
		plain := strings.Join(plains, "  ")
		if DisplayWidth(route.Plain)+2+DisplayWidth(plain) <= inner {
			gap := inner - DisplayWidth(route.Plain) - DisplayWidth(plain)
			return route.Painted + strings.Repeat(" ", gap) + strings.Join(painteds, "  ")
		}
		tail = tail[:len(tail)-1]
	}
	if DisplayWidth(route.Plain) <= inner {
		return route.Painted
	}
	return C.Bold(C.Accent(Truncate(route.Plain, inner)))
}

func queueRow(model HudModel, inner int) string {
	if model.QueueCount <= 0 && strings.TrimSpace(model.QueueDraft) == "" {
		return ""
	}
	parts := []string{C.Faint("queue")}
	if model.QueueCount > 0 {
		parts = append(parts, C.Violet(fmt.Sprintf("%d pending", model.QueueCount)))
	} else {
		parts = append(parts, C.Violet("capturing"))
	}
	if draft := strings.TrimSpace(model.QueueDraft); draft != "" {
		room := inner - 16
		if room < 4 {
			room = 4
		}
		parts = append(parts, C.Rule("·"), C.Muted(Truncate(draft, room)))
	}
	joined := strings.Join(parts, " ")
	if DisplayWidth(joined) <= inner {
		return joined
	}
	return C.Faint(Truncate(StripAnsi(joined), inner))
}

// compactStatusRow is the narrow fallback: the whole right column on one line,
// in the same order. The clock is laid down first and the phase label is sized
// from what is left, so a long tool invocation cannot crowd out the elapsed
// time — a runaway step is exactly when you most want to see it.
func compactStatusRow(model HudModel, inner int) string {
	elapsed := FormatDuration(model.ElapsedMs)
	chips := []Chip{chip(clockGlyph+" "+elapsed, C.Faint(clockGlyph)+" "+C.OK(elapsed))}
	room := inner - DisplayWidth(chips[0].Plain) - 4
	if room >= 4 {
		phase := Truncate(model.Phase, room)
		chips = append(chips, chip(activeGlyph+" "+phase, C.VioletDim(activeGlyph)+" "+C.Violet(phase)))
	}
	if model.Stats.Output != 0 {
		value := CompactNumber(model.Stats.Output)
		chips = append(chips, chip("out "+value, C.Faint("out")+" "+C.Text(value)))
	}
	chips = append(chips, counterChips(model.Stats)...)
	packed := PackChips(chips, inner, "  ")
	if len(packed) == 0 {
		return ""
	}
	return packed[0].Painted
}

func thinkingRows(model HudModel, inner, window, prefix int) []string {
	if window <= 0 {
		return nil
	}
	raw := strings.TrimSpace(spaceCollapseRE.ReplaceAllString(model.Thinking, " "))
	if raw == "" {
		return nil
	}
	textWidth := inner - 2 - prefix
	if textWidth < 4 {
		textWidth = 4
	}
	var wrapped []string
	for _, line := range WrapAnsi(raw, textWidth, "") {
		if strings.TrimSpace(line) != "" {
			wrapped = append(wrapped, line)
		}
	}
	if len(wrapped) > window {
		wrapped = wrapped[len(wrapped)-window:]
	}
	out := make([]string, 0, len(wrapped))
	for _, line := range wrapped {
		out = append(out, C.VioletDim(thinkGlyph)+" "+C.Faint(Truncate(line, textWidth)))
	}
	return out
}

// telemetryLine packs throughput, token counters, and the running clock into
// one TELE section row.
func telemetryLine(model HudModel, inner int) *Chip {
	var chips []Chip
	stats := model.Stats
	if stats.Output != 0 {
		value := CompactNumber(stats.Output)
		room := inner
		if room > sparkMax {
			room = sparkMax
		}
		spark := Sparkline(model.Spark, room)
		if spark != "" {
			chips = append(chips, chip("out "+spark+" "+value,
				C.Faint("out")+" "+C.Accent(spark)+" "+C.Text(value)))
		} else {
			chips = append(chips, chip("out "+value, C.Faint("out")+" "+C.Text(value)))
		}
	}
	chips = append(chips, counterChips(stats)...)
	elapsed := FormatDuration(model.ElapsedMs)
	chips = append(chips, chip(clockGlyph+" "+elapsed, C.Faint(clockGlyph)+" "+C.OK(elapsed)))
	limit := inner - DisplayWidth("TELE") - sectionGap
	if limit < 20 {
		limit = 20
	}
	packed := PackChips(chips, limit, " · ")
	if len(packed) == 0 {
		return nil
	}
	return &packed[0]
}

var spaceCollapseRE = mustCompile(`\s+`)

type buildOptions struct {
	thinkWindow    int
	collapseAfter  int
	telemetryLimit int
	note           bool
}

func build(model HudModel, width int, options buildOptions) []string {
	inner := BoxInner(width)
	var steps []types.PlanStep
	if model.Plan != nil {
		steps = model.Plan.Steps
	}
	var rows []PlanRow
	if len(steps) > 0 {
		rows = PlanRows(steps, PlanRowOptions{
			CollapseAfter: options.collapseAfter, Frame: model.Frame, Now: model.Now, Live: true,
		})
	}
	layout := chooseLayout(width, len(rows) > 0)

	var head []Chip
	if model.Frame != "" {
		head = append(head, chip(model.Frame, C.Accent(model.Frame)))
	}
	head = append(head, chip(HudTitle, C.Bold(C.Accent(HudTitle))))

	lines := []string{BoxTop(width, head), BoxRow(statusRow(model, inner), width)}
	if row := queueRow(model, inner); row != "" {
		lines = append(lines, BoxRow(row, width))
	}

	if options.note && model.Plan != nil && model.Plan.Note != "" {
		lines = append(lines, BoxRow(C.Faint(Truncate(model.Plan.Note, inner)), width))
	}

	switch layout.layout {
	case "columns":
		cells := telemetryCells(model, layout.rightWidth, options.telemetryLimit)
		height := len(rows)
		if len(cells) > height {
			height = len(cells)
		}
		for index := 0; index < height; index++ {
			left := strings.Repeat(" ", layout.leftWidth)
			if index < len(rows) {
				left = PaintPlanRow(rows[index], layout.leftWidth)
			}
			right := strings.Repeat(" ", layout.rightWidth)
			if index < len(cells) {
				right = PadEnd(cells[index].Painted, layout.rightWidth)
			}
			lines = append(lines, BoxRow(left+" "+C.Rule(boxV)+" "+right, width))
		}
	case "stacked":
		for _, row := range rows {
			lines = append(lines, BoxRow(PaintPlanRow(row, inner), width))
		}
		for _, cell := range telemetryCells(model, inner, options.telemetryLimit) {
			lines = append(lines, BoxRow(cell.Painted, width))
		}
	default:
		for _, row := range rows {
			lines = append(lines, BoxRow(PaintPlanRow(row, inner), width))
		}
		lines = append(lines, BoxRow(compactStatusRow(model, inner), width))
	}

	for _, line := range thinkingRows(model, inner, options.thinkWindow, 0) {
		lines = append(lines, BoxRow(line, width))
	}
	return append(lines, BoxBottom(width))
}

// RenderHud renders the HUD, shedding content until it fits MaxRows. The order
// is reasoning tail, then the plan note, then the task list collapses, then
// telemetry rows — transient narration goes before state you cannot recover by
// scrolling. Returns at most MaxRows lines, each at most Width columns.
func RenderHud(model HudModel) []string {
	// The requested width is honoured exactly — capping is the caller's job, so
	// an explicit width (an archived snapshot, a test) renders at that width.
	width := model.Width
	if width < 1 {
		width = 1
	}
	maxRows := model.MaxRows
	if maxRows <= 0 {
		maxRows = math.MaxInt32
	}
	if width < MinBoxWidth || maxRows < 4 {
		return []string{oneLiner(model, width)}
	}

	thinkWindow := model.ThinkingWindow
	if thinkWindow == 0 {
		thinkWindow = defaultThinkWindow
	}
	switch model.ThinkDisplay {
	case ThinkDisplayCollapsed:
		thinkWindow = 0
	case ThinkDisplayExpanded:
		thinkWindow = expandedThinkWindow
	}
	options := buildOptions{
		thinkWindow: thinkWindow, collapseAfter: defaultCollapse, telemetryLimit: 8, note: true,
	}
	switch model.PlanDisplay {
	case PlanDisplayCollapsed:
		options.collapseAfter = 1
	case PlanDisplayExpanded:
		options.collapseAfter = math.MaxInt32 / 4
	}
	body := build(model, width, options)
	shedThinking := func() {
		for len(body) > maxRows && options.thinkWindow > 0 {
			options.thinkWindow--
			body = build(model, width, options)
		}
	}
	shedNote := func() {
		if len(body) > maxRows && options.note {
			options.note = false
			body = build(model, width, options)
		}
	}
	shedTasks := func() {
		for len(body) > maxRows && options.collapseAfter > 1 {
			options.collapseAfter--
			body = build(model, width, options)
		}
	}
	shedTelemetry := func() {
		for len(body) > maxRows && options.telemetryLimit > telemetryFloor {
			options.telemetryLimit--
			body = build(model, width, options)
		}
	}
	if model.ThinkDisplay == ThinkDisplayExpanded {
		// Asked-for content sheds last: drop the state you can recover by
		// scrolling before the narration the operator just opened up.
		shedNote()
		shedTasks()
		shedTelemetry()
		shedThinking()
	} else {
		shedThinking()
		shedNote()
		shedTasks()
		shedTelemetry()
	}
	if len(body) > maxRows {
		// A terminal too short even for the tightest box still keeps its head
		// and its closing edge, so the box never reads as truncated mid-draw.
		trimmed := append([]string{}, body[:maxRows-1]...)
		body = append(trimmed, body[len(body)-1])
	}
	return body
}

// oneLiner is the absolute fallback for a terminal with room for a line, not a box.
func oneLiner(model HudModel, width int) string {
	route := RouteChip(model)
	elapsed := FormatDuration(model.ElapsedMs)
	frame := model.Frame
	if frame == "" {
		frame = spinGlyph
	}
	painted := strings.Join([]string{C.Accent(frame), route.Painted, C.Violet(model.Phase), C.OK(elapsed)}, " ")
	plain := strings.Join([]string{frame, route.Plain, model.Phase, elapsed}, " ")
	if DisplayWidth(plain) <= width {
		return painted
	}
	return C.Faint(Truncate(plain, width))
}
