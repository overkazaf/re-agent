package remote

// The connection manager: each saved host gets one persistent background
// ssh.Client that is dialed explicitly (`Connect`) or lazily on first use, kept
// alive with periodic keepalives, and reused for every command. Close() tears
// everything down when the app exits.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

const (
	// DialTimeout bounds the TCP + SSH handshake.
	DialTimeout = 12 * time.Second
	// keepAliveEvery is how often an idle connection proves itself alive, so a
	// NAT or a server timeout cannot silently kill the background session.
	keepAliveEvery = 30 * time.Second
)

// Manager owns the persistent connections.
type Manager struct {
	store *Store
	mu    sync.Mutex
	conns map[string]*connState
}

type connState struct {
	client        *ssh.Client
	connectedAt   time.Time
	err           error
	stopKeepAlive chan struct{}
}

func NewManager(store *Store) *Manager {
	return &Manager{store: store, conns: map[string]*connState{}}
}

// Current reports the store's current host, used by tools as the default target.
func (m *Manager) Current() string {
	return m.store.Current()
}

// Connect dials name now and keeps it alive in the background. It is idempotent:
// an already-connected host is a no-op. The dial is bounded by DialTimeout.
func (m *Manager) Connect(ctx context.Context, name string) error {
	host, ok := m.store.Get(name)
	if !ok {
		return fmt.Errorf("remote host not found: %s", name)
	}
	m.mu.Lock()
	if state, exists := m.conns[name]; exists && state.client != nil {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	config, err := clientConfig(*host)
	if err != nil {
		return err
	}
	address := net.JoinHostPort(host.Host, fmt.Sprintf("%d", defaultPort(host.Port)))
	client, err := ssh.Dial("tcp", address, config)
	if err != nil {
		m.mu.Lock()
		m.conns[name] = &connState{err: err}
		m.mu.Unlock()
		return fmt.Errorf("ssh dial %s: %w", address, err)
	}
	state := &connState{client: client, connectedAt: time.Now(), stopKeepAlive: make(chan struct{})}
	m.mu.Lock()
	m.conns[name] = state
	m.mu.Unlock()
	go m.keepAlive(name, state)
	return nil
}

// Connected reports whether name has an established background connection.
func (m *Manager) Connected(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.conns[name]
	return ok && state.client != nil
}

// Peers returns the names of hosts with an established connection.
func (m *Manager) Peers() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for name, state := range m.conns {
		if state.client != nil {
			out = append(out, name)
		}
	}
	return out
}

// Run executes command on the named host (or the store's current host when name
// is empty) and returns combined stdout+stderr. It reuses the background
// connection, dialing it on first use.
func (m *Manager) Run(ctx context.Context, name, command string) (string, error) {
	host, err := m.resolveHost(name)
	if err != nil {
		return "", err
	}
	client, err := m.client(ctx, *host)
	if err != nil {
		return "", err
	}
	return runOnClient(ctx, client, command, false, 0, 0)
}

// RunPty is Run with an allocated remote PTY (`ssh -tt` semantics): interactive
// tools, sudo prompts, and anything that needs a terminal get one. Output is
// normalized (CRLF -> LF) so the transcript stays clean.
func (m *Manager) RunPty(ctx context.Context, name, command string, cols, rows int) (string, error) {
	host, err := m.resolveHost(name)
	if err != nil {
		return "", err
	}
	client, err := m.client(ctx, *host)
	if err != nil {
		return "", err
	}
	return runOnClient(ctx, client, command, true, cols, rows)
}

func (m *Manager) resolveHost(name string) (*Host, error) {
	hostName := name
	if hostName == "" {
		hostName = m.store.Current()
	}
	if hostName == "" {
		return nil, errors.New("no remote host selected: use /remote use <name> or --remote <name>")
	}
	host, ok := m.store.Get(hostName)
	if !ok {
		return nil, fmt.Errorf("remote host not found: %s", hostName)
	}
	return host, nil
}

