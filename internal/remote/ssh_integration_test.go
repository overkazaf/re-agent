package remote

// A real wire-protocol test: a throwaway SSH server (x/crypto/ssh) runs inside
// the test on a loopback port, and the Manager connects to it with password
// auth, executes a command, and reads the output back. This exercises the full
// client path (dial, handshake, auth, exec) without needing an external sshd.

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"os/exec"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func startTestSSHServer(t *testing.T) (port int, closeFn func()) {
	t.Helper()
	config := &ssh.ServerConfig{
		PasswordCallback: func(metadata ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if metadata.User() == "user" && string(password) == "pass" {
				return nil, nil
			}
			return nil, errors.New("bad credentials")
		},
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveSSHConn(conn, config)
		}
	}()
	port = listener.Addr().(*net.TCPAddr).Port
	return port, func() {
		_ = listener.Close()
		<-done
	}
}

func serveSSHConn(conn net.Conn, config *ssh.ServerConfig) {
	_, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go func(channel ssh.Channel, requests <-chan *ssh.Request) {
			defer channel.Close()
			pty := false
			for request := range requests {
				switch request.Type {
				case "pty-req":
					pty = true
					_ = request.Reply(true, nil)
				case "exec":
					var payload struct{ Command string }
					if err := ssh.Unmarshal(request.Payload, &payload); err != nil {
						_ = request.Reply(false, nil)
						return
					}
					_ = request.Reply(true, nil)
					var out []byte
					if pty {
						// Give the child a real TTY (script allocates one), so the
						// client's `ssh -tt` request is honoured end to end.
						out, _ = scriptCommand(payload.Command).CombinedOutput()
					} else {
						out, _ = exec.Command("sh", "-c", payload.Command).CombinedOutput()
					}
					_, _ = channel.Write(out)
					_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
					return
				case "shell":
					_ = request.Reply(true, nil)
				default:
					_ = request.Reply(false, nil)
				}
			}
		}(channel, channelRequests)
	}
}

// scriptCommand runs a command through the system `script` utility, which
// allocates a PTY for the child — the same effect sshd gives a pty-req.
func scriptCommand(command string) *exec.Cmd {
	if runtime.GOOS == "darwin" {
		return exec.Command("script", "-q", "/dev/null", "sh", "-c", command)
	}
	return exec.Command("script", "-qec", command)
}

func TestManagerRunsCommandsOverRealSSH(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	port, closeServer := startTestSSHServer(t)
	defer closeServer()

	dir := t.TempDir()
	store, err := LoadFrom(dir + "/remote.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Add(Host{
		Name: "loop", Host: "127.0.0.1", Port: port, User: "user",
		Password: "pass", Insecure: true,
	}); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(store)
	defer manager.Close()

	out, err := manager.Run(t.Context(), "loop", "echo hello-remote && printf world")
	if err != nil {
		t.Fatalf("run over ssh: %v", err)
	}
	if out != "hello-remote\nworld" {
		t.Fatalf("unexpected output: %q", out)
	}

	// The connection is reused: the second command skips a new handshake.
	if out, err := manager.Run(t.Context(), "loop", "echo again"); err != nil || out != "again\n" {
		t.Fatalf("second run: out=%q err=%v", out, err)
	}
}

func TestManagerRejectsBadCredentials(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	port, closeServer := startTestSSHServer(t)
	defer closeServer()

	store, _ := LoadFrom(t.TempDir() + "/remote.json")
	_ = store.Add(Host{Name: "loop", Host: "127.0.0.1", Port: port, User: "user", Password: "wrong", Insecure: true})
	manager := NewManager(store)
	defer manager.Close()

	if _, err := manager.Run(t.Context(), "loop", "echo nope"); err == nil {
		t.Fatal("bad password should fail the handshake")
	}
}

func TestManagerRunPtyAllocatesATerminal(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	port, closeServer := startTestSSHServer(t)
	defer closeServer()

	store, _ := LoadFrom(t.TempDir() + "/remote.json")
	_ = store.Add(Host{Name: "loop", Host: "127.0.0.1", Port: port, User: "user", Password: "pass", Insecure: true})
	manager := NewManager(store)
	defer manager.Close()

	// `test -t 1` reports whether stdout is a TTY: with RunPty it must succeed.
	out, err := manager.RunPty(t.Context(), "loop", "test -t 1 && echo has-tty || echo no-tty", 80, 24)
	if err != nil {
		t.Fatalf("runpty: %v", err)
	}
	if !strings.Contains(out, "has-tty") {
		t.Fatalf("expected a PTY to be allocated, got: %q", out)
	}
}

func TestManagerTracksConnectedPeers(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	port, closeServer := startTestSSHServer(t)
	defer closeServer()

	store, _ := LoadFrom(t.TempDir() + "/remote.json")
	_ = store.Add(Host{Name: "loop", Host: "127.0.0.1", Port: port, User: "user", Password: "pass", Insecure: true})
	manager := NewManager(store)
	defer manager.Close()

	if manager.Connected("loop") {
		t.Fatal("not connected before first use")
	}
	if _, err := manager.Run(t.Context(), "loop", "true"); err != nil {
		t.Fatal(err)
	}
	if !manager.Connected("loop") {
		t.Fatal("connection should be tracked after first run")
	}
	peers := manager.Peers()
	if len(peers) != 1 || peers[0] != "loop" {
		t.Fatalf("unexpected peers: %+v", peers)
	}
	// Explicit Connect is idempotent.
	if err := manager.Connect(t.Context(), "loop"); err != nil {
		t.Fatalf("reconnect should be a no-op: %v", err)
	}
}
