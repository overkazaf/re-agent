package providers

// Runs a local coding CLI (codex, claude, grok) inside a detached tmux session,
// tailing its JSONL stdout so the operator sees reasoning, tool activity, and
// token counts live. A tmux failure falls back to running the same script
// directly, unless the turn was interrupted.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

type cliPaths struct {
	runDir string
	prompt string
	output string
	stdout string
	stderr string
	exit   string
	runner string
	socket string
}

type CLITmuxProvider struct {
	baseProvider
	// Native CLI conversation state, kept for the lifetime of this process so
	// successive turns resume one persistent session instead of spawning a
	// throwaway one each time.
	cliSessionID      string
	cliSessionStarted bool
	// Claude's task list is session-scoped, and this provider resumes one native
	// session across turns, so the table has to outlive the per-turn parser.
	claudeTasks ClaudeTaskTable
}

func (p *CLITmuxProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	command := p.config.CLICommand
	if command == "" {
		return types.ProviderResponse{}, fmt.Errorf("provider '%s' is missing cliCommand", p.name)
	}
	if issue := cliAuthIssue(command, p.config.CLIUnsetEnv); issue != "" {
		return types.ProviderResponse{}, fmt.Errorf("%s", formatCLIAuthIssue(p.name, command, issue))
	}

	workspace := input.Workspace
	if workspace == "" {
		workspace, _ = os.Getwd()
	}
	workspace, _ = filepath.Abs(workspace)

	paths, err := createRunPaths(p.name, input.SessionDir)
	if err != nil {
		return types.ProviderResponse{}, err
	}
	maxChars := p.config.CLIPromptMaxChar
	if maxChars == 0 {
		maxChars = 80_000
	}
	resuming, sessionArgs, sessionID := p.resolveSession(input.FreshSession)
	// A non-resuming turn spawns a brand new CLI session whose task ids restart
	// at 1. Keeping the old table would let those ids collide with the previous
	// session's steps and corrupt the plan.
	if !resuming {
		p.claudeTasks.Reset()
	}
	var prompt string
	if resuming {
		prompt = buildResumePrompt(input.System, deltaSince(input.Messages, p.name), workspace, maxChars)
	} else {
		prompt = buildPrompt(input.System, input.Messages, input.Tools, workspace, maxChars)
	}
	if err := os.WriteFile(paths.prompt, []byte(prompt), 0o644); err != nil {
		return types.ProviderResponse{}, err
	}

	args := append(append([]string{}, p.config.CLIArgs...), sessionArgs...)
	for i, arg := range args {
		args[i] = replacePlaceholders(arg, paths, workspace, p.config.Model)
	}
	sessionName := tmuxSessionName(p.name)
	shellPath, err := tools.ResolveShell()
	if err != nil {
		return types.ProviderResponse{}, err
	}
	script, err := runnerScript(shellPath, command, args, paths, workspace, p.config.CLIUnsetEnv)
	if err != nil {
		return types.ProviderResponse{}, err
	}
	if err := os.WriteFile(paths.runner, []byte(script), 0o700); err != nil {
		return types.ProviderResponse{}, err
	}

	// When the CLI speaks JSONL, tail its stdout while it runs so the operator
	// sees real reasoning, tool activity, and token counts live.
	var format StreamFormat
	if p.config.CLIStream == nil || *p.config.CLIStream {
		format = StreamFormatFor(command, args)
	}
	var parser *StreamParser
	var reasoning strings.Builder
	var tail *stdoutTail
	if format != "" {
		parser = NewStreamParser(format, &p.claudeTasks)
		// Tail whenever the CLI speaks JSONL, even with no progress listener:
		// the parsed stream *is* the reply text for these providers, and it is
		// also the only thing that keeps the task table in step with the CLI's
		// own list.
		tail = newStdoutTail(paths.stdout, func(chunk string) {
			for _, event := range parser.Push(chunk) {
				if event.Kind == "thinking" && event.Text != "" {
					reasoning.WriteString(event.Text)
				}
				if event.Kind == "final" {
					continue // surfaced via the return value
				}
				if input.OnProgress != nil {
					input.OnProgress(types.ProviderProgress{
						Kind: event.Kind, Text: event.Text, Tool: event.Tool,
						Status: event.Status, Usage: event.Usage,
						Plan: event.Plan, PlanNote: event.PlanNote,
					})
				}
			}
		})
	}

	timeoutMs := p.config.CLITimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 10 * 60_000
	}
	mode := "tmux"
	tail.start()
	runErr := func() error {
		if err := startTmux(p.name, sessionName, paths, shellPath); err == nil {
			if err := waitForCompletion(sessionName, paths, timeoutMs, input.Context()); err == nil {
				return nil
			} else if util.IsAbort(err) || input.Context().Err() != nil {
				// An interrupt must not fall back into a second run of the same prompt.
				return err
			} else if p.config.CLIFallbackDirec != nil && !*p.config.CLIFallbackDirec {
				return err
			}
		} else {
			if util.IsAbort(err) || input.Context().Err() != nil {
				return err
			}
			if p.config.CLIFallbackDirec != nil && !*p.config.CLIFallbackDirec {
				return err
			}
		}
		mode = "direct-fallback"
		return runDirect(paths.runner, shellPath, timeoutMs, input.Context())
	}()
	tail.stop()
	if runErr != nil {
		return types.ProviderResponse{}, runErr
	}

	status := 1
	if raw, err := os.ReadFile(paths.exit); err == nil {
		if parsed, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
			status = parsed
		}
	}
	stdout := readOr(paths.stdout, "")
	stderr := readOr(paths.stderr, "")
	output := readOr(paths.output, stdout)

	if status != 0 {
		return types.ProviderResponse{}, fmt.Errorf("%s",
			FormatCLIFailure(p.name, command, status, stdout, stderr, paths.runDir, format))
	}

	// With a JSONL stream the raw stdout is events, not prose, so prefer the
	// parsed final message; `--output-last-message` (codex) still wins when set.
	fileText := stripAnsi(strings.TrimSpace(output))
	text := fileText
	if format != "" {
		streamed := ""
		if parser != nil {
			streamed = strings.TrimSpace(parser.LastText())
		}
		if fileText != "" && !strings.HasPrefix(fileText, "{") {
			text = fileText
		} else {
			text = streamed
		}
	} else if text == "" {
		text = stripAnsi(strings.TrimSpace(stdout))
	}
	if text == "" {
		text = fmt.Sprintf("[%s] CLI completed without text output. Logs: %s", p.name, paths.runDir)
	}

	response := types.ProviderResponse{
		Text: text,
		Raw: map[string]any{
			"runDir": paths.runDir, "sessionName": sessionName, "command": command,
			"status": status, "mode": mode, "cliSessionId": sessionID,
		},
	}
	if parser != nil {
		response.Usage = parser.Totals()
	}
	if reasoning.Len() > 0 {
		response.Reasoning = reasoning.String()
	}
	return response, nil
}

