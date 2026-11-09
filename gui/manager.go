package main

// SessionManager: one live GUI session per AgentLoop, mirroring the assembly
// sequence of app.Run (config.Load → providers → tools → MCP → NewAgentLoop)
// and the turn mechanics of app/repl.go runTurn — without any terminal UI.
// Each session owns its goroutine, FlowModel, queue, and approval plumbing so
// messages are never shared across sessions without a lock.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/overkazaf/re-agent/internal/app"
	reassets "github.com/overkazaf/re-agent/internal/assets"
	"github.com/overkazaf/re-agent/internal/buildinfo"
	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/mcp"
	"github.com/overkazaf/re-agent/internal/providers"
	"github.com/overkazaf/re-agent/internal/skills"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/workflow"
)

// Lifecycle states pushed as kind=lifecycle events (contract §0.3).
const (
	LifecycleIdle             = "idle"
	LifecycleRunning          = "running"
	LifecycleAwaitingApproval = "awaiting_approval"
	LifecycleClosed           = "closed"
)

// Approver resolves one tool approval for a session. ctx is cancelled when the
// session closes, so an unanswered approval must return deny rather than block.
// Nil manager approver means nobody is attached: refuse, exactly like a
// non-interactive CLI run.
type Approver func(sessionID string, request types.ApprovalRequest, ctx context.Context) types.ApprovalDecision

// eventSink is everything the manager pushes toward the frontend. The real
// implementation (gui/events.go EventBridge) batches and ticks; tests install a
// direct collector.
type eventSink interface {
	LoopEvent(sessionID string, event core.LoopEvent)
	Notice(sessionID, level, text string)
	Lifecycle(sessionID, state string)
	Tick(sessionID string, tick TickDTO)
}

// directSink forwards everything synchronously — the manager test double and
// the fallback before the Wails context exists.
type directSink struct {
	mu      sync.Mutex
	onEvent func(event EventEnvelope)
}

func (s *directSink) emit(event EventEnvelope) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.onEvent != nil {
		s.onEvent(event)
	}
}

func (s *directSink) LoopEvent(sessionID string, event core.LoopEvent) {
	s.emit(EventEnvelope{SessionID: sessionID, Kind: "loop", Ts: types.NowMs(), Data: []core.LoopEvent{event}})
}

func (s *directSink) Notice(sessionID, level, text string) {
	s.emit(EventEnvelope{SessionID: sessionID, Kind: "notice", Ts: types.NowMs(),
		Data: NoticeDTO{Level: level, Text: text}})
}

func (s *directSink) Lifecycle(sessionID, state string) {
	s.emit(EventEnvelope{SessionID: sessionID, Kind: "lifecycle", Ts: types.NowMs(),
		Data: LifecycleEvent{State: state}})
}

func (s *directSink) Tick(sessionID string, tick TickDTO) {
	s.emit(EventEnvelope{SessionID: sessionID, Kind: "tick", Ts: types.NowMs(), Data: tick})
}

type guiQueueItem struct {
	ID   int
	Text string
}

// guiQueue is the GUI-side prompt queue (the app.taskQueue twin; app's queue
// type is unexported and its methods unreachable from this package).
type guiQueue struct {
	mu     sync.Mutex
	nextID int
	items  []guiQueueItem
}

func newGUIQueue() *guiQueue { return &guiQueue{nextID: 1} }

func (q *guiQueue) Add(text string) guiQueueItem {
	q.mu.Lock()
	defer q.mu.Unlock()
	item := guiQueueItem{ID: q.nextID, Text: strings.TrimSpace(text)}
	q.nextID++
	q.items = append(q.items, item)
	return item
}

func (q *guiQueue) Pop() (guiQueueItem, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return guiQueueItem{}, false
	}
	item := q.items[0]
	q.items = q.items[1:]
	return item, true
}

func (q *guiQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// guiSpinFrames mirrors the TUI braille spinner; ui's set is unexported.
var guiSpinFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// Throughput sampling cadence — same window as the TUI live pane (~6s of
// output-token deltas) so the sparkline reads the same way.
const (
	guiSparkSamples = 16
	guiSampleMs     = 400
)

// hudTracker carries the HudDTO source state: the fields a ui.LivePane would
// own in the terminal, tracked here because the GUI has no pane.
type hudTracker struct {
	mu         sync.Mutex
	phase      string
	frame      int
	turnActive bool
	startedAt  time.Time
	lastMs     int64
	stats      types.TokenUsage
	spark      []float64
	sawStats   bool
	sampledAt  int64
	sampledOut float64
	route      *ui.HudRoute
	queueCount int
	planDisp   string
	thinkDisp  string
}

func newHudTracker(route *ui.HudRoute, planDisplay, thinkDisplay string) *hudTracker {
	return &hudTracker{route: route, planDisp: planDisplay, thinkDisp: thinkDisplay}
}

func (h *hudTracker) beginTurn(active string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.phase = "working"
	h.turnActive = true
	h.startedAt = time.Now()
	h.lastMs = 0
	h.frame = 0
	if h.route != nil {
		h.route.Active = active
	}
}

func (h *hudTracker) endTurn() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.turnActive = false
	if h.startedAt.IsZero() {
		return
	}
	h.lastMs = time.Since(h.startedAt).Milliseconds()
}

