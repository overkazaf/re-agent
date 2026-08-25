package remote

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreRoundTrip(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "remote.json")
	store, err := LoadFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Add(Host{
		Name: "lab", Host: "10.0.0.5", Port: 2222, User: "root",
		KeyPath: "~/.ssh/id_ed25519",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Add(Host{
		Name: "srv", Host: "srv.local", User: "dev", Password: "s3cret",
	}); err != nil {
		t.Fatal(err)
	}
	store.SetCurrent("lab")
	if err := store.Save(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "s3cret") || strings.Contains(string(raw), "10.0.0.5") {
		t.Fatal("store is not encrypted at rest")
	}

	reloaded, err := LoadFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := reloaded.Get("srv"); !ok || got.Password != "s3cret" {
		t.Fatalf("password did not survive the round trip: %+v", got)
	}
	if reloaded.Current() != "lab" {
		t.Fatalf("current host lost: %q", reloaded.Current())
	}
	if !reloaded.Remove("lab") || reloaded.Current() != "" {
		t.Fatal("remove should clear the current host")
	}
}

func TestStoreTamperDetected(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "remote.json")
	store, _ := LoadFrom(path)
	_ = store.Add(Host{Name: "a", Host: "h", User: "u"})
	if err := store.Save(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	raw[len(raw)-3] ^= 0xff // flip a byte inside the ciphertext
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFrom(path); err == nil {
		t.Fatal("tampered store should fail to decrypt")
	}
}

func TestStoreMachineKeyOverride(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "remote.json")
	t.Setenv("OXAF_REMOTE_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") // 32 bytes
	store, _ := LoadFrom(path)
	_ = store.Add(Host{Name: "a", Host: "h", User: "u"})
	if err := store.Save(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OXAF_REMOTE_KEY", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=")
	if _, err := LoadFrom(path); err == nil {
		t.Fatal("a different key must not decrypt the store")
	}
}