// resolveSession decides whether this turn creates a new CLI session or resumes
// the running one, and produces the extra argv needed. The session id is claimed
// eagerly (before the CLI runs) so a mid-run failure never re-issues the same
// `--session-id`, which the CLI rejects as "already in use".
func (p *CLITmuxProvider) resolveSession(fresh bool) (resuming bool, args []string, id string) {
	if fresh || !p.config.CLIResumeSession {
		return false, nil, ""
	}
	idArg := p.config.CLISessionIDArg
	if idArg == "" {
		idArg = "--session-id"
	}
	resumeArg := p.config.CLIResumeArg
	if resumeArg == "" {
		resumeArg = "--resume"
	}
	if p.cliSessionStarted && p.cliSessionID != "" {
		return true, []string{resumeArg, p.cliSessionID}, p.cliSessionID
	}
	p.cliSessionID = randomUUID()
	p.cliSessionStarted = true
	return false, []string{idArg, p.cliSessionID}, p.cliSessionID
}

// deltaSince returns the messages that appeared after this provider last spoke —
// everything the resumed CLI session has not seen yet. On the first resume this
// is still just the tail, because the CLI already holds the earlier turns
// natively.
func deltaSince(messages []types.Message, providerName string) []types.Message {
	lastOwn := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == types.MessageAssistant && messages[i].Provider == providerName {
			lastOwn = i
			break
		}
	}
	if lastOwn >= 0 {
		return messages[lastOwn+1:]
	}
	return messages
}