func (h *hudTracker) setPhase(phase string) {
	if phase == "" {
		return
	}
	h.mu.Lock()
	h.phase = phase
	h.mu.Unlock()
}

func (h *hudTracker) setRouteActive(active string) {
	h.mu.Lock()
	if h.route != nil {
		h.route.Active = active
	}
	h.mu.Unlock()
}

func (h *hudTracker) setQueueCount(count int) {
	h.mu.Lock()
	h.queueCount = count
	h.mu.Unlock()
}

func (h *hudTracker) setDisplays(planDisplay, thinkDisplay string) {
	h.mu.Lock()
	h.planDisp, h.thinkDisp = planDisplay, thinkDisplay
	h.mu.Unlock()
}

// applyEvent translates one loop event into HUD state — the phase/usage parts
// of the authoritative onEvent closure in internal/app/repl.go.
func (h *hudTracker) applyEvent(event core.LoopEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch event.Type {
	case "turn":
		if event.Turn <= 1 {
			h.phase = "working"
		} else {
			h.phase = fmt.Sprintf("turn %d", event.Turn)
		}
	case "wire":
		if event.Phase == "send" && event.Provider != "" && h.route != nil {
			h.route.Active = event.Provider
		}
		// Non-streaming providers report tokens only on recv; the GUI has no
		// footer line to fall back on, so totals land in the telemetry strip.
		if event.Phase == "recv" && event.Usage != nil {
			h.stats = h.stats.Merge(*event.Usage)
			h.sawStats = true
		}
	case "progress":
		switch event.Progress.Kind {
		case "thinking":
			h.phase = "thinking"
		case "status":
			if event.Progress.Status != "" {
				h.phase = event.Progress.Status
			}
		case "text":
			h.phase = "writing"
		case "tool":
			if event.Progress.Tool != "" {
				h.phase = "tool"
			}
		case "usage":
			if event.Progress.Usage != nil {
				h.stats = h.stats.Merge(*event.Progress.Usage)
				h.sawStats = true
			}
		}
	case "tool_start":
		if event.Name != "" {
			h.phase = event.Name
		}
	case "tool_end":
		h.phase = "working"
	}
}

// onTick advances one animation frame and samples output throughput on the
// fixed cadence (ui.LivePane sampleThroughput semantics).
func (h *hudTracker) onTick() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.frame++
	if !h.turnActive || !h.sawStats {
		return
	}
	now := types.NowMs()
	if h.sampledAt == 0 {
		h.sampledAt = now
		h.sampledOut = h.stats.Output
		return
	}
	for guard := 0; guard < guiSparkSamples && now-h.sampledAt >= guiSampleMs; guard++ {
		delta := h.stats.Output - h.sampledOut
		if delta < 0 {
			delta = 0
		}
		h.spark = append(h.spark, delta)
		h.sampledOut = h.stats.Output
		h.sampledAt += guiSampleMs
		if len(h.spark) > guiSparkSamples {
			h.spark = h.spark[1:]
		}
	}
	if now-h.sampledAt >= guiSampleMs {
		h.sampledAt = now
	}
}

func (h *hudTracker) snapshot() HudSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	elapsed := h.lastMs
	if h.turnActive && !h.startedAt.IsZero() {
		elapsed = time.Since(h.startedAt).Milliseconds()
	}
	frame := ""
	if h.turnActive {
		frame = guiSpinFrames[h.frame%len(guiSpinFrames)]
	}
	// Copy the mutable parts: the snapshot outlives the lock and the tick
	// path reads it while beginTurn/applyEvent keep writing.
	var route *ui.HudRoute
	if h.route != nil {
		copied := *h.route
		route = &copied
	}
	spark := append([]float64(nil), h.spark...)
	return HudSnapshot{
		Phase: h.phase, Frame: frame, ElapsedMs: elapsed, Stats: h.stats,
		Spark: spark, Route: route, QueueCount: h.queueCount,
		PlanDisplay: h.planDisp, ThinkDisplay: h.thinkDisp,
	}
}

// session is one live GUI session. All long-lived fields are written only
// during assembly; the mutable ones guard through mu or their own locks
// (FlowModel, hudTracker, guiQueue).
type session struct {
	id      string
	ctx     context.Context
	cancel  context.CancelFunc
	loop    *core.AgentLoop
	flow    *ui.FlowModel
	reState *workflow.REState
	state   *app.State
	queue   *guiQueue
	hud     *hudTracker
	core    *core.Session
	config  *types.AgentConfig
	mcp     []mcp.Connection

	mu        sync.Mutex
	lifecycle string
	running   bool
	turns     sync.WaitGroup
	// turnCancel aborts the in-flight turn without closing the session; set by
	// runTurn while a turn runs, nil otherwise
	turnCancel context.CancelFunc
	// cmdMu serializes SendCommand against itself (the stdout swap it uses is
	// process-wide and the sink install/restore must stay paired).
	cmdMu sync.Mutex
}

func (s *session) lifecycleState() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lifecycle
}

// reStateSnapshot copies the reverse-mode state pointer under s.mu: syncREState
// swaps it on the SendCommand path, and runWithWorkflow runs on the turn
// goroutine that must never observe a torn read.
func (s *session) reStateSnapshot() *workflow.REState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reState
}

