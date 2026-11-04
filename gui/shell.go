package main

// ShellManager runs interactive PTY shells for the GUI's terminal panel.
// Each shell is one child $SHELL on a pseudo-terminal rooted at a workspace;
// output batches through the gui:shell event channel. Bytes ride base64 —
// PTY output is not guaranteed UTF-8 (hexdumps, latin-1 artifacts), and
// xterm.js writes raw bytes happily.

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

const (
	shellChannel  = "gui:shell"
	shellBatch    = 8192 // flush once the batch reaches this many bytes
	shellBatchLat = 16 * time.Millisecond
)

// ShellInfo is one live shell in the sidebar list.
type ShellInfo struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
	PID int    `json:"pid"`
}

// ShellEnvelope is the gui:shell payload.
type ShellEnvelope struct {
	ShellID string `json:"shellId"`
	Kind    string `json:"kind"` // data | exit
	B64     string `json:"b64"`  // base64 PTY bytes (kind=data)
	Code    int    `json:"code"` // child exit status (kind=exit)
}

type shellSession struct {
	id     string
	cwd    string
	tty    *os.File
	cmd    *exec.Cmd
	mgr    *ShellManager
	mu     sync.Mutex // guards out — pump appends while flusher drains
	out    []byte
	done   chan struct{} // closed when pump exits (stops the flusher)
	closed bool
}

// ShellManager owns every PTY shell. Zero state survives a restart by design:
// shells are disposable, sessions are the durable unit.
type ShellManager struct {
	mu     sync.Mutex
	shells map[string]*shellSession
	seq    int
	emit   func(ShellEnvelope)
}

func NewShellManager() *ShellManager {
	return &ShellManager{shells: map[string]*shellSession{}}
}

// SetEmit wires the runtime event sink; called once the wails ctx exists.
func (m *ShellManager) SetEmit(emit func(ShellEnvelope)) {
	m.mu.Lock()
	m.emit = emit
	m.mu.Unlock()
}

// Start spawns an interactive login shell rooted at cwd ("" / "." → $HOME,
// "~" expanded — same rules as a session workspace).
func (m *ShellManager) Start(cwd string) (ShellInfo, error) {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" || cwd == "." {
		cwd = guiHomeDir()
	}
	if cwd == "~" || strings.HasPrefix(cwd, "~/") {
		if home, homeErr := os.UserHomeDir(); homeErr == nil {
			cwd = strings.TrimSuffix(home, "/") + strings.TrimPrefix(cwd, "~")
		}
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return ShellInfo{}, fmt.Errorf("shell cwd is not a directory: %s", cwd)
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		if runtime.GOOS == "windows" {
			shell = "cmd.exe"
		} else {
			shell = "/bin/zsh"
		}
	}
	cmd := exec.Command(shell, "-l", "-i")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	tty, err := pty.Start(cmd)
	if err != nil {
		return ShellInfo{}, fmt.Errorf("pty start failed: %w", err)
	}

	m.mu.Lock()
	m.seq++
	id := fmt.Sprintf("sh-%d", m.seq)
	s := &shellSession{id: id, cwd: cwd, tty: tty, cmd: cmd, mgr: m, out: make([]byte, 0, shellBatch), done: make(chan struct{})}
	m.shells[id] = s
	m.mu.Unlock()

	go m.pump(s)
	go m.flusher(s)
	go m.reap(s, id)
	return ShellInfo{ID: id, Cwd: cwd, PID: cmd.Process.Pid}, nil
}