func startTmux(providerName, sessionName string, paths cliPaths, shellPath string) error {
	cmd := exec.Command("tmux", "-S", paths.socket, "new-session", "-d", "-s", sessionName,
		shellQuote(shellPath)+" "+shellQuote(paths.runner))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil || strings.TrimSpace(stderr.String()) != "" {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" && err != nil {
			detail = err.Error()
		}
		return fmt.Errorf("failed to start tmux provider '%s': %s", providerName, detail)
	}
	return nil
}

func runDirect(runner, shellPath string, timeoutMs int, ctx context.Context) error {
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(runCtx, shellPath, runner)
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return util.ErrInterrupted
		}
		if runCtx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("CLI provider direct fallback timed out after %dms", timeoutMs)
		}
		// A non-zero exit is reported through exit.status, not here.
	}
	if ctx.Err() != nil {
		return util.ErrInterrupted
	}
	return nil
}

func buildPrompt(system string, messages []types.Message, tools []types.Tool, workspace string, maxChars int) string {
	var toolList []string
	for _, tool := range tools {
		toolList = append(toolList, fmt.Sprintf("- %s: %s", tool.Name, tool.Description))
	}
	prompt := strings.Join([]string{
		system,
		"",
		"You are running as a local CLI agent launched from 0xAF-Re.",
		"Workspace: " + workspace,
		"Return a concise final answer. Use local tools only when needed and keep work inside the workspace.",
		"",
		"Available host-side tools in 0xAF-Re, if you need to ask the operator to switch back:",
		strings.Join(toolList, "\n"),
		"",
		"Conversation:",
		formatTranscript(messages),
	}, "\n")
	return clipPrompt(prompt, maxChars)
}

func buildResumePrompt(system string, messages []types.Message, workspace string, maxChars int) string {
	transcript := formatTranscript(messages)
	if transcript == "" {
		transcript = "(no new turns)"
	}
	prompt := strings.Join([]string{
		"Continue the same 0xAF-Re session. Below are only the new turns since your last reply.",
		"Workspace: " + workspace,
		"Return a concise final answer. Use local tools only when needed and keep work inside the workspace.",
		// The system prompt is only sent on the first turn of a resumed CLI
		// session, so the standing instructions that matter for the operator's
		// view have to ride along with every resume.
		"Keep your task list current with your native task tool (TaskCreate/TaskUpdate, update_plan, TodoWrite): one step in_progress at a time, mark steps completed as they land.",
		"",
		"Current 0xAF-Re system and active-role instructions:",
		system,
		"",
		"New turns:",
		transcript,
	}, "\n")
	return clipPrompt(prompt, maxChars)
}

func clipPrompt(prompt string, maxChars int) string {
	if len(prompt) <= maxChars {
		return prompt
	}
	return fmt.Sprintf("%s\n\n[0xAF-Re clipped %d chars from CLI prompt]", prompt[:maxChars], len(prompt)-maxChars)
}

func formatTranscript(messages []types.Message) string {
	var parts []string
	for _, message := range messages {
		if rendered := formatMessage(message); rendered != "" {
			parts = append(parts, rendered)
		}
	}
	return strings.Join(parts, "\n\n")
}