// SessionManager assembles, runs, and closes GUI sessions.
type SessionManager struct {
	mu           sync.Mutex
	sessions     map[string]*session
	nextID       int
	sink         eventSink
	approver     Approver
	dirs         []string // every session dir this manager created, for List/Resume
	policy       *types.ExecutionPolicy
	closeAllOnce sync.Once
}

func NewSessionManager(sink eventSink, approver Approver) *SessionManager {
	return &SessionManager{
		sessions: map[string]*session{},
		nextID:   1,
		sink:     sink,
		approver: approver,
	}
}

// policyFor clones the manager's base policy per session, so allow-always
// memories and approval modes never leak across sessions.
func (m *SessionManager) policyFor() *types.ExecutionPolicy {
	base := &types.ExecutionPolicy{
		AllowWrites:        false,
		AllowNetwork:       false,
		AllowSensitive:     false,
		CommandTimeoutMs:   30_000,
		MaxReadBytes:       128 * 1024,
		MaxToolOutputChars: 24_000,
		ApprovalMode:       types.ApprovalSafe,
		Approvals:          map[string]string{},
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.policy != nil {
		clone := *m.policy
		clone.Approvals = map[string]string{}
		for tool, value := range m.policy.Approvals {
			clone.Approvals[tool] = value
		}
		base = &clone
	}
	return base
}

// SetBasePolicy overrides the policy template new sessions clone (tests, and a
// later GUI settings surface).
func (m *SessionManager) SetBasePolicy(policy *types.ExecutionPolicy) {
	m.mu.Lock()
	m.policy = policy
	m.mu.Unlock()
}

// SetSink retargets event delivery (used at app startup when the Wails context
// becomes available).
func (m *SessionManager) SetSink(sink eventSink) {
	m.mu.Lock()
	m.sink = sink
	m.mu.Unlock()
}

func (m *SessionManager) sinkFor() eventSink {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sink != nil {
		return m.sink
	}
	return deadSink{}
}

type deadSink struct{}

func (deadSink) LoopEvent(string, core.LoopEvent) {}
func (deadSink) Notice(string, string, string)    {}
func (deadSink) Lifecycle(string, string)         {}
func (deadSink) Tick(string, TickDTO)             {}

// StartOptions mirrors dto.StartOptions internally so tests can construct it
// without the Wails binding layer. Workspace defaults to $HOME; Mock=true
// forces every route to the mock provider (the --smoke equivalent).
func (m *SessionManager) Start(opts StartOptions) (SessionInfo, error) {
	workspace := strings.TrimSpace(opts.Workspace)
	if workspace == "" || workspace == "." {
		// LaunchServices starts a .app with cwd=/, so os.Getwd is meaningless
		// in a GUI process — an empty field and the dialog's "." both resolve
		// to the filesystem root. $HOME is the honest default; the new-session
		// dialog opens pre-filled with it (or the last used workspace).
		workspace = guiHomeDir()
	}
	if workspace == "~" || strings.HasPrefix(workspace, "~/") {
		// users type shell-isms into the dialog; expand them the way a shell would
		if home, homeErr := os.UserHomeDir(); homeErr == nil {
			workspace = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(workspace, "~"), "/"))
		}
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return SessionInfo{}, err
	}
	if info, statErr := os.Stat(workspace); statErr != nil || !info.IsDir() {
		// a workspace that does not exist yet is a new project — create it the
		// way `mkdir -p` would, instead of failing the whole dialog
		if mkdirErr := os.MkdirAll(workspace, 0o755); mkdirErr != nil {
			return SessionInfo{}, fmt.Errorf("workspace %s is not usable: %w", workspace, mkdirErr)
		}
	}

	agentConfig, configPath, err := config.Load("")
	if err != nil {
		return SessionInfo{}, err
	}
	// With no meaningful cwd, config.Load cannot discover a workspace-local
	// agent.config.json — probe the workspace explicitly, mirroring what the
	// TUI finds via cwd.
	if local := filepath.Join(workspace, "agent.config.json"); local != configPath {
		if _, statErr := os.Stat(local); statErr == nil {
			if loaded, _, loadErr := config.Load(local); loadErr == nil {
				agentConfig = loaded
			}
		}
	}
	role := types.AgentRole(strings.TrimSpace(opts.Role))
	if role != "" && !types.IsRole(string(role)) {
		return SessionInfo{}, fmt.Errorf("unknown role: %s", opts.Role)
	}
	mode := workflow.Mode(strings.TrimSpace(opts.Workflow))
	if mode != "" && !workflow.IsMode(string(mode)) {
		return SessionInfo{}, fmt.Errorf("unknown workflow: %s", opts.Workflow)
	}
	if opts.Mock {
		// Mirror the --smoke override in internal/app/app.go.
		agentConfig.PlannerProvider = "mock"
		agentConfig.ExecutorProvider = "mock"
		agentConfig.ResearcherProvider = "mock"
		agentConfig.DefaultRole = types.RoleAuto
	}
	for _, name := range []string{agentConfig.PlannerProvider, agentConfig.ExecutorProvider} {
		if _, ok := agentConfig.Providers[name]; !ok {
			return SessionInfo{}, fmt.Errorf("provider not configured: %s", name)
		}
	}

	return m.assemble(opts, agentConfig, role, mode, workspace)
}

