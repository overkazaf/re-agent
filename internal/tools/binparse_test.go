package tools

import (
	"encoding/base32"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// minimalELF64 builds a valid 64-bit little-endian ARM64 ELF with a PT_LOAD
// segment, an executable PT_GNU_STACK segment, and a .text section containing
// an ARM64 `svc #0` instruction + anti-Frida string.
func minimalELF64() []byte {
	buf := make([]byte, 512)
	copy(buf[0:4], []byte{0x7f, 'E', 'L', 'F'})
	buf[4] = 2                                     // ELFCLASS64
	buf[5] = 1                                     // ELFDATA2LSB
	buf[6] = 1                                     // EV_CURRENT
	binary.LittleEndian.PutUint16(buf[16:18], 2)   // ET_EXEC
	binary.LittleEndian.PutUint16(buf[18:20], 183) // EM_AARCH64
	binary.LittleEndian.PutUint32(buf[20:24], 1)
	binary.LittleEndian.PutUint64(buf[24:32], 0x401000) // e_entry
	binary.LittleEndian.PutUint64(buf[32:40], 64)       // e_phoff
	binary.LittleEndian.PutUint64(buf[40:48], 256)      // e_shoff
	binary.LittleEndian.PutUint16(buf[52:54], 64)       // e_ehsize
	binary.LittleEndian.PutUint16(buf[54:56], 56)       // e_phentsize
	binary.LittleEndian.PutUint16(buf[56:58], 2)        // e_phnum
	binary.LittleEndian.PutUint16(buf[58:60], 64)       // e_shentsize
	binary.LittleEndian.PutUint16(buf[60:62], 3)        // e_shnum
	binary.LittleEndian.PutUint16(buf[62:64], 2)        // e_shstrndx

	// phdr[0]: PT_LOAD (RWX)
	p0 := buf[64 : 64+56]
	binary.LittleEndian.PutUint32(p0[0:4], 1)  // PT_LOAD
	binary.LittleEndian.PutUint32(p0[4:8], 7)  // PF_R|PF_W|PF_X
	binary.LittleEndian.PutUint64(p0[8:16], 0) // p_offset
	binary.LittleEndian.PutUint64(p0[16:24], 0x400000)
	binary.LittleEndian.PutUint64(p0[32:40], 512)
	binary.LittleEndian.PutUint64(p0[40:48], 512)

	// phdr[1]: PT_GNU_STACK with PF_X set (executable stack!)
	p1 := buf[120 : 120+56]
	binary.LittleEndian.PutUint32(p1[0:4], 0x6474e551) // PT_GNU_STACK
	binary.LittleEndian.PutUint32(p1[4:8], 7)          // RWE

	// Code + strings payload at offset 180..240
	copy(buf[180:188], []byte{0x01, 0x00, 0x00, 0xd4, 0xc0, 0x03, 0x5f, 0xd6}) // svc #0; ret
	copy(buf[192:], []byte("frida-agent\x00/proc/self/status\x00"))
	// shstrtab at offset 230: "\x00.text\x00.shstrtab\x00"
	shstr := "\x00.text\x00.shstrtab\x00"
	copy(buf[230:], []byte(shstr))

	// shdr[0]: SHT_NULL at 256..320
	// shdr[1]: .text at 320..384
	s1 := buf[320:384]
	binary.LittleEndian.PutUint32(s1[0:4], 1)  // ".text"
	binary.LittleEndian.PutUint32(s1[4:8], 1)  // SHT_PROGBITS
	binary.LittleEndian.PutUint64(s1[8:16], 6) // SHF_ALLOC|SHF_EXECINSTR
	binary.LittleEndian.PutUint64(s1[16:24], 0x401000)
	binary.LittleEndian.PutUint64(s1[24:32], 180)
	binary.LittleEndian.PutUint64(s1[32:40], 8)

	// shdr[2]: .shstrtab at 384..448
	s2 := buf[384:448]
	binary.LittleEndian.PutUint32(s2[0:4], 7) // ".shstrtab"
	binary.LittleEndian.PutUint32(s2[4:8], 3) // SHT_STRTAB
	binary.LittleEndian.PutUint64(s2[24:32], 230)
	binary.LittleEndian.PutUint64(s2[32:40], uint64(len(shstr)))
	return buf
}

func TestBinaryInspectMitigationsAntiAndDiff(t *testing.T) {
	tc := testContext(t)
	elfA := filepath.Join(tc.Workspace, "sample.elf")
	rawA := minimalELF64()
	if err := os.WriteFile(elfA, rawA, 0o755); err != nil {
		t.Fatal(err)
	}

	inspectOut := text(run(t, "binary_inspect", map[string]any{"path": "sample.elf"}, tc))
	if !strings.Contains(inspectOut, "EM_AARCH64") || !strings.Contains(inspectOut, ".text") || !strings.Contains(inspectOut, "WARNING rwx segments") {
		t.Fatalf("unexpected binary_inspect output:\n%s", inspectOut)
	}

	mitOut := text(run(t, "binary_mitigations", map[string]any{"path": "sample.elf"}, tc))
	if !strings.Contains(mitOut, "NX: no (executable stack!)") || !strings.Contains(mitOut, "PIE: no") {
		t.Fatalf("expected executable stack and non-PIE detection:\n%s", mitOut)
	}

	antiOut := text(run(t, "anti_analysis", map[string]any{"path": "sample.elf"}, tc))
	if !strings.Contains(antiOut, "svc #0") || !strings.Contains(antiOut, "frida-agent") || !strings.Contains(antiOut, "/proc/self/status") {
		t.Fatalf("expected ARM64 svc #0 + frida + TracerPid detection:\n%s", antiOut)
	}

	// Patch `svc #0; ret` -> `mov w0, #1; ret` and verify binary_diff detects it!
	rawB := append([]byte{}, rawA...)
	copy(rawB[180:188], []byte{0x20, 0x00, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6})
	elfB := filepath.Join(tc.Workspace, "sample_patched.elf")
	if err := os.WriteFile(elfB, rawB, 0o755); err != nil {
		t.Fatal(err)
	}
	diffOut := text(run(t, "binary_diff", map[string]any{"pathA": "sample.elf", "pathB": "sample_patched.elf"}, tc))
	if !strings.Contains(diffOut, "mov w0, #1") {
		t.Fatalf("expected ARM64 patch classification in diff:\n%s", diffOut)
	}
}

func TestCarveIgnoresBareMZAndDecodesExtendedCodecs(t *testing.T) {
	tc := testContext(t)
	blob := filepath.Join(tc.Workspace, "noise.bin")
	if err := os.WriteFile(blob, []byte("random MZ noise without PE header and \x00asm\x01\x00\x00\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	carved := text(run(t, "carve_artifacts", map[string]any{"path": "noise.bin"}, tc))
	if strings.Contains(carved, "PE") || !strings.Contains(carved, "WASM") {
		t.Fatalf("carve should reject bare MZ false positive while finding WASM:\n%s", carved)
	}

	encoded := base32.StdEncoding.EncodeToString([]byte("0xaf{b32}"))
	b32 := text(run(t, "ctf_decode", map[string]any{"mode": "base32", "input": encoded}, tc))
	if !strings.Contains(b32, "0xaf{b32}") {
		t.Fatalf("expected base32 decode, got:\n%s", b32)
	}
}