func formatMessage(message types.Message) string {
	switch message.Role {
	case types.MessageUser:
		return "USER:\n" + message.Text()
	case types.MessageAssistant:
		provider := message.Provider
		if provider == "" {
			provider = "unknown"
		}
		return fmt.Sprintf("ASSISTANT (%s):\n%s", provider, message.Text())
	case types.MessageToolResult:
		status := "OK"
		if message.IsError {
			status = "ERROR"
		}
		return fmt.Sprintf("TOOL %s %s:\n%s", message.ToolName, status, message.Text())
	}
	return ""
}

// stdoutTail follows a growing log file and hands newly appended text to a sink.
// The runner script redirects stdout to a file rather than a pipe, so this is
// how CLI JSONL events surface while the child is still running.
type stdoutTail struct {
	file     string
	sink     func(string)
	position int64
	done     chan struct{}
	wg       sync.WaitGroup
	once     sync.Once
}

func newStdoutTail(file string, sink func(string)) *stdoutTail {
	return &stdoutTail{file: file, sink: sink, done: make(chan struct{})}
}

func (t *stdoutTail) start() {
	if t == nil {
		return
	}
	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-t.done:
				return
			case <-ticker.C:
				t.drain()
			}
		}
	}()
}

func (t *stdoutTail) stop() {
	if t == nil {
		return
	}
	t.once.Do(func() { close(t.done) })
	t.wg.Wait()
	t.drain() // final pass so trailing events are not lost
}

func (t *stdoutTail) drain() {
	info, err := os.Stat(t.file)
	if err != nil || info.Size() <= t.position {
		return
	}
	handle, err := os.Open(t.file)
	if err != nil {
		return
	}
	defer handle.Close()
	length := info.Size() - t.position
	buffer := make([]byte, length)
	read, err := handle.ReadAt(buffer, t.position)
	if read > 0 {
		t.position += int64(read)
		t.sink(string(buffer[:read]))
	}
	_ = err // tailing is best-effort; never fail a run because of it
}

func createRunPaths(providerName, sessionDir string) (cliPaths, error) {
	base := sessionDir
	if base == "" {
		cwd, _ := os.Getwd()
		base = filepath.Join(cwd, "sessions")
	}
	base = filepath.Join(base, "cli-tmux")
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	runDir := filepath.Join(base, fmt.Sprintf("%s-%s-%s", stamp, safeName(providerName), randomUUID()[:8]))
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return cliPaths{}, err
	}
	return cliPaths{
		runDir: runDir,
		prompt: filepath.Join(runDir, "prompt.txt"),
		output: filepath.Join(runDir, "output.txt"),
		stdout: filepath.Join(runDir, "stdout.log"),
		stderr: filepath.Join(runDir, "stderr.log"),
		exit:   filepath.Join(runDir, "exit.status"),
		runner: filepath.Join(runDir, "runner.sh"),
		socket: filepath.Join(runDir, "tmux.sock"),
	}, nil
}

func runnerScript(shellPath, command string, args []string, paths cliPaths, workspace string, unsetEnv []string) (string, error) {
	quoted := []string{shellQuote(command)}
	for _, arg := range args {
		quoted = append(quoted, shellQuote(arg))
	}
	lines := []string{
		"#!" + shellPath,
		"set +e",
		"cd " + shellQuote(workspace) + " || exit 97",
	}
	for _, name := range unsetEnv {
		safe, err := shellName(name)
		if err != nil {
			return "", err
		}
		lines = append(lines, "unset "+safe)
	}
	lines = append(lines,
		fmt.Sprintf("%s < %s > %s 2> %s",
			strings.Join(quoted, " "), shellQuote(paths.prompt), shellQuote(paths.stdout), shellQuote(paths.stderr)),
		"status=$?",
		fmt.Sprintf("if [ ! -s %s ] && [ -s %s ]; then cp %s %s; fi",
			shellQuote(paths.output), shellQuote(paths.stdout), shellQuote(paths.stdout), shellQuote(paths.output)),
		fmt.Sprintf(`printf "%%s" "$status" > %s`, shellQuote(paths.exit)),
		"exit 0",
		"",
	)
	return strings.Join(lines, "\n"), nil
}