// assemble is the app.Run construction sequence, one session at a time.
func (m *SessionManager) assemble(opts StartOptions, agentConfig *types.AgentConfig, role types.AgentRole, mode workflow.Mode, workspace string) (SessionInfo, error) {
	sessionDir := filepath.Join(workspace, "sessions")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		return SessionInfo{}, err
	}

	builtInSkills := skills.Load()
	systemPrompt := reassets.SystemPrompt() + skills.SystemPrompt(builtInSkills)
	rolePrompts := map[types.AgentRole]string{}
	for _, promptRole := range []types.AgentRole{types.RolePlanner, types.RoleExecutor, types.RoleResearcher} {
		rolePrompts[promptRole] = reassets.RolePrompt(string(promptRole)).Text
	}

	providerMap := map[string]types.Provider{}
	for name, providerConfig := range agentConfig.Providers {
		provider, err := providers.Create(name, providerConfig)
		if err != nil {
			return SessionInfo{}, err
		}
		providerMap[name] = provider
	}

	m.mu.Lock()
	m.nextID++
	id := fmt.Sprintf("gui-%d", m.nextID)
	m.mu.Unlock()
	policy := m.policyFor() // policyFor takes m.mu itself — never call it holding the lock

	// One REState per session: the update_re_state tool binds to this field, and
	// /phase plus the reverse prompt wrapper read it — same binding app.Run sets
	// up through the shared State.
	var reState *workflow.REState
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{
		id: id, ctx: ctx, cancel: cancel,
		flow:  ui.NewFlowModel(agentConfig.PlannerProvider),
		queue: newGUIQueue(),
		hud: newHudTracker(&ui.HudRoute{
			Planner: agentConfig.PlannerProvider, Executor: agentConfig.ExecutorProvider,
			Active: activeProviderFor(role, agentConfig, ""),
		}, string(ui.PlanDisplayAuto), string(ui.ThinkDisplayAuto)),
		reState:   reState,
		config:    agentConfig,
		lifecycle: LifecycleIdle,
	}

	registry := tools.CreateReverseTools()
	registry = append(registry, tools.CreateRemoteTools()...)
	registry = append(registry, tools.UpdateREStateTool(&s.reState))
	// MCP servers with relative command paths must resolve against the
	// session's workspace, not the process cwd (/ under LaunchServices).
	// Clone configs before injecting Cwd — agentConfig is shared per manager.
	mcpServers := make(map[string]*types.MCPServerConfig, len(agentConfig.MCPServers))
	for name, serverConfig := range agentConfig.MCPServers {
		if serverConfig != nil && serverConfig.Cwd == "" {
			cloned := *serverConfig
			cloned.Cwd = workspace
			mcpServers[name] = &cloned
			continue
		}
		mcpServers[name] = serverConfig
	}
	connections := mcp.ConnectAll(mcpServers)
	s.mcp = connections
	for _, connection := range connections {
		if connection.Error != "" {
			continue // a server that will not start is reported, never fatal
		}
		registry = append(registry, connection.Tools...)
	}

	build := buildinfo.Current()
	sessionMeta := map[string]any{
		"agent": agentConfig.Name, "version": build.Version, "commit": build.Commit,
		"moduleVersion": build.ModuleVersion, "workspace": workspace,
		"gui": true, "plannerProvider": agentConfig.PlannerProvider,
		"executorProvider": agentConfig.ExecutorProvider, "researcherProvider": agentConfig.ResearcherProvider,
		"workflow": workflow.Status(mode, agentConfig, ""), "policy": policy,
	}
	coreSession := core.NewSession(sessionDir, "0xaf")
	if err := coreSession.Init(sessionMeta); err != nil {
		m.closeConnections(s)
		cancel()
		return SessionInfo{}, err
	}
	s.core = coreSession

	toolContext := &types.ToolContext{
		Workspace: workspace, SessionDir: sessionDir, Policy: policy,
	}
	loop := core.NewAgentLoop(core.LoopOptions{
		Config: agentConfig, Providers: providerMap, Tools: registry,
		ToolContext: toolContext, SystemPrompt: systemPrompt, RolePrompts: rolePrompts,
		Session: coreSession,
	})
	// Tool approvals route through the manager approver (the GUI approval
	// bridge); a session-scoped ctx cancels unanswered prompts on close.
	toolContext.Confirm = func(request types.ApprovalRequest) types.ApprovalDecision {
		return m.approve(s, request)
	}

	s.loop = loop
	s.state = &app.State{
		Config: agentConfig, Loop: loop, Session: coreSession, Tools: registry,
		ToolContext: toolContext, Role: role, Provider: "", Skills: builtInSkills,
		MCP: connections, Providers: providerMap, Workflow: mode,
		PlanDisplay: ui.PlanDisplayAuto, ThinkDisplay: ui.ThinkDisplayAuto,
		SessionMeta: sessionMeta,
	}

	m.mu.Lock()
	m.sessions[id] = s
	m.rememberDir(sessionDir)
	m.mu.Unlock()

	m.sinkFor().Lifecycle(id, LifecycleIdle)
	return SessionInfo{
		ID: id, Workspace: workspace, Role: string(role), Workflow: string(mode),
		Planner: agentConfig.PlannerProvider, Executor: agentConfig.ExecutorProvider,
		Lifecycle: LifecycleIdle,
	}, nil
}