// pump reads the PTY into the pending batch, flushing immediately only when a
// batch fills. When reads stall (shell thinking, output burst over) the
// flusher's ticker drains the tail — a Read can block indefinitely, so the
// batch deadline can never ride on the next read returning.
func (m *ShellManager) pump(s *shellSession) {
	defer close(s.done)
	buf := make([]byte, 4096)
	for {
		n, readErr := s.tty.Read(buf)
		if n > 0 {
			s.mu.Lock()
			s.out = append(s.out, buf[:n]...)
			var payload []byte
			if len(s.out) >= shellBatch {
				payload = s.out
				s.out = make([]byte, 0, shellBatch)
				s.emitLocked(payload)
			}
			s.mu.Unlock()
		}
		if readErr != nil {
			// EOF/EIO once the master closes — drain whatever is pending and
			// let reap report the exit
			s.mu.Lock()
			payload := s.out
			s.out = nil
			s.emitLocked(payload)
			s.mu.Unlock()
			return
		}
	}
}

// flusher drains the partial batch on the batch deadline.
func (m *ShellManager) flusher(s *shellSession) {
	ticker := time.NewTicker(shellBatchLat)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			if len(s.out) > 0 {
				payload := s.out
				s.out = make([]byte, 0, shellBatch)
				s.emitLocked(payload)
			}
			s.mu.Unlock()
		}
	}
}

func (m *ShellManager) reap(s *shellSession, id string) {
	err := s.cmd.Wait()
	code := 0
	if err != nil {
		code = 1
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
	}
	_ = s.tty.Close() // unblocks a pending Read in pump, if any

	m.mu.Lock()
	delete(m.shells, id)
	emit := m.emit
	m.mu.Unlock()
	if emit != nil {
		emit(ShellEnvelope{ShellID: id, Kind: "exit", Code: code})
	}
}

// emitLocked sends one batch; s.mu must be held so batches cross the wire in
// read order (a terminal stream that swaps two chunks is a garbled screen).
func (s *shellSession) emitLocked(payload []byte) {
	if len(payload) == 0 {
		return
	}
	s.mgr.mu.Lock()
	emit := s.mgr.emit
	s.mgr.mu.Unlock()
	if emit == nil {
		return
	}
	emit(ShellEnvelope{ShellID: s.id, Kind: "data", B64: base64.StdEncoding.EncodeToString(payload)})
}

// Write sends user keystrokes to the PTY.
func (m *ShellManager) Write(id, data string) error {
	m.mu.Lock()
	s := m.shells[id]
	m.mu.Unlock()
	if s == nil {
		return fmt.Errorf("unknown shell: %s", id)
	}
	_, err := s.tty.Write([]byte(data))
	return err
}

// Resize mirrors the xterm viewport into the PTY winsize.
func (m *ShellManager) Resize(id string, cols, rows int) error {
	m.mu.Lock()
	s := m.shells[id]
	m.mu.Unlock()
	if s == nil {
		return fmt.Errorf("unknown shell: %s", id)
	}
	if cols < 2 || rows < 2 || cols > 1000 || rows > 500 {
		return fmt.Errorf("unreasonable terminal size: %dx%d", cols, rows)
	}
	return pty.Setsize(s.tty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Stop kills the shell's process; reap cleans up and emits the exit event.
func (m *ShellManager) Stop(id string) error {
	m.mu.Lock()
	s := m.shells[id]
	m.mu.Unlock()
	if s == nil {
		return fmt.Errorf("unknown shell: %s", id)
	}
	if s.cmd.Process != nil {
		return s.cmd.Process.Kill()
	}
	return nil
}

// List snapshots the live shells (sidebar render).
func (m *ShellManager) List() []ShellInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]ShellInfo, 0, len(m.shells))
	for _, s := range m.shells {
		pid := 0
		if s.cmd.Process != nil {
			pid = s.cmd.Process.Pid
		}
		out = append(out, ShellInfo{ID: s.id, Cwd: s.cwd, PID: pid})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// StopAll kills every shell — the app shutdown path. reap goroutines clean up
// the map; no Wait here — shutdown is best-effort.
func (m *ShellManager) StopAll() {
	m.mu.Lock()
	processes := make([]*os.Process, 0, len(m.shells))
	for _, s := range m.shells {
		if s.cmd.Process != nil {
			processes = append(processes, s.cmd.Process)
		}
	}
	m.mu.Unlock()
	for _, p := range processes {
		_ = p.Kill()
	}
}