func waitForCompletion(sessionName string, paths cliPaths, timeoutMs int, ctx context.Context) error {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for time.Now().Before(deadline) {
		if util.FileExists(paths.exit) {
			return nil
		}
		if ctx.Err() != nil {
			// The CLI runs detached in tmux; without killing the session it
			// would keep burning tokens after the operator walked away.
			killTmux(sessionName, paths)
			return util.ErrInterrupted
		}
		// Poll faster than the CLI is slow, so ^C feels immediate.
		time.Sleep(200 * time.Millisecond)
	}
	killTmux(sessionName, paths)
	return fmt.Errorf("tmux provider timed out after %dms; killed session %s", timeoutMs, sessionName)
}

func killTmux(sessionName string, paths cliPaths) {
	cmd := exec.Command("tmux", "-S", paths.socket, "kill-session", "-t", sessionName)
	_ = cmd.Run()
}

// FormatCLIFailure explains a non-zero CLI exit in the terms the operator needs.
func FormatCLIFailure(providerName, command string, status int, stdout, stderr, runDir string, format StreamFormat) string {
	// A JSONL stdout is hundreds of event lines; dumping it raw buries the one
	// line that explains the failure. Read the cause out of the stream instead.
	cause := ""
	if format != "" {
		cause = failureCause(stdout)
	}
	authHint := ""
	if cause == "" {
		switch command {
		case "claude":
			authHint = "Run `claude auth status` / `claude auth login` outside 0xAF-Re if this is an auth failure."
		case "codex":
			authHint = "Run `codex login status` / `codex login` outside 0xAF-Re if this is an auth failure. If OPENAI_API_KEY is bad, unset it so Codex can use ChatGPT login."
		default:
			authHint = "Check the local CLI authentication and command configuration."
		}
	}
	raw := ""
	if format == "" && strings.TrimSpace(stdout) != "" {
		raw = "stdout:\n" + stripAnsi(strings.TrimSpace(stdout))
	}
	parts := []string{fmt.Sprintf("CLI provider '%s' failed with exit %d.", providerName, status)}
	for _, line := range []string{cause, authHint, "Logs: " + runDir} {
		if line != "" {
			parts = append(parts, line)
		}
	}
	if strings.TrimSpace(stderr) != "" {
		parts = append(parts, "stderr:\n"+stripAnsi(strings.TrimSpace(stderr)))
	}
	if raw != "" {
		parts = append(parts, raw)
	}
	return strings.Join(parts, "\n")
}

// failureCause explains a JSONL-stream failure from the terminal `result` event:
// the CLI exits non-zero for reasons that have nothing to do with auth (an
// upstream refusal, a hit rate limit, an execution error), and each needs a
// different response from the operator.
func failureCause(stdout string) string {
	var result map[string]any
	var rateLimit map[string]any
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "{") {
			continue
		}
		parsed := map[string]any{}
		if err := jsonUnmarshal(trimmed, &parsed); err != nil {
			continue
		}
		if str(parsed["type"]) == "result" || parsed["is_error"] != nil {
			result = parsed
		}
		if str(parsed["type"]) == "rate_limit_event" {
			if info := asRecord(parsed["rate_limit_info"]); info != nil {
				rateLimit = info
			}
		}
	}
	if result == nil {
		return ""
	}
	stop := str(result["stop_reason"])
	subtype := str(result["subtype"])
	message := strings.TrimSpace(str(result["result"]))
	var lines []string

	switch {
	case stop == "refusal":
		lines = append(lines,
			"The upstream model refused this request (stop_reason=refusal). This is not an auth or config problem.",
			"0xAF-Re's system prompt frames every turn as reverse engineering, which can trip the refusal classifier on",
			"topics that would be answered normally otherwise. Try rephrasing, or route the turn elsewhere: /agent codex.",
		)
	case subtype == "error_max_turns":
		lines = append(lines, "The CLI stopped at its own max-turn limit before finishing.")
	case stop != "":
		lines = append(lines, "The CLI ended with stop_reason="+stop+".")
	case subtype != "":
		lines = append(lines, "The CLI ended with subtype="+subtype+".")
	}

	if rateLimit != nil && str(rateLimit["overageStatus"]) == "rejected" {
		if reason := str(rateLimit["overageDisabledReason"]); reason != "" {
			lines = append(lines, "Rate limit note: overage rejected ("+reason+").")
		}
	}
	if message != "" {
		lines = append(lines, "CLI message: "+util.Truncate(stripAnsi(util.FirstLine(message)), 300))
	}
	return strings.Join(lines, "\n")
}