// approve funnels one approval request through the session approver, keeping
// the awaiting-approval lifecycle honest while somebody is being asked.
func (m *SessionManager) approve(s *session, request types.ApprovalRequest) types.ApprovalDecision {
	m.mu.Lock()
	approver := m.approver
	m.mu.Unlock()
	if approver == nil {
		return types.DecisionDeny
	}
	m.setLifecycle(s, LifecycleAwaitingApproval)
	defer m.restoreAfterApproval(s)
	return approver(s.id, request, s.ctx)
}

// restoreAfterApproval drops back to running while the turn is still live,
// otherwise back to idle — never over a closed session.
func (m *SessionManager) restoreAfterApproval(s *session) {
	s.mu.Lock()
	closed := s.lifecycle == LifecycleClosed
	running := s.running
	s.mu.Unlock()
	if closed {
		return
	}
	if running {
		m.setLifecycle(s, LifecycleRunning)
	} else {
		m.setLifecycle(s, LifecycleIdle)
	}
}

// Resume revives a previous transcript into a fresh GUI session: resolve →
// LoadSession → assemble in the original workspace → loop.Restore, matching
// the --resume path in app.Run. Resolving and loading happen before anything
// is created, so a bad id leaves no stub session file behind.
func (m *SessionManager) Resume(idOrPath string) (SessionInfo, error) {
	target := m.resolve(idOrPath)
	if target == nil {
		return SessionInfo{}, fmt.Errorf("no session matching '%s'", idOrPath)
	}
	loaded, err := core.LoadSession(target.File)
	if err != nil {
		return SessionInfo{}, err
	}
	// The restored session keeps working in the workspace it was started in.
	workspace := strings.TrimSpace(target.Workspace)
	if workspace == "" {
		workspace = guiHomeDir()
	}
	opts := StartOptions{Workspace: workspace}
	agentConfig, _, err := config.Load("")
	if err != nil {
		return SessionInfo{}, err
	}
	info, err := m.assemble(opts, agentConfig, "", workflow.Off, workspace)
	if err != nil {
		return SessionInfo{}, err
	}
	s := m.get(info.ID)
	if s == nil {
		return SessionInfo{}, fmt.Errorf("session vanished: %s", info.ID)
	}
	if err := s.loop.Restore(loaded.Messages, loaded.Plan); err != nil {
		m.CloseSession(info.ID)
		// assemble already wrote a session header to disk; a half-restored
		// transcript is noise, not history — remove it.
		_ = os.Remove(s.core.File)
		return SessionInfo{}, err
	}
	_ = s.core.AppendEvent(map[string]any{
		"type": "resumed_from", "file": target.File, "messages": len(loaded.Messages),
	})
	return info, nil
}

// List maps core.ListSessions onto the resume picker DTO, merging every session
// directory this manager has created (different workspaces keep their own
// sessions/ subtree) plus the cwd default.
func (m *SessionManager) List() ([]SessionSummaryDTO, error) {
	seen := map[string]bool{}
	out := []SessionSummaryDTO{} // nil would marshal as null and break the picker
	for _, dir := range m.knownDirs() {
		for _, summary := range core.ListSessions(dir, 20) {
			if seen[summary.ID] {
				continue
			}
			seen[summary.ID] = true
			out = append(out, SessionSummaryDTO{
				ID: summary.ID, Hash: summary.Hash, UpdatedAt: summary.UpdatedAt.Format(time.RFC3339),
				Messages: summary.Messages, Workspace: summary.Workspace, FirstPrompt: summary.FirstPrompt,
			})
		}
	}
	return out, nil
}

func (m *SessionManager) rememberDir(dir string) {
	for _, known := range m.dirs {
		if known == dir {
			return
		}
	}
	m.dirs = append(m.dirs, dir)
}

func (m *SessionManager) knownDirs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := append([]string{}, m.dirs...)
	out = append(out, m.defaultSessionDir())
	return out
}

func (m *SessionManager) defaultSessionDir() string {
	return filepath.Join(guiHomeDir(), "sessions")
}

// guiHomeDir is the fallback workspace for GUI-initiated sessions. The .app
// process runs with cwd=/ under LaunchServices, so os.Getwd is meaningless
// here; $HOME is the stable root the dialogs can relative to. /tmp keeps the
// manager usable even in a broken environment.
func guiHomeDir() string {
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return home
	}
	return "/tmp"
}

// resolve finds a saved session by id/prefix/hash/path across the directories
// this manager knows about.
func (m *SessionManager) resolve(idOrPath string) *core.Summary {
	for _, dir := range m.knownDirs() {
		if target := core.ResolveSession(dir, idOrPath); target != nil {
			return target
		}
	}
	return nil
}

func (m *SessionManager) get(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

// anyState returns one live session's app.State — the completion source for
// provider/skill arguments when the frontend asks before picking a session.
func (m *SessionManager) anyState() *app.State {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		return s.state
	}
	return nil
}

func (m *SessionManager) setLifecycle(s *session, state string) {
	s.mu.Lock()
	if s.lifecycle == LifecycleClosed {
		s.mu.Unlock()
		return
	}
	s.lifecycle = state
	s.mu.Unlock()
	m.sinkFor().Lifecycle(s.id, state)
}

