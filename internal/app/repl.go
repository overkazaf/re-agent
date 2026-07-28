package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/buildinfo"
	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/workflow"
	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

func repl(state *State) error {
	editor := NewEditor()
	state.editor = editor
	interactive := editor.Interactive()

	// Auth is probed concurrently with the logo reveal so the boot screen costs
	// roughly nothing beyond the animation itself.
	authProbe := make(chan []auth.Status, 1)
	go func() { authProbe <- auth.Statuses(state.Config) }()

	splash := ui.SplashContext{
		Config: state.Config, Policy: state.ToolContext.Policy, SessionFile: state.Session.File,
		Version: buildinfo.DisplayVersion(), Build: buildinfo.Current(), Tools: state.Tools,
		System: ui.ProbeSystem(), Workspace: ui.ProbeWorkspace(state.ToolContext.Workspace),
	}
	splash.Auth = ui.PlaySplash(splash, authProbe)
	state.Splash = &splash

	if interactive {
		editor.Complete = func(line string) []string {
			return ui.CompletionReplacements(line, providerNames(state), skillNames(state))
		}
		editor.Palette = func(line string, maxRows int) string {
			if !strings.HasPrefix(line, "/") {
				return ""
			}
			// Title, rule and footer cost three rows; below four there is no
			// room for even one suggestion, so draw nothing rather than a
			// panel that scrolls the prompt away.
			if maxRows < 4 {
				return ""
			}
			return ui.FormatSlashCommandPalette(line, providerNames(state),
				ui.PaletteOptions{SkillNames: skillNames(state), Limit: maxRows - 3})
		}
	}

	for {
		prompt := ui.PromptLabel(state.Config, state.Role, state.Provider)
		raw, err := editor.ReadLine(prompt)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if errors.Is(err, ErrInterrupted) {
			continue // ^C at the prompt clears the line, it does not exit
		}
		if err != nil {
			return err
		}
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		editor.AppendHistory(line)
		if line == "/exit" || line == "/quit" {
			return nil
		}
		if core.IsShellEscape(line) {
			// A failing or refused command is normal here; report and keep going.
			if err := runShellEscape(state, line); err != nil {
				if security.IsDenied(err) {
					fmt.Printf("%s\n\n", ui.RenderNotice("not run — "+err.Error()))
				} else {
					fmt.Printf("%s\n\n", ui.RenderError(err.Error()))
				}
			}
			continue
		}
		if strings.HasPrefix(line, "/") {
			// Command errors must never end the session: a typo in /read or an
			// unknown provider should report and return to the prompt.
			if err := handleCommand(line, state); err != nil {
				fmt.Println(ui.RenderError(err.Error()))
			}
			continue
		}
		if runTurn(state, line) {
			drainQueue(state)
		}
	}
}

func providerNames(state *State) []string {
	names := make([]string, 0, len(state.Config.Providers))
	for name := range state.Config.Providers {
		names = append(names, name)
	}
	sortStrings(names)
	return names
}

func skillNames(state *State) []string {
	names := make([]string, 0, len(state.Skills))
	for _, skill := range state.Skills {
		names = append(names, skill.Name)
	}
	return names
}

func routeLabel(state *State) string {
	if state.Provider != "" {
		return state.Provider
	}
	switch state.Role {
	case types.RolePlanner:
		return state.Config.PlannerProvider
	case types.RoleExecutor:
		return state.Config.ExecutorProvider
	}
	return "auto"
}