func runOnClient(ctx context.Context, client *ssh.Client, command string, pty bool, cols, rows int) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer session.Close()

	if pty {
		if cols < 2 {
			cols = 80
		}
		if rows < 2 {
			rows = 24
		}
		if err := session.RequestPty("xterm-256color", cols, rows, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
			return "", fmt.Errorf("ssh pty: %w", err)
		}
	}
	type result struct {
		out string
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := session.CombinedOutput(command)
		done <- result{out: string(out), err: err}
	}()
	select {
	case <-ctx.Done():
		_ = session.Close()
		return "", ctx.Err()
	case res := <-done:
		normalized := strings.ReplaceAll(res.out, "\r\n", "\n")
		if res.err != nil {
			if exitErr, ok := res.err.(*ssh.ExitError); ok {
				return normalized, fmt.Errorf("remote exit %d: %s", exitErr.ExitStatus(), strings.TrimSpace(normalized))
			}
			return normalized, res.err
		}
		return normalized, nil
	}
}

func (m *Manager) client(ctx context.Context, host Host) (*ssh.Client, error) {
	m.mu.Lock()
	if state, ok := m.conns[host.Name]; ok {
		client := state.client
		err := state.err
		m.mu.Unlock()
		if client != nil {
			return client, nil
		}
		return nil, fmt.Errorf("ssh %s: %w", host.Name, err)
	}
	m.mu.Unlock()

	// Lazy dial on first use (also records the connection for the status bar).
	if err := m.Connect(ctx, host.Name); err != nil {
		return nil, err
	}
	return m.client(ctx, host)
}

// Close terminates every background connection.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, state := range m.conns {
		if state.stopKeepAlive != nil {
			close(state.stopKeepAlive)
		}
		if state.client != nil {
			_ = state.client.Close()
		}
		delete(m.conns, name)
	}
}

// keepAlive keeps an idle connection from being dropped by a NAT or a server
// idle timeout, and marks the connection dead when the wire actually breaks.
func (m *Manager) keepAlive(name string, state *connState) {
	ticker := time.NewTicker(keepAliveEvery)
	defer ticker.Stop()
	for {
		select {
		case <-state.stopKeepAlive:
			return
		case <-ticker.C:
			_, _, err := state.client.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				m.mu.Lock()
				state.err = err
				if state.client != nil {
					_ = state.client.Close()
					state.client = nil
				}
				m.mu.Unlock()
				return
			}
		}
	}
}

func defaultPort(port int) int {
	if port <= 0 {
		return 22
	}
	return port
}

func clientConfig(host Host) (*ssh.ClientConfig, error) {
	auth := []ssh.AuthMethod{}
	if host.KeyPath != "" {
		keyPath, err := expandHome(host.KeyPath)
		if err != nil {
			return nil, err
		}
		key, err := os.ReadFile(keyPath)
		if err == nil {
			if signer, parseErr := ssh.ParsePrivateKey(key); parseErr == nil {
				auth = append(auth, ssh.PublicKeys(signer))
			}
		}
	}
	// ssh-agent takes priority when the private key was unreadable or absent.
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if agentConn, err := net.Dial("unix", sock); err == nil {
			auth = append(auth, ssh.PublicKeysCallback(agent.NewClient(agentConn).Signers))
		}
	}
	if host.Password != "" {
		auth = append(auth, ssh.Password(host.Password))
	}
	if len(auth) == 0 {
		return nil, fmt.Errorf("no auth method for %s: add a key path, a password, or run ssh-agent", host.Name)
	}

	callback, err := hostKeyCallback(host)
	if err != nil {
		return nil, err
	}
	return &ssh.ClientConfig{
		User:            host.User,
		Auth:            auth,
		HostKeyCallback: callback,
		Timeout:         DialTimeout,
	}, nil
}

func hostKeyCallback(host Host) (ssh.HostKeyCallback, error) {
	if host.Insecure {
		return ssh.InsecureIgnoreHostKey(), nil
	}
	knownHostsPath, err := expandHome("~/.ssh/known_hosts")
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(knownHostsPath); err != nil {
		return nil, fmt.Errorf(
			"strict host-key verification needs %s; add the host key there, or mark the host --insecure for lab boxes",
			knownHostsPath,
		)
	}
	return knownhosts.New(knownHostsPath)
}

func expandHome(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if path == "~" {
			return home, nil
		}
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}