// SendPrompt runs a prompt now, or queues it while a turn is in flight — the
// SendPrompt contract. Queue drain mirrors repl.go drainQueue.
func (m *SessionManager) SendPrompt(id, text string) error {
	s := m.get(id)
	if s == nil {
		return errUnknownSession(id)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("empty prompt")
	}
	// Serialize the running transition against SendCommand's mid-turn guard
	// (same lock order cmdMu → s.mu as SendCommand/SetSettings). Without this,
	// a prompt landing between the guard's check and RunCommand would start a
	// turn whose state reads race the command's writes.
	s.cmdMu.Lock()
	defer s.cmdMu.Unlock()
	s.mu.Lock()
	if s.lifecycle == LifecycleClosed {
		// CloseSession already ran between our get() and this lock — a turn
		// would run on closed MCP connections
		s.mu.Unlock()
		return fmt.Errorf("session %s is closed", id)
	}
	if s.running {
		s.mu.Unlock()
		item := s.queue.Add(text)
		s.hud.setQueueCount(s.queue.Len())
		m.sinkFor().Notice(id, "info", fmt.Sprintf("queued #%d for the next turn", item.ID))
		m.emitTick(s)
		return nil
	}
	s.running = true
	// Add inside the same critical section as running=true: CloseSession's
	// turns.Wait must never observe a zero count while a started turn is
	// still between its Add and its goroutine
	s.turns.Add(1)
	s.mu.Unlock()

	s.hud.setQueueCount(s.queue.Len())
	go func() {
		defer s.turns.Done()
		m.drainTurns(s, text)
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
		s.hud.setQueueCount(s.queue.Len())
	}()
	return nil
}

// Interrupt aborts the in-flight turn without closing the session. The turn
// unwinds through the same ctx path as a session close, but the session, its
// queue, and its MCP connections survive; runTurn returns false on
// interruption, so the queue stops draining too.
func (m *SessionManager) Interrupt(id string) bool {
	s := m.get(id)
	if s == nil {
		return false
	}
	s.mu.Lock()
	cancel := s.turnCancel
	s.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

// drainTurns runs the first prompt, then keeps pulling from the queue while
// turns keep succeeding (repl.go: runTurn → drainQueue).
func (m *SessionManager) drainTurns(s *session, first string) {
	ok := m.runTurn(s, first)
	for ok {
		item, has := s.queue.Pop()
		if !has {
			return
		}
		s.hud.setQueueCount(s.queue.Len())
		m.sinkFor().Notice(s.id, "info", fmt.Sprintf("running queued #%d", item.ID))
		ok = m.runTurn(s, item.Text)
	}
}

// runTurn is the GUI translation of app/repl.go runTurn: reset the plan, open a
// fresh flow model, bridge events, run the workflow path, close the stage out.
func (m *SessionManager) runTurn(s *session, prompt string) bool {
	s.loop.ResetPlan()
	label := routeLabelOf(s.state)
	s.flow.Begin(label)
	s.hud.beginTurn(activeProviderFor(s.state.Role, s.state.Config, s.state.Provider))
	m.setLifecycle(s, LifecycleRunning)
	m.emitTick(s)

	turnCtx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	// expose the cancel so Interrupt can stop a runaway turn mid-flight
	s.mu.Lock()
	s.turnCancel = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.turnCancel = nil
		s.mu.Unlock()
	}()

	onEvent := func(event core.LoopEvent) {
		s.flow.Apply(event)
		s.hud.applyEvent(event)
		m.sinkFor().LoopEvent(s.id, event)
	}
	onPhase := func(provider string, role types.AgentRole) {
		if provider == "" {
			return
		}
		s.flow.Begin(provider)
		s.hud.setRouteActive(provider)
		switch role {
		case types.RolePlanner:
			s.hud.setPhase("planning")
		case types.RoleExecutor:
			s.hud.setPhase("executing")
		default:
			s.hud.setPhase("working")
		}
	}

	result, err := m.runWithWorkflow(s, prompt, turnCtx, onEvent, onPhase)
	if err != nil {
		s.flow.End("error", err.Error())
		if turnCtx.Err() != nil {
			m.sinkFor().Notice(s.id, "info", "interrupted")
		} else {
			m.sinkFor().Notice(s.id, "error", err.Error())
		}
		m.finishTurn(s)
		return false
	}
	endStage := ui.FlowStage("done")
	if result.Interrupted {
		endStage = "error"
	}
	s.flow.End(endStage, "")
	m.finishTurn(s)
	return !result.Interrupted
}

func (m *SessionManager) finishTurn(s *session) {
	s.hud.endTurn()
	m.setLifecycle(s, LifecycleIdle)
	m.emitTick(s)
}

// runWithWorkflow mirrors internal/app/workflow_run.go: delegate planner→executor
// when the mode asks for it, otherwise run one wrapped prompt. workflow's
// exported helpers plus exported workflow-delegate.go behavior make the copy a
// straight translation; app's unexported runner cannot be reached from gui.
func (m *SessionManager) runWithWorkflow(s *session, prompt string, ctx context.Context, onEvent func(core.LoopEvent), onPhase func(string, types.AgentRole)) (types.RunResult, error) {
	state := s.state
	if workflow.ShouldDelegate(state.Workflow, state.Config, state.Provider, state.Role) {
		return m.runDelegated(s, prompt, ctx, onEvent, onPhase)
	}
	wrapped := workflow.WrapPrompt(prompt, state.Workflow, state.Config, state.Provider, s.reStateSnapshot())
	return s.loop.Run(wrapped, core.RunOptions{
		Role: state.Role, ProviderName: state.Provider, Ctx: ctx, OnEvent: onEvent,
	})
}