// runTurn executes one prompt with live narration: streamed reasoning and token
// counters in a status pane, tool calls as a tree, then the markdown-rendered
// reply and a usage footer.
func runTurn(state *State, line string) bool {
	viz := state.Flow
	if viz == "" {
		viz = "full"
	}
	// The dataflow model is mutated by events and read by the pane every frame.
	flow := ui.NewFlowModel(routeLabel(state))
	flow.Begin(routeLabel(state))

	// The HUD shows the planner → executor chain; under `auto` neither side is
	// committed until the loop routes, so Active stays unset.
	active := state.Provider
	if active == "" {
		switch state.Role {
		case types.RolePlanner:
			active = state.Config.PlannerProvider
		case types.RoleExecutor:
			active = state.Config.ExecutorProvider
		}
	}
	paneOptions := ui.LivePaneOptions{
		Route: &ui.HudRoute{
			Planner: state.Config.PlannerProvider, Executor: state.Config.ExecutorProvider, Active: active,
		},
		PlanDisplay: state.PlanDisplay,
	}
	if viz == "full" || viz == "flow" {
		paneOptions.Flow = flow
		paneOptions.OnFrame = flow.Tick
	}
	pane := ui.NewLivePane(routeLabel(state), paneOptions)
	// The task list survives across turns, so the pane and both visualization
	// layers start from it — otherwise a turn that never re-sends an unchanged
	// list shows an empty plan for its whole duration.
	pane.SetPlan(state.Loop.Plan())
	if plan := state.Loop.Plan(); plan != nil {
		flow.SeedPlan(plan)
	}

	started := types.NowMs()
	traceOn := viz == "full" || viz == "trace"
	// One shared scale for the duration bars, widened as slower requests land.
	var slowestMs int64
	previousPlan := state.Loop.Plan()
	var thinkStart int64
	var thinkTokens float64
	planTouched := false

	onEvent := func(event core.LoopEvent) {
		flow.Apply(event)
		if event.Type == "wire" && event.Phase == "recv" && event.Ms > slowestMs {
			slowestMs = event.Ms
		}
		if traceOn {
			for _, traced := range ui.TraceEvent(event, ui.TraceOptions{
				StartedAt: started, SlowestMs: slowestMs, PreviousPlan: previousPlan,
			}) {
				pane.Commit(traced)
			}
		}
		if event.Type == "plan" {
			previousPlan = event.Snapshot
			planTouched = true
		}

		switch event.Type {
		case "turn":
			if event.Turn == 1 {
				pane.SetPhase("working")
			} else {
				pane.SetPhase(fmt.Sprintf("turn %d", event.Turn))
			}
		case "progress":
			progress := event.Progress
			switch progress.Kind {
			case "thinking":
				if thinkStart == 0 {
					thinkStart = types.NowMs()
					pane.SetPhase("thinking")
				}
				// Codex streams real reasoning text; Claude Code redacts it and
				// sends only a token estimate, so text may legitimately be empty.
				if progress.Text != "" {
					pane.PushThinking(progress.Text)
				}
				if progress.Usage != nil && progress.Usage.Thinking != 0 {
					thinkTokens = progress.Usage.Thinking
					pane.SetStats(*progress.Usage)
				}
			case "status":
				if progress.Status != "" {
					pane.SetPhase(progress.Status)
				}
			case "text":
				if thinkStart != 0 {
					pane.Commit(ui.ThinkingSummary(types.NowMs()-thinkStart, thinkTokens, pane.ThinkingChars()))
					thinkStart = 0
				}
				pane.SetPhase("writing")
			case "tool":
				if progress.Tool != "" {
					if !traceOn {
						pane.Commit(ui.RenderToolStart(progress.Tool, nil))
					}
					pane.SetPhase("tool")
				}
			case "usage":
				if progress.Usage != nil {
					if progress.Usage.Thinking != 0 {
						thinkTokens = progress.Usage.Thinking
					}
					pane.SetStats(*progress.Usage)
				}
			}
		case "compaction":
			if !traceOn {
				pane.Commit(ui.RenderNotice(fmt.Sprintf(
					"context compacted: ≈%d → ≈%d tokens (%d dropped, %d tool results elided)",
					event.TokensBefore, event.TokensAfter, event.DroppedMessages, event.ElidedToolResults)))
			}
		case "plan":
			pane.SetPlan(event.Snapshot)
		case "reply":
			if thinkStart != 0 {
				tokens := thinkTokens
				if event.Usage != nil && event.Usage.Thinking != 0 {
					tokens = event.Usage.Thinking
				}
				pane.Commit(ui.ThinkingSummary(types.NowMs()-thinkStart, tokens, pane.ThinkingChars()))
				thinkStart = 0
			}
		case "tool_start":
			if !traceOn {
				pane.Commit(ui.RenderToolStart(event.Name, event.Args))
			}
			pane.SetPhase(event.Name)
		case "tool_end":
			if !traceOn {
				pane.Commit(ui.RenderToolEnd(event.Name, event.OK, event.Ms, event.Preview))
			}
			pane.SetPhase("working")
		}
	}

	// ^C aborts the turn (killing the provider request or its tmux task) and
	// returns to the prompt; the REPL itself only ends on /exit or EOF.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var interruptedAt atomic.Int64
	var aborting atomic.Bool
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		for {
			select {
			case <-signals:
				if aborting.CompareAndSwap(false, true) {
					interruptedAt.Store(types.NowMs())
					pane.SetPhase("interrupting")
					cancel()
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	defer signal.Stop(signals)

	// Tools ask through the same prompt the shell escape uses, with the pane out
	// of the way while the question is on screen.
	liveInput := newLiveInputController(state, pane, cancel)
	liveInput.Start()
	defer liveInput.Stop()

	state.ToolContext.Confirm = createApprover(state, pane, liveInput.Pause)
	defer func() { state.ToolContext.Confirm = nil }()

	// The live pane is gone once stopped, so the final task list is archived
	// into the scrollback — on every exit path, and exactly once.
	archived := false
	archivePlan := func() {
		if archived {
			return
		}
		archived = true
		// Only when this turn actually moved the list. The plan survives across
		// turns, so archiving unconditionally would reprint the same box after
		// every turn — the trace stays silent in exactly that case.
		if plan := state.Loop.Plan(); plan != nil && planTouched {
			fmt.Println(strings.Join(ui.RenderPlan(plan, ui.RenderPlanOptions{}), "\n"))
		}
	}

	wrappedLine := workflow.WrapPrompt(line, state.Workflow, state.Config, state.Provider)
	result, err := state.Loop.Run(wrappedLine, core.RunOptions{
		Role: state.Role, ProviderName: state.Provider, Ctx: ctx, OnEvent: onEvent,
	})
	liveInput.Stop()
	if err != nil {
		flow.End("error", err.Error())
		pane.Stop()
		// A failed turn still did work; the task list is the record of it.
		archivePlan()
		if ctx.Err() != nil {
			fmt.Printf("%s\n\n", ui.RenderNotice("interrupted"))
		} else {
			fmt.Printf("%s\n\n", ui.RenderError(err.Error()))
		}
		return false
	}

	endStage := ui.FlowStage("done")
	if result.Interrupted {
		endStage = "error"
	}
	flow.End(endStage, "")
	ms := pane.Stop()
	if traceOn {
		fmt.Println(ui.TraceEnd(started, ms, result.Provider, result.Interrupted))
	}
	archivePlan()

	if result.Interrupted {
		waited := ""
		if stamp := interruptedAt.Load(); stamp != 0 {
			waited = fmt.Sprintf(" (stopped in %s)", ui.FormatDuration(types.NowMs()-stamp))
		}
		fmt.Println(ui.RenderNotice("interrupted — partial work kept in the transcript" + waited))
		fmt.Printf("%s\n\n", ui.RunFooter(ui.RunFooterOptions{
			Provider: result.Provider, Role: string(result.Role), Turns: result.Turns, Ms: ms, Usage: result.Usage,
		}))
		return false
	}

	model := ""
	if provider, ok := state.Config.Providers[result.Provider]; ok {
		model = provider.Model
	}
	fmt.Println(ui.ReplyHeader(result.Provider, model))
	if text := lastAssistantText(result.Messages); text != "" {
		fmt.Println(ui.RenderReply(text))
	} else {
		fmt.Println(ui.RenderNotice("(no text in reply)"))
	}
	fmt.Printf("%s\n\n", ui.RunFooter(ui.RunFooterOptions{
		Provider: result.Provider, Role: string(result.Role), Turns: result.Turns, Ms: ms, Usage: result.Usage,
	}))
	return true
}

func drainQueue(state *State) {
	if state.Queue == nil {
		return
	}
	for {
		item, ok := state.Queue.Pop()
		if !ok {
			return
		}
		fmt.Println(ui.RenderNotice(fmt.Sprintf("running queued #%d", item.ID)))
		if !runTurn(state, item.Text) {
			return
		}
	}
}

type liveInputController struct {
	state  *State
	pane   *ui.LivePane
	cancel context.CancelFunc
	fd     int

	done chan struct{}
	once sync.Once
	wg   sync.WaitGroup

	mu       sync.Mutex
	rawState *term.State
	raw      bool
	paused   bool
	stopped  bool
	active   bool
	buffer   []rune
}

func newLiveInputController(state *State, pane *ui.LivePane, cancel context.CancelFunc) *liveInputController {
	return &liveInputController{
		state: state, pane: pane, cancel: cancel,
		fd: int(os.Stdin.Fd()), done: make(chan struct{}),
	}
}

func (c *liveInputController) Start() {
	if c.state.editor == nil || !c.state.editor.Interactive() {
		return
	}
	c.mu.Lock()
	c.active = c.setRawLocked()
	c.mu.Unlock()
	if !c.active {
		return
	}
	c.refreshQueueState()
	c.wg.Add(1)
	go c.loop()
}

func (c *liveInputController) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	c.mu.Unlock()
	c.once.Do(func() { close(c.done) })
	c.wg.Wait()
	c.mu.Lock()
	c.restoreLocked()
	c.buffer = nil
	c.mu.Unlock()
	if c.pane != nil {
		c.pane.SetQueueDraft("")
	}
	c.refreshQueueState()
}

func (c *liveInputController) Pause() func() {
	c.mu.Lock()
	if !c.active || c.stopped {
		c.mu.Unlock()
		return func() {}
	}
	wasPaused := c.paused
	draft := string(c.buffer)
	c.paused = true
	c.restoreLocked()
	c.mu.Unlock()
	if c.pane != nil {
		c.pane.SetQueueDraft("")
	}
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.stopped || wasPaused {
			return
		}
		c.paused = false
		c.setRawLocked()
		if c.pane != nil {
			c.pane.SetQueueDraft(draft)
		}
	}
}

func (c *liveInputController) setRawLocked() bool {
	if c.raw {
		return true
	}
	state, err := term.MakeRaw(c.fd)
	if err != nil {
		return false
	}
	c.rawState = state
	c.raw = true
	return true
}

func (c *liveInputController) restoreLocked() {
	if !c.raw {
		return
	}
	_ = term.Restore(c.fd, c.rawState)
	c.raw = false
}

func (c *liveInputController) loop() {
	defer c.wg.Done()
	for {
		select {
		case <-c.done:
			return
		default:
		}
		c.mu.Lock()
		paused := c.paused || c.stopped
		c.mu.Unlock()
		if paused {
			select {
			case <-c.done:
				return
			case <-time.After(50 * time.Millisecond):
				continue
			}
		}
		fds := []unix.PollFd{{Fd: int32(c.fd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, 100)
		if err == unix.EINTR {
			continue
		}
		if err != nil || n <= 0 {
			continue
		}
		char, _, err := c.state.editor.reader.ReadRune()
		if err != nil {
			continue
		}
		c.handleRune(char)
	}
}

func (c *liveInputController) handleRune(char rune) {
	switch char {
	case 3: // ^C
		if c.pane != nil {
			c.pane.SetPhase("interrupting")
		}
		c.cancel()
	case '\r', '\n':
		c.submit()
	case 127, 8: // backspace
		c.mu.Lock()
		if len(c.buffer) > 0 {
			c.buffer = c.buffer[:len(c.buffer)-1]
		}
		draft := string(c.buffer)
		c.mu.Unlock()
		if c.pane != nil {
			c.pane.SetQueueDraft(draft)
		}
	case 21: // ^U
		c.mu.Lock()
		c.buffer = nil
		c.mu.Unlock()
		if c.pane != nil {
			c.pane.SetQueueDraft("")
		}
	case 23: // ^W
		c.killWord()
	case 27: // escape sequence; ignore the rest on the next poll ticks
		return
	default:
		if char < 32 {
			return
		}
		c.mu.Lock()
		c.buffer = append(c.buffer, char)
		draft := string(c.buffer)
		c.mu.Unlock()
		if c.pane != nil {
			c.pane.SetQueueDraft(draft)
		}
	}
}

func (c *liveInputController) killWord() {
	c.mu.Lock()
	defer c.mu.Unlock()
	end := len(c.buffer)
	for end > 0 && c.buffer[end-1] == ' ' {
		end--
	}
	for end > 0 && c.buffer[end-1] != ' ' {
		end--
	}
	c.buffer = c.buffer[:end]
	if c.pane != nil {
		c.pane.SetQueueDraft(string(c.buffer))
	}
}

func (c *liveInputController) submit() {
	c.mu.Lock()
	line := strings.TrimSpace(string(c.buffer))
	c.buffer = nil
	c.mu.Unlock()
	if c.pane != nil {
		c.pane.SetQueueDraft("")
	}
	if line == "" {
		return
	}
	c.state.editor.AppendHistory(line)
	if strings.HasPrefix(line, "/") {
		if err := c.handleLiveCommand(line); err != nil {
			emitError(c.pane, err.Error())
		}
		c.refreshQueueState()
		return
	}
	if c.state.Queue == nil {
		c.state.Queue = newTaskQueue()
	}
	item := c.state.Queue.Add(line)
	c.refreshQueueState()
	emitNotice(c.pane, fmt.Sprintf("queued #%d for the next turn", item.ID))
}

func (c *liveInputController) handleLiveCommand(line string) error {
	command, arg := splitCommand(line)
	switch command {
	case "/queue":
		return handleQueueCommand(arg, c.state, c.pane)
	case "/tasks":
		return handleTasksCommand(arg, c.state, c.pane)
	case "/model":
		return handleModelCommand(arg, c.state, c.pane)
	case "/version":
		emitNotice(c.pane, buildinfo.VersionReport())
		return nil
	default:
		return fmt.Errorf("during a turn use /queue, /tasks, /model, or /version; other commands run at the normal prompt")
	}
}

func (c *liveInputController) refreshQueueState() {
	if c.pane == nil || c.state.Queue == nil {
		return
	}
	c.pane.SetQueueCount(c.state.Queue.Len())
}

// createApprover builds the interactive approval prompt. The live pane is paused
// so the prompt owns the screen, and a bare Enter means "no" — the safe answer
// is the one you get by reflex.
func createApprover(state *State, pane *ui.LivePane, pauseInput func() func()) func(types.ApprovalRequest) types.ApprovalDecision {
	if state.editor == nil || !state.editor.Interactive() {
		return nil
	}
	return func(request types.ApprovalRequest) types.ApprovalDecision {
		var resumeInput func()
		if pauseInput != nil {
			resumeInput = pauseInput()
			defer resumeInput()
		}
		if pane != nil {
			pane.Pause()
			defer pane.Resume()
		}
		fmt.Println(ui.RenderApprovalRequest(request))
		answer, err := state.editor.ReadLine(ui.ApprovalPromptLabel())
		if err != nil {
			return types.DecisionDeny // input closed under us: refuse rather than assume yes
		}
		switch strings.ToLower(strings.TrimSpace(answer)) {
		case "y", "yes":
			return types.DecisionAllow
		case "a", "always":
			return types.DecisionAllowAlways
		case "d", "never":
			return types.DecisionDenyAlways
		}
		return types.DecisionDeny
	}
}

// runShellEscape runs `!command` in the workspace without a model round trip.
// Output streams to the terminal as it arrives and is then appended to the
// transcript, so the next prompt can refer to what was just seen. ^C kills the
// child without ending the REPL.
func runShellEscape(state *State, line string) error {
	command := core.ParseShellEscape(line)
	if command == "" {
		fmt.Printf("%s\n", ui.RenderNotice(
			"Usage: !<command>   e.g. !ls -la   (runs in the workspace, output goes to the agent)"))
		return nil
	}

	// Clear it before drawing the header, so a refused command never leaves an
	// unfinished output box behind.
	if err := core.AssertShellCommandAllowed(command, state.ToolContext.Policy, createApprover(state, nil, nil)); err != nil {
		return err
	}

	// `cd` has to be intercepted: it runs in a throwaway `bash -c`, so letting it
	// through would change a child's directory and then discard it. Moving the
	// shared ToolContext.Workspace instead makes the new directory stick for the
	// next `!` command and for the agent's own tools, which read the same field.
	if core.IsChdir(command) {
		resolved, chErr := core.ResolveChdir(state.ToolContext.Workspace, command, state.ToolContext.Policy)
		if chErr != nil {
			return chErr
		}
		state.ToolContext.Workspace = resolved
		fmt.Printf("%s\n\n", ui.RenderNotice("workspace → "+ui.ElidePath(resolved, 60)))
		_ = state.Loop.AddContext(fmt.Sprintf(
			"[operator shell] I changed the workspace directory with `%s`; it is now %s.", command, resolved))
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt)
	go func() {
		select {
		case <-signals:
			cancel()
		case <-ctx.Done():
		}
	}()
	defer signal.Stop(signals)

	writer := ui.NewShellStreamWriter(func(text string) { fmt.Print(text) })
	fmt.Println(ui.RenderShellCommand(command))
	result, err := core.RunShellCommand(command, core.ShellRunOptions{
		Workspace:   state.ToolContext.Workspace,
		Policy:      state.ToolContext.Policy,
		Ctx:         ctx,
		PreApproved: true, // cleared above, before the header was drawn
		OnChunk:     func(stream, text string) { writer.Push(stream, text) },
	})
	writer.Flush()
	if err != nil {
		return err
	}
	fmt.Printf("%s\n\n", ui.RenderShellExit(result.Code, result.Ms, result.TimedOut, result.Aborted))
	// Best-effort: a transcript write must not lose the output already shown.
	_ = state.Loop.AddContext(core.ShellContextMessage(result, core.ShellContextMaxChars))
	return nil
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
