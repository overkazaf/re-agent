package tools

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestBuildBinaryTerrainCarvesAntiAndDiffs(t *testing.T) {
	dir := t.TempDir()

	// Synthesize a carrier binary with anti-debug string, high-entropy tail, and embedded ZIP/PDF.
	var buf bytes.Buffer
	buf.WriteString("0xAF_HEADER_DEMO\x00")
	buf.WriteString("check_ptrace_and_frida-agent_27042\x00")
	buf.Write(bytes.Repeat([]byte{0x90}, 64))
	buf.WriteString("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n")
	buf.Write(bytes.Repeat([]byte{0x00}, 32))
	buf.Write([]byte{'P', 'K', 0x03, 0x04, 0x14, 0x00, 0x00, 0x00})
	// High-entropy block (2x all 256 byte values -> ~8.0 b/B across multiple buckets)
	for rep := 0; rep < 2; rep++ {
		for i := 0; i < 256; i++ {
			buf.WriteByte(byte(i))
		}
	}

	origPath := filepath.Join(dir, "sample.bin")
	if err := os.WriteFile(origPath, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	patched := append([]byte(nil), buf.Bytes()...)
	// Apply a 6-byte x86 `mov eax, 1; ret` patch at offset 0x40.
	copy(patched[0x40:0x46], []byte{0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3})
	patchedPath := filepath.Join(dir, "sample_patched.bin")
	if err := os.WriteFile(patchedPath, patched, 0o644); err != nil {
		t.Fatal(err)
	}

	files := ListWorkspaceFiles(dir, 20)
	if len(files) != 2 {
		t.Fatalf("expected 2 workspace files, got %d", len(files))
	}

	policy := &types.ExecutionPolicy{MaxReadBytes: 128 * 1024}
	terrain, err := BuildBinaryTerrain(dir, "sample.bin", "sample_patched.bin", policy)
	if err != nil {
		t.Fatalf("BuildBinaryTerrain: %v", err)
	}
	if terrain.Size != int64(buf.Len()) || terrain.SHA256 == "" {
		t.Fatalf("unexpected size/hash: %+v", terrain)
	}
	if len(terrain.Entropy) == 0 || terrain.MaxEntropy < 6.0 {
		t.Fatalf("expected entropy buckets with high-entropy peak, got max=%.2f", terrain.MaxEntropy)
	}
	if len(terrain.Carves) < 2 {
		t.Fatalf("expected at least 2 carved signatures (PDF + ZIP), got %d", len(terrain.Carves))
	}
	if len(terrain.Anti) < 2 {
		t.Fatalf("expected anti-analysis hits (ptrace + frida-agent), got %d", len(terrain.Anti))
	}
	if len(terrain.Diffs) != 1 || terrain.Diffs[0].Offset != 0x40 {
		t.Fatalf("expected 1 diff hunk at 0x40, got %+v", terrain.Diffs)
	}
	if len(terrain.Diffs[0].Classification) == 0 {
		t.Fatalf("expected patch classification for mov eax, 1; ret")
	}
}