func (m *SessionManager) runDelegated(s *session, prompt string, ctx context.Context, onEvent func(core.LoopEvent), onPhase func(string, types.AgentRole)) (types.RunResult, error) {
	state := s.state
	planner := state.Config.PlannerProvider
	executor := state.Config.ExecutorProvider

	if onPhase != nil {
		onPhase(planner, types.RolePlanner)
	}
	plannerResult, err := s.loop.Run(workflow.DelegatedPlannerPrompt(prompt), core.RunOptions{
		Role: types.RolePlanner, ProviderName: planner, Ctx: ctx, OnEvent: onEvent,
		Tools: workflow.DelegatedPlannerTools(state.Tools),
	})
	if err != nil || plannerResult.Interrupted {
		return plannerResult, err
	}

	if onPhase != nil {
		onPhase(executor, types.RoleExecutor)
	}
	executorResult, err := s.loop.Run(workflow.DelegatedExecutorPrompt(prompt, lastAssistantText(plannerResult.Messages)), core.RunOptions{
		Role: types.RoleExecutor, ProviderName: executor, Ctx: ctx, OnEvent: onEvent,
		Isolated: true, SystemPrompt: workflow.DelegatedExecutorSystemPrompt(),
		Tools: workflow.DelegatedExecutorTools(state.Tools), FreshSession: true,
	})
	if err != nil {
		return executorResult, err
	}
	combined := executorResult
	combined.Provider = planner + "->" + executor
	combined.Role = types.RoleAuto
	combined.Turns = plannerResult.Turns + executorResult.Turns
	combined.Usage = plannerResult.Usage
	combined.Usage.Add(executorResult.Usage)
	combined.Interrupted = plannerResult.Interrupted || executorResult.Interrupted
	return combined, nil
}

// emitTick pushes one immediate snapshot (the "state change fires a tick" half
// of the contract; the 90ms cadence lives in the EventBridge).
func (m *SessionManager) emitTick(s *session) {
	if tick, ok := m.Snapshot(s.id); ok {
		m.sinkFor().Tick(s.id, tick)
	}
}

// Snapshot builds the TickDTO for GetState and the tick cadence.
func (m *SessionManager) Snapshot(id string) (TickDTO, bool) {
	s := m.get(id)
	if s == nil {
		return TickDTO{}, false
	}
	return NewTickDTO(
		s.flow.Snapshot(), s.hud.snapshot(), reHudOf(s), s.loop.Plan(),
	), true
}

// TickSnapshot advances one animation frame (spinner, sparkline sampling) and
// returns the fresh snapshot — the EventBridge cadence calls this per tick, the
// same role the TUI live pane's redraw loop plays.
func (m *SessionManager) TickSnapshot(id string) (TickDTO, bool) {
	s := m.get(id)
	if s == nil {
		return TickDTO{}, false
	}
	s.hud.onTick()
	return NewTickDTO(
		s.flow.Snapshot(), s.hud.snapshot(), reHudOf(s), s.loop.Plan(),
	), true
}

// GetSettings renders the session's live config for the settings dialog.
// Providers are sorted by name; API keys and endpoints stay on this side.
func (m *SessionManager) GetSettings(id string) (SettingsDTO, error) {
	s := m.get(id)
	if s == nil {
		return SettingsDTO{}, errUnknownSession(id)
	}
	cfg := s.state.Config
	dto := SettingsDTO{
		Role:               string(s.state.Role),
		Provider:           s.state.Provider,
		PlannerProvider:    cfg.PlannerProvider,
		ExecutorProvider:   cfg.ExecutorProvider,
		ResearcherProvider: cfg.ResearcherProvider,
		ProviderNames:      providerNamesOf(cfg),
		MaxTurns:           cfg.MaxTurns,
		CompactionStrategy: cfg.CompactionStrategy,
		MCPServerCount:     len(cfg.MCPServers),
	}
	dto.Providers = make([]ProviderInfoDTO, 0, len(cfg.Providers))
	for _, name := range dto.ProviderNames {
		p := cfg.Providers[name]
		dto.Providers = append(dto.Providers, ProviderInfoDTO{Name: name, Model: p.Model, Type: string(p.Type)})
	}
	if dto.CompactionStrategy == "" {
		dto.CompactionStrategy = "summary"
	}
	return dto, nil
}

// SetSettings applies the patch to the session's live config. Provider routes
// persist through SaveUIPrefs (the same path the terminal /planner /executor
// /researcher commands take), so they survive restarts; maxTurns stays
// session-local. Empty patch fields leave their setting alone.
func (m *SessionManager) SetSettings(id string, patch SettingsPatch) error {
	s := m.get(id)
	if s == nil {
		return errUnknownSession(id)
	}
	// config mutations go through the same serialization as slash commands —
	// a running turn reads cfg.PlannerProvider mid-loop
	s.cmdMu.Lock()
	defer s.cmdMu.Unlock()
	cfg := s.state.Config
	if patch.PlannerProvider != "" {
		if cfg.Providers[patch.PlannerProvider] == nil {
			return fmt.Errorf("unknown provider: %s", patch.PlannerProvider)
		}
		cfg.PlannerProvider = patch.PlannerProvider
		config.SaveUIPrefs(map[string]string{"plannerProvider": patch.PlannerProvider})
	}
	if patch.ExecutorProvider != "" {
		if cfg.Providers[patch.ExecutorProvider] == nil {
			return fmt.Errorf("unknown provider: %s", patch.ExecutorProvider)
		}
		cfg.ExecutorProvider = patch.ExecutorProvider
		config.SaveUIPrefs(map[string]string{"executorProvider": patch.ExecutorProvider})
	}
	if patch.ResearcherProvider != "" {
		if cfg.Providers[patch.ResearcherProvider] == nil {
			return fmt.Errorf("unknown provider: %s", patch.ResearcherProvider)
		}
		cfg.ResearcherProvider = patch.ResearcherProvider
		config.SaveUIPrefs(map[string]string{"researcherProvider": patch.ResearcherProvider})
	}
	if patch.MaxTurns != 0 {
		if patch.MaxTurns < 1 || patch.MaxTurns > 200 {
			return fmt.Errorf("maxTurns %d out of range (1-200)", patch.MaxTurns)
		}
		cfg.MaxTurns = patch.MaxTurns
	}
	return nil
}

