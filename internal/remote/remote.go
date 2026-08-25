// Package remote manages SSH connections to saved machines: an encrypted,
// machine-bound host store plus a background connection manager, so the agent
// can plan in the current window and execute on a remote box.
//
// The host store lives at ~/.0xaf-re-agent/remote.json and is encrypted at rest
// with AES-256-GCM. The key is derived from the machine identity (macOS IOPlatformUUID
// or /etc/machine-id), the user's home directory, and a random salt file, so the
// ciphertext is not portable: copying remote.json alone does not reveal passwords.
package remote

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
)

// Host is one saved machine. Password lives inside the encrypted envelope only.
type Host struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	User     string `json:"user"`
	KeyPath  string `json:"keyPath,omitempty"`
	Password string `json:"password,omitempty"`
	// Insecure skips strict host-key verification (lab boxes only).
	Insecure bool `json:"insecure,omitempty"`
}

type plainStore struct {
	Hosts   []Host `json:"hosts"`
	Current string `json:"current,omitempty"`
}

type envelope struct {
	Version int    `json:"version"`
	Cipher  string `json:"cipher"` // aes-256-gcm
	Nonce   string `json:"nonce"`
	Data    string `json:"data"`
}

const storeVersion = 1

// ConfigDir is the per-user state directory shared with the rest of the app.
func ConfigDir() string {
	// Tests and portable installs override the location.
	if override := strings.TrimSpace(os.Getenv("OXAF_REMOTE_DIR")); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ".0xaf-re-agent"
	}
	return filepath.Join(home, ".0xaf-re-agent")
}

func storePath() string { return filepath.Join(ConfigDir(), "remote.json") }
func saltPath() string  { return filepath.Join(ConfigDir(), ".remote-salt") }

// Store is the encrypted host registry.
type Store struct {
	path string
	data plainStore
}

// Load reads and decrypts the store. A missing file yields an empty store.
func Load() (*Store, error) {
	return LoadFrom(storePath())
}

func LoadFrom(path string) (*Store, error) {
	store := &Store{path: path, data: plainStore{Hosts: []Host{}}}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return nil, err
	}
	key, err := machineKey()
	if err != nil {
		return nil, err
	}
	plain, err := decrypt(key, raw)
	if err != nil {
		return nil, fmt.Errorf("remote store: cannot decrypt %s: %w (wrong machine or corrupted file?)", path, err)
	}
	if err := json.Unmarshal(plain, &store.data); err != nil {
		return nil, fmt.Errorf("remote store: bad contents: %w", err)
	}
	if store.data.Hosts == nil {
		store.data.Hosts = []Host{}
	}
	return store, nil
}

// Save encrypts and writes the store with 0600 permissions.
func (s *Store) Save() error {
	plain, err := json.Marshal(s.data)
	if err != nil {
		return err
	}
	key, err := machineKey()
	if err != nil {
		return err
	}
	raw, err := encrypt(key, plain)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(s.path, raw, 0o600)
}

// Add upserts a host by name.
func (s *Store) Add(host Host) error {
	if host.Name == "" || host.Host == "" || host.User == "" {
		return errors.New("remote host needs name, host, and user")
	}
	for i := range s.data.Hosts {
		if s.data.Hosts[i].Name == host.Name {
			s.data.Hosts[i] = host
			return nil
		}
	}
	s.data.Hosts = append(s.data.Hosts, host)
	return nil
}

// Remove deletes a host; returns false when it did not exist.
func (s *Store) Remove(name string) bool {
	for i := range s.data.Hosts {
		if s.data.Hosts[i].Name == name {
			s.data.Hosts = append(s.data.Hosts[:i], s.data.Hosts[i+1:]...)
			if s.data.Current == name {
				s.data.Current = ""
			}
			return true
		}
	}
	return false
}

func (s *Store) List() []Host {
	out := append([]Host{}, s.data.Hosts...)
	return out
}

func (s *Store) Get(name string) (*Host, bool) {
	for i := range s.data.Hosts {
		if s.data.Hosts[i].Name == name {
			host := s.data.Hosts[i]
			return &host, true
		}
	}
	return nil, false
}

func (s *Store) Current() string { return s.data.Current }

func (s *Store) SetCurrent(name string) {
	if name == "" {
		s.data.Current = ""
		return
	}
	for _, host := range s.data.Hosts {
		if host.Name == name {
			s.data.Current = name
			return
		}
	}
}

// --- encryption --------------------------------------------------------------

// machineKey derives the AES-256 key from machine identity + home + salt.
// OXAF_REMOTE_KEY (base64, 32 bytes) overrides it.
func machineKey() ([]byte, error) {
	if override := strings.TrimSpace(os.Getenv("OXAF_REMOTE_KEY")); override != "" {
		decoded, err := base64.StdEncoding.DecodeString(override)
		if err != nil || len(decoded) != 32 {
			return nil, errors.New("OXAF_REMOTE_KEY must be base64 of 32 bytes")
		}
		return decoded, nil
	}
	identity := machineID()
	home, _ := os.UserHomeDir()
	userName := "unknown"
	if current, err := user.Current(); err == nil {
		userName = current.Username
	}
	salt, err := loadOrCreateSalt()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(identity + "\n" + home + "\n" + userName + "\n" + salt))
	return sum[:], nil
}

func loadOrCreateSalt() (string, error) {
	if data, err := os.ReadFile(saltPath()); err == nil && len(data) >= 16 {
		return string(data), nil
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return "", err
	}
	value := base64.RawStdEncoding.EncodeToString(buf)
	if err := os.WriteFile(saltPath(), []byte(value), 0o600); err != nil {
		return "", err
	}
	return value, nil
}

func machineID() string {
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").CombinedOutput(); err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, "IOPlatformUUID") {
					parts := strings.SplitN(line, "=", 2)
					if len(parts) == 2 {
						return strings.TrimSpace(strings.Trim(parts[1], `"`))
					}
				}
			}
		}
	}
	if data, err := os.ReadFile("/etc/machine-id"); err == nil {
		return strings.TrimSpace(string(data))
	}
	hostname, _ := os.Hostname()
	return hostname
}

func encrypt(key, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	sealed := aead.Seal(nil, nonce, plain, nil)
	return json.Marshal(envelope{
		Version: storeVersion,
		Cipher:  "aes-256-gcm",
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Data:    base64.StdEncoding.EncodeToString(sealed),
	})
}

func decrypt(key, raw []byte) ([]byte, error) {
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	if env.Version != storeVersion || env.Cipher != "aes-256-gcm" {
		return nil, fmt.Errorf("unsupported envelope v%d %q", env.Version, env.Cipher)
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return aead.Open(nil, nonce, data, nil)
}
