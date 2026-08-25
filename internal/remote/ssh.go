package remote

// The connection manager: each saved host gets one persistent ssh.Client that
// is dialed lazily and reused for every command, so a session holds a
// background connection instead of paying the handshake per command. Close()
// tears everything down when the app exits.

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

// DialTimeout bounds the TCP + SSH handshake.
const dialTimeout = 12 * time.Second

// Manager owns the persistent connections.
type Manager struct {
	store   *Store
	mu      sync.Mutex
	clients map[string]*ssh.Client
}

func NewManager(store *Store) *Manager {
	return &Manager{store: store, clients: map[string]*ssh.Client{}}
}

// Current reports the store's current host, used by tools as the default target.
func (m *Manager) Current() string {
	return m.store.Current()
}

// Run executes command on the named host (or the store's current host when name
// is empty) and returns combined stdout+stderr. It reuses the background
// connection, dialing it on first use.
func (m *Manager) Run(ctx context.Context, name, command string) (string, error) {
	hostName := name
	if hostName == "" {
		hostName = m.store.Current()
	}
	if hostName == "" {
		return "", errors.New("no remote host selected: use /remote use <name> or --remote <name>")
	}
	host, ok := m.store.Get(hostName)
	if !ok {
		return "", fmt.Errorf("remote host not found: %s", hostName)
	}
	client, err := m.client(ctx, *host)
	if err != nil {
		return "", err
	}
	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer session.Close()

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
		if res.err != nil {
			if exitErr, ok := res.err.(*ssh.ExitError); ok {
				return res.out, fmt.Errorf("remote exit %d: %s", exitErr.ExitStatus(), strings.TrimSpace(res.out))
			}
			return res.out, res.err
		}
		return res.out, nil
	}
}

func (m *Manager) client(ctx context.Context, host Host) (*ssh.Client, error) {
	m.mu.Lock()
	if client, ok := m.clients[host.Name]; ok {
		m.mu.Unlock()
		return client, nil
	}
	m.mu.Unlock()

	config, err := clientConfig(host)
	if err != nil {
		return nil, err
	}
	address := net.JoinHostPort(host.Host, fmt.Sprintf("%d", defaultPort(host.Port)))
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	type dialResult struct {
		client *ssh.Client
		err    error
	}
	done := make(chan dialResult, 1)
	go func() {
		client, err := ssh.Dial("tcp", address, config)
		done <- dialResult{client: client, err: err}
	}()
	var client *ssh.Client
	select {
	case <-dialCtx.Done():
		return nil, fmt.Errorf("ssh dial %s: %w", address, dialCtx.Err())
	case res := <-done:
		if res.err != nil {
			return nil, fmt.Errorf("ssh dial %s: %w", address, res.err)
		}
		client = res.client
	}

	m.mu.Lock()
	m.clients[host.Name] = client
	m.mu.Unlock()
	return client, nil
}

// Close terminates every background connection.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, client := range m.clients {
		_ = client.Close()
		delete(m.clients, name)
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
		Timeout:         dialTimeout,
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