// reHudOf mirrors repl.go refreshRE: the reverse-mode strip, only in reverse
// workflow sessions that have picked a sample.
func reHudOf(s *session) *ui.REHudModel {
	// the pointer itself is swapped by syncREState on the SendCommand path —
	// copy it under s.mu before snapshotting
	s.mu.Lock()
	re := s.reState
	s.mu.Unlock()
	if re == nil {
		return nil
	}
	// the update_re_state tool writes this struct on the turn goroutine while
	// the tick cadence reads it here — snapshot under the state's lock
	snap := re.Snapshot()
	return &ui.REHudModel{
		SampleType: snap.SampleType,
		Phase:      string(snap.Phase),
		PhaseIndex: workflow.PhaseIndex(snap.Phase),
		PhaseCount: len(workflow.Phases),
		Hypotheses: len(snap.Hypotheses),
		Evidence:   len(snap.Evidence),
	}
}

// syncREState mirrors state.REState — the single source of truth the /workflow
// command writes — into s.reState, the field the update_re_state tool binds to,
// the prompt wrapper reads, and the RE strip snapshots. Unconditional mirroring
// (not just nil-adoption) keeps a re-pick (apk → so) from leaving every reader
// on the abandoned session. Returns whether the pointer changed, so callers
// can emit the tick SendCommand otherwise never would.
func syncREState(s *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.REState == s.reState {
		return false
	}
	s.reState = s.state.REState
	return true
}

// CloseSession cancels the session context (aborting the turn and any pending
// approval), drains pending approvals as denials, waits for the turn goroutine,
// and closes MCP connections. Pending approvals deny because the approver's
// ctx is the session ctx.
func (m *SessionManager) CloseSession(id string) error {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s == nil {
		return errUnknownSession(id)
	}

	s.mu.Lock()
	s.lifecycle = LifecycleClosed
	s.mu.Unlock()
	s.cancel() // turn ctx + approval waits unwind
	s.turns.Wait()
	m.closeConnections(s)
	m.sinkFor().Notice(id, "info", "session closed")
	m.sinkFor().Lifecycle(id, LifecycleClosed)
	return nil
}

func (m *SessionManager) closeConnections(s *session) {
	for _, connection := range s.mcp {
		if connection.Client != nil {
			connection.Client.Close()
		}
	}
}

// CloseAll shuts every live session down (app shutdown path).
func (m *SessionManager) CloseAll() {
	m.closeAllOnce.Do(func() {
		m.mu.Lock()
		ids := make([]string, 0, len(m.sessions))
		for id := range m.sessions {
			ids = append(ids, id)
		}
		m.mu.Unlock()
		for _, id := range ids {
			_ = m.CloseSession(id)
		}
	})
}

func (m *SessionManager) Lifecycle(id string) string {
	s := m.get(id)
	if s == nil {
		return LifecycleClosed
	}
	return s.lifecycleState()
}

func errUnknownSession(id string) error {
	return fmt.Errorf("unknown session: %s", id)
}

// routeLabelOf mirrors app/repl.go routeLabel.
func routeLabelOf(state *app.State) string {
	if state.Provider != "" {
		return state.Provider
	}
	switch state.Role {
	case types.RolePlanner:
		return state.Config.PlannerProvider
	case types.RoleExecutor:
		return state.Config.ExecutorProvider
	case types.RoleResearcher:
		return researcherProviderOf(state.Config)
	}
	return "auto"
}

func researcherProviderOf(config *types.AgentConfig) string {
	if config.ResearcherProvider != "" {
		return config.ResearcherProvider
	}
	return config.PlannerProvider
}

// activeProviderFor mirrors the runTurn active-route computation: pinned
// provider wins, otherwise the role side that would answer under auto.
func activeProviderFor(role types.AgentRole, config *types.AgentConfig, pinned string) string {
	if pinned != "" {
		return pinned
	}
	switch role {
	case types.RolePlanner:
		return config.PlannerProvider
	case types.RoleExecutor:
		return config.ExecutorProvider
	case types.RoleResearcher:
		return researcherProviderOf(config)
	}
	return ""
}

// lastAssistantText mirrors internal/app.lastAssistantText.
func lastAssistantText(messages []types.Message) string {
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index].Role == types.MessageAssistant {
			return strings.TrimSpace(messages[index].Text())
		}
	}
	return ""
}