func cliAuthIssue(command string, unsetEnv []string) string {
	args, ok := auth.CLIAuthStatusArgs(command)
	if !ok {
		return ""
	}
	result := auth.RunCLIStatus(command, args, unsetEnv)
	if result.OK {
		return ""
	}
	text := stripAnsi(strings.TrimSpace(result.Stdout + "\n" + result.Stderr))
	if text == "" {
		return fmt.Sprintf("status %d", result.Status)
	}
	return text
}

func formatCLIAuthIssue(providerName, command, issue string) string {
	switch command {
	case "claude":
		return strings.Join([]string{
			fmt.Sprintf("CLI provider '%s' is not authenticated.", providerName),
			"Claude Code OAuth login is failing before 0xAF-Re can use it.",
			"Try: claude auth login --console",
			"Or: claude auth login --sso",
			"Or use API mode: /executor claude-api after setting ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN.",
			"Temporary bypass: /executor codex",
			"Status: " + issue,
		}, "\n")
	case "codex":
		return strings.Join([]string{
			fmt.Sprintf("CLI provider '%s' is not authenticated.", providerName),
			"Run: codex login",
			"If OPENAI_API_KEY is stale, unset it before using Codex CLI login.",
			"Status: " + issue,
		}, "\n")
	}
	return fmt.Sprintf("CLI provider '%s' is not authenticated. Status: %s", providerName, issue)
}

func replacePlaceholders(value string, paths cliPaths, workspace, model string) string {
	return strings.NewReplacer(
		"{prompt}", paths.prompt,
		"{output}", paths.output,
		"{stdout}", paths.stdout,
		"{stderr}", paths.stderr,
		"{runDir}", paths.runDir,
		"{workspace}", workspace,
		"{model}", model,
	).Replace(value)
}

func tmuxSessionName(providerName string) string {
	name := fmt.Sprintf("0xaf-%s-%d-%s", safeName(providerName), time.Now().UnixMilli(), randomHex(3))
	if len(name) > 80 {
		name = name[:80]
	}
	return name
}

var safeNameRE = regexp.MustCompile(`[^a-z0-9_-]+`)

func safeName(value string) string {
	cleaned := strings.Trim(safeNameRE.ReplaceAllString(strings.ToLower(value), "-"), "-")
	if cleaned == "" {
		return "agent"
	}
	return cleaned
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func shellName(value string) (string, error) {
	if !envNameRE.MatchString(value) {
		return "", fmt.Errorf("invalid environment variable name: %s", value)
	}
	return value, nil
}

var ansiRE = regexp.MustCompile("\x1b\\[[0-9;]*m")

func stripAnsi(value string) string { return ansiRE.ReplaceAllString(value, "") }

func readOr(file, fallback string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return fallback
	}
	return string(data)
}

func randomHex(bytesLen int) string {
	buffer := make([]byte, bytesLen)
	if _, err := rand.Read(buffer); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buffer)
}

// randomUUID is a v4 UUID; the CLIs validate the shape of `--session-id`.
func randomUUID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return strings.Repeat("0", 8) + "-0000-4000-8000-" + randomHex(6)
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer)
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:32])
}
