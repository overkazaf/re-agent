package tools

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
)

type CommandResult struct {
	Code   int
	Stdout string
	Stderr string
}

type RunOptions struct {
	Cwd       string
	TimeoutMs int
	Env       []string
	Ctx       context.Context
}

// Run executes a command, capturing both streams. The caller's context is
// honoured so the operator's ^C reaches the child too — otherwise an
// interrupted turn leaves a long `strings`/`objdump` running until its timeout.
func Run(command []string, options RunOptions) (CommandResult, error) {
	result, err := Stream(command, StreamOptions{
		Cwd:       options.Cwd,
		TimeoutMs: options.TimeoutMs,
		Env:       options.Env,
		Ctx:       options.Ctx,
	})
	return CommandResult{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}, err
}

type StreamedResult struct {
	CommandResult
	// TimedOut: the command exceeded TimeoutMs and was killed.
	TimedOut bool
	// Aborted: the caller's context fired (^C in the REPL) and the child was killed.
	Aborted bool
}

type StreamOptions struct {
	Cwd       string
	TimeoutMs int
	Env       []string
	Ctx       context.Context
	// OnChunk is called with each decoded chunk as it arrives, for live echoing.
	OnChunk func(stream string, text string)
}

// ResolveShell returns a usable command shell for workspace shell escapes,
// run_command, and CLI runner scripts. Prefer stable system locations before
// PATH so a stale Homebrew-style bash symlink cannot shadow /bin/bash.
func ResolveShell() (string, error) {
	return resolveShellFrom(defaultShellCandidates())
}

func defaultShellCandidates() []string {
	candidates := []string{}
	if override := strings.TrimSpace(os.Getenv("OXAF_RE_SHELL")); override != "" {
		candidates = append(candidates, override)
	}
	candidates = append(candidates,
		"/bin/bash",
		"/usr/bin/bash",
		"/opt/homebrew/bin/bash",
		"/usr/local/bin/bash",
		"bash",
	)
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		candidates = append(candidates, shell)
	}
	candidates = append(candidates,
		"/bin/zsh",
		"/usr/bin/zsh",
		"zsh",
		"/bin/sh",
		"/usr/bin/sh",
		"sh",
	)
	return candidates
}

func resolveShellFrom(candidates []string) (string, error) {
	seen := map[string]bool{}
	tried := []string{}
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || seen[candidate] {
			continue
		}
		seen[candidate] = true
		tried = append(tried, candidate)
		path, ok := resolveExecutable(candidate)
		if ok {
			return path, nil
		}
	}
	if len(tried) == 0 {
		return "", fmt.Errorf("no usable shell found")
	}
	return "", fmt.Errorf("no usable shell found (tried %s)", strings.Join(tried, ", "))
}

func resolveExecutable(candidate string) (string, bool) {
	if strings.Contains(candidate, "/") {
		if isExecutableFile(candidate) {
			return candidate, true
		}
		return "", false
	}
	path, err := exec.LookPath(candidate)
	if err != nil {
		return "", false
	}
	if isExecutableFile(path) {
		return path, true
	}
	return "", false
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}

// ShellCommand builds argv for running a command through the resolved shell.
func ShellCommand(command string) ([]string, error) {
	shell, err := ResolveShell()
	if err != nil {
		return nil, err
	}
	return []string{shell, "-c", command}, nil
}

// Stream is Run with output handed to the caller as it arrives instead of only
// at exit, so a long command narrates itself. The full text is still captured.
func Stream(command []string, options StreamOptions) (StreamedResult, error) {
	if len(command) == 0 {
		return StreamedResult{}, fmt.Errorf("empty command")
	}
	parent := options.Ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = options.Cwd
	if options.Env != nil {
		cmd.Env = options.Env
	}
	// A process group lets a killed child shell take its children with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return StreamedResult{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return StreamedResult{}, err
	}
	if err := cmd.Start(); err != nil {
		// A context that fired before the child existed is an outcome, not a
		// failure: report it the same way a killed child is reported.
		if parent.Err() != nil {
			return StreamedResult{CommandResult: CommandResult{Code: 130}, Aborted: true}, nil
		}
		return StreamedResult{}, err
	}

	var (
		mu       sync.Mutex
		timedOut bool
	)
	if options.TimeoutMs > 0 {
		timer := time.AfterFunc(time.Duration(options.TimeoutMs)*time.Millisecond, func() {
			mu.Lock()
			timedOut = true
			mu.Unlock()
			cancel()
		})
		defer timer.Stop()
	}

	var wg sync.WaitGroup
	var outBuf, errBuf bytes.Buffer
	// stdout and stderr are pumped concurrently, so the callback is serialized
	// here rather than in every caller: the REPL's stream writer keeps
	// per-stream line buffers in a map, and two goroutines writing it would be
	// a crash, not merely a race.
	var emit sync.Mutex
	pump := func(reader io.Reader, buffer *bytes.Buffer, name string) {
		defer wg.Done()
		chunk := make([]byte, 8192)
		for {
			read, err := reader.Read(chunk)
			if read > 0 {
				emit.Lock()
				buffer.Write(chunk[:read])
				if options.OnChunk != nil {
					options.OnChunk(name, string(chunk[:read]))
				}
				emit.Unlock()
			}
			if err != nil {
				// A killed child (timeout or ^C) tears the pipe down mid-read;
				// whatever was already decoded is still worth returning.
				return
			}
		}
	}
	wg.Add(2)
	go pump(stdout, &outBuf, "stdout")
	go pump(stderr, &errBuf, "stderr")
	wg.Wait()

	code := 0
	if err := cmd.Wait(); err != nil {
		var exitErr *exec.ExitError
		if ok := asExitError(err, &exitErr); ok {
			code = exitErr.ExitCode()
		} else {
			code = 1
		}
	}
	mu.Lock()
	killedByTimeout := timedOut
	mu.Unlock()
	aborted := parent.Err() != nil

	return StreamedResult{
		CommandResult: CommandResult{Code: code, Stdout: outBuf.String(), Stderr: errBuf.String()},
		TimedOut:      killedByTimeout,
		Aborted:       aborted && !killedByTimeout,
	}, nil
}

func asExitError(err error, target **exec.ExitError) bool {
	for err != nil {
		if typed, ok := err.(*exec.ExitError); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

// CommandText is the transcript rendering of one command run: header, exit
// code, streams.
func CommandText(name string, result CommandResult) string {
	parts := []string{fmt.Sprintf("$ %s", name), fmt.Sprintf("exit=%d", result.Code)}
	if result.Stdout != "" {
		parts = append(parts, fmt.Sprintf("\nstdout:\n%s", result.Stdout))
	}
	if result.Stderr != "" {
		parts = append(parts, fmt.Sprintf("\nstderr:\n%s", result.Stderr))
	}
	return strings.Join(parts, "\n")
}

func CommandOutput(name string, result CommandResult) []types.ContentBlock {
	return []types.ContentBlock{types.TextBlock(CommandText(name, result))}
}
