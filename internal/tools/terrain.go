package tools

import (
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// WorkspaceFile summarizes one inspectable file in a session workspace.
type WorkspaceFile struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Format   string `json:"format"`
	IsBinary bool   `json:"isBinary"`
}

// TerrainSection is one structural section/segment placed along file offsets.
type TerrainSection struct {
	Name          string  `json:"name"`
	Segment       string  `json:"segment,omitempty"`
	Offset        int64   `json:"offset"`
	Size          int64   `json:"size"`
	VAddr         string  `json:"vaddr,omitempty"`
	Flags         string  `json:"flags"`
	Entropy       float64 `json:"entropy"`
	RWX           bool    `json:"rwx,omitempty"`
	IsConstructor bool    `json:"isConstructor,omitempty"`
}

// TerrainBucket is one sliding-window entropy sample across the file.
type TerrainBucket struct {
	Offset       int64   `json:"offset"`
	Size         int     `json:"size"`
	Entropy      float64 `json:"entropy"`
	Printable    float64 `json:"printable"`
	HexPreview   string  `json:"hexPreview"`
	ASCIIPreview string  `json:"asciiPreview"`
}

// TerrainCarve marks an embedded container signature discovered in the file.
type TerrainCarve struct {
	Offset    int64  `json:"offset"`
	Kind      string `json:"kind"`
	Signature string `json:"signature"`
}

// TerrainAnti marks an anti-debug / anti-Frida / packer / inline-syscall hit.
type TerrainAnti struct {
	Category    string `json:"category"`
	Confidence  string `json:"confidence"`
	Description string `json:"description"`
	Detail      string `json:"detail"`
	Offset      int64  `json:"offset"`
	Bypass      string `json:"bypass,omitempty"`
}

// TerrainDiff marks a contiguous byte diff hunk between baseline and comparison.
type TerrainDiff struct {
	Offset         int64    `json:"offset"`
	Length         int      `json:"length"`
	BytesA         string   `json:"bytesA"`
	BytesB         string   `json:"bytesB"`
	Classification []string `json:"classification,omitempty"`
}

// BinaryTerrain is the structured spatial model for the Binary Forensic Radar.
type BinaryTerrain struct {
	Path           string            `json:"path"`
	ComparePath    string            `json:"comparePath,omitempty"`
	Format         string            `json:"format"`
	Arch           string            `json:"arch,omitempty"`
	Size           int64             `json:"size"`
	Sampled        int               `json:"sampled"`
	SHA256         string            `json:"sha256"`
	OverallEntropy float64           `json:"overallEntropy"`
	MaxEntropy     float64           `json:"maxEntropy"`
	EntryPoint     string            `json:"entryPoint,omitempty"`
	Mitigations    map[string]string `json:"mitigations,omitempty"`
	Sections       []TerrainSection  `json:"sections"`
	Entropy        []TerrainBucket   `json:"entropy"`
	Carves         []TerrainCarve    `json:"carves"`
	Anti           []TerrainAnti     `json:"anti"`
	Diffs          []TerrainDiff     `json:"diffs"`
}

var skipWalkDirs = map[string]bool{
	".git": true, "node_modules": true, "sessions": true, "artifacts": true,
	"dist": true, "build": true, ".gocache": true, "__pycache__": true,
}

// ListWorkspaceFiles enumerates workspace files, surfacing native binaries and
// forensic artifacts first so the GUI selector defaults to an interesting target.
func ListWorkspaceFiles(workspace string, limit int) []WorkspaceFile {
	if limit <= 0 {
		limit = 80
	}
	var out []WorkspaceFile
	_ = filepath.WalkDir(workspace, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != workspace && skipWalkDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if len(out) >= limit*2 {
			return fs.SkipAll
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return nil
		}
		rel, err := filepath.Rel(workspace, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		head, _ := readPrefix(path, 256)
		format, isBin := sniffTerrainFormat(rel, head)
		out = append(out, WorkspaceFile{
			Path:     rel,
			Size:     info.Size(),
			Format:   format,
			IsBinary: isBin,
		})
		return nil
	})
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsBinary != out[j].IsBinary {
			return out[i].IsBinary
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func sniffTerrainFormat(rel string, head []byte) (string, bool) {
	switch {
	case len(head) >= 4 && bytes.Equal(head[:4], []byte{0x7f, 'E', 'L', 'F'}):
		return "ELF", true
	case isPEBytes(head):
		return "PE", true
	case isMachOBytes(head):
		return "Mach-O", true
	case len(head) >= 4 && bytes.Equal(head[:4], []byte{0x00, 'a', 's', 'm'}):
		return "WASM", true
	case len(head) >= 4 && bytes.Equal(head[:4], []byte{'d', 'e', 'x', '\n'}):
		return "DEX", true
	case len(head) >= 4 && bytes.Equal(head[:4], []byte{'P', 'K', 0x03, 0x04}):
		if strings.HasSuffix(strings.ToLower(rel), ".apk") {
			return "APK", true
		}
		return "ZIP", true
	}
	ext := strings.ToLower(filepath.Ext(rel))
	if ext == ".bin" || ext == ".fw" || ext == ".img" || ext == ".so" || ext == ".dylib" || ext == ".dll" || ext == ".exe" {
		return "Binary", true
	}
	printable := printableRatio(head)
	if printable < 0.72 {
		return "Raw Binary", true
	}
	return "Text", false
}

// BuildBinaryTerrain builds a spatial forensic profile for relPath (and an
// optional comparison binary compareRelPath for patch diff markers).
func BuildBinaryTerrain(workspace, relPath, compareRelPath string, policy *types.ExecutionPolicy) (BinaryTerrain, error) {
	target, err := util.ResolveInside(workspace, strings.TrimSpace(relPath))
	if err != nil {
		return BinaryTerrain{}, err
	}
	if policy != nil {
		if err := security.ValidatePathRead(target, policy); err != nil {
			return BinaryTerrain{}, err
		}
	}
	data, fullSize, err := readBoundedFile(target, maxBinaryAnalyzeBytes)
	if err != nil {
		return BinaryTerrain{}, err
	}
	digest, _ := sha256File(target)
	rel := relative(workspace, target)

	format, _ := sniffTerrainFormat(rel, data[:minInt(len(data), 256)])
	overall := shannonEntropy(data)
	buckets, maxEnt := buildTerrainBuckets(data, 96)

	terrain := BinaryTerrain{
		Path:           rel,
		Format:         format,
		Size:           fullSize,
		Sampled:        len(data),
		SHA256:         digest,
		OverallEntropy: round3(overall),
		MaxEntropy:     round3(maxEnt),
		Mitigations:    map[string]string{},
		Sections:       []TerrainSection{},
		Entropy:        buckets,
		Carves:         []TerrainCarve{},
		Anti:           []TerrainAnti{},
		Diffs:          []TerrainDiff{},
	}

	// Native format sections, arch, entry point, and mitigations.
	switch {
	case len(data) >= 4 && bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}):
		populateELFTerrain(target, data, &terrain)
	case isPEBytes(data):
		populatePETerrain(target, data, &terrain)
	case isMachOBytes(data):
		populateMachOTerrain(target, data, &terrain)
	}
	if _, det, ok := analyzeNativeMitigations(target, rel); ok {
		for k, v := range det {
			if s, ok := v.(string); ok && s != "" {
				terrain.Mitigations[k] = s
			}
		}
	}

	// Embedded carved payloads.
	carved := carveHits(data)
	if len(carved) > 64 {
		carved = carved[:64]
	}
	for _, hit := range carved {
		terrain.Carves = append(terrain.Carves, TerrainCarve{
			Offset:    int64(hit.offset),
			Kind:      hit.kind,
			Signature: hit.signature,
		})
	}

	// Anti-analysis & packer markers with approximate file offsets.
	terrain.Anti = buildTerrainAnti(target, data)

	// Optional binary diff overlay.
	if strings.TrimSpace(compareRelPath) != "" {
		cmpTarget, err := util.ResolveInside(workspace, strings.TrimSpace(compareRelPath))
		if err != nil {
			return BinaryTerrain{}, err
		}
		if policy != nil {
			if err := security.ValidatePathRead(cmpTarget, policy); err != nil {
				return BinaryTerrain{}, err
			}
		}
		dataB, _, err := readBoundedFile(cmpTarget, maxBinaryAnalyzeBytes)
		if err != nil {
			return BinaryTerrain{}, err
		}
		terrain.ComparePath = relative(workspace, cmpTarget)
		terrain.Diffs = buildTerrainDiffs(data, dataB, 64)
	}

	return terrain, nil
}

func buildTerrainBuckets(data []byte, count int) ([]TerrainBucket, float64) {
	if len(data) == 0 {
		return nil, 0
	}
	// Keep at least 64 bytes per bucket so Shannon entropy estimates stay meaningful on small samples.
	if maxBySize := len(data) / 64; maxBySize < count {
		count = maxBySize
	}
	if count < 1 {
		count = 1
	}
	out := make([]TerrainBucket, 0, count)
	maxEnt := 0.0
	for i := 0; i < count; i++ {
		start := int(int64(i) * int64(len(data)) / int64(count))
		end := int(int64(i+1) * int64(len(data)) / int64(count))
		if end <= start {
			end = minInt(len(data), start+1)
		}
		chunk := data[start:end]
		ent := shannonEntropy(chunk)
		if ent > maxEnt {
			maxEnt = ent
		}
		prevLen := minInt(16, len(chunk))
		out = append(out, TerrainBucket{
			Offset:       int64(start),
			Size:         len(chunk),
			Entropy:      round3(ent),
			Printable:    round3(printableRatio(chunk)),
			HexPreview:   hex.EncodeToString(chunk[:prevLen]),
			ASCIIPreview: asciiPreview(chunk[:prevLen]),
		})
	}
	return out, maxEnt
}

func populateELFTerrain(target string, data []byte, terrain *BinaryTerrain) {
	f, err := elf.Open(target)
	if err != nil {
		return
	}
	defer f.Close()
	terrain.Format = "ELF"
	terrain.Arch = f.Machine.String()
	terrain.EntryPoint = fmt.Sprintf("0x%x", f.Entry)

	hasRWX := false
	for _, p := range f.Progs {
		if p.Type == elf.PT_LOAD && p.Flags&(elf.PF_R|elf.PF_W|elf.PF_X) == (elf.PF_R|elf.PF_W|elf.PF_X) {
			hasRWX = true
		}
	}
	if hasRWX {
		terrain.Mitigations["RWX"] = "yes (RWX PT_LOAD)"
	}
	for _, s := range f.Sections {
		if s.Type == elf.SHT_NULL || s.Type == elf.SHT_NOBITS || s.Size == 0 {
			continue
		}
		ent := 0.0
		if int(s.Offset) < len(data) {
			end := minInt(len(data), int(s.Offset)+int(minUint64(s.Size, 4*1024*1024)))
			ent = shannonEntropy(data[s.Offset:end])
		}
		rwx := (s.Flags&elf.SHF_WRITE != 0) && (s.Flags&elf.SHF_EXECINSTR != 0)
		isCtor := s.Name == ".init_array" || s.Name == ".preinit_array" || s.Name == ".ctors"
		terrain.Sections = append(terrain.Sections, TerrainSection{
			Name:          s.Name,
			Offset:        int64(s.Offset),
			Size:          int64(s.Size),
			VAddr:         fmt.Sprintf("0x%x", s.Addr),
			Flags:         elfSecFlags(s.Flags),
			Entropy:       round3(ent),
			RWX:           rwx,
			IsConstructor: isCtor,
		})
	}
}

func populatePETerrain(target string, data []byte, terrain *BinaryTerrain) {
	f, err := pe.Open(target)
	if err != nil {
		return
	}
	defer f.Close()
	terrain.Format = "PE"
	switch f.Machine {
	case pe.IMAGE_FILE_MACHINE_AMD64:
		terrain.Arch = "x86_64"
	case pe.IMAGE_FILE_MACHINE_I386:
		terrain.Arch = "x86"
	case pe.IMAGE_FILE_MACHINE_ARM64:
		terrain.Arch = "arm64"
	default:
		terrain.Arch = fmt.Sprintf("0x%x", f.Machine)
	}
	switch opt := f.OptionalHeader.(type) {
	case *pe.OptionalHeader64:
		terrain.EntryPoint = fmt.Sprintf("0x%x", opt.ImageBase+uint64(opt.AddressOfEntryPoint))
	case *pe.OptionalHeader32:
		terrain.EntryPoint = fmt.Sprintf("0x%x", uint64(opt.ImageBase)+uint64(opt.AddressOfEntryPoint))
	}
	for _, s := range f.Sections {
		if s.Size == 0 {
			continue
		}
		ent := 0.0
		if int(s.Offset) < len(data) {
			end := minInt(len(data), int(s.Offset)+int(minUint64(uint64(s.Size), 4*1024*1024)))
			ent = shannonEntropy(data[s.Offset:end])
		}
		flags := peCharacteristicsFlags(s.Characteristics)
		rwx := strings.Contains(flags, "W") && strings.Contains(flags, "X")
		terrain.Sections = append(terrain.Sections, TerrainSection{
			Name:          s.Name,
			Offset:        int64(s.Offset),
			Size:          int64(s.Size),
			VAddr:         fmt.Sprintf("0x%x", s.VirtualAddress),
			Flags:         flags,
			Entropy:       round3(ent),
			RWX:           rwx,
			IsConstructor: strings.EqualFold(s.Name, ".tls"),
		})
	}
}

func peCharacteristicsFlags(c uint32) string {
	var b strings.Builder
	if c&0x40000000 != 0 {
		b.WriteByte('R')
	}
	if c&0x80000000 != 0 {
		b.WriteByte('W')
	}
	if c&0x20000000 != 0 {
		b.WriteByte('X')
	}
	if b.Len() == 0 {
		return "-"
	}
	return b.String()
}

func populateMachOTerrain(target string, data []byte, terrain *BinaryTerrain) {
	var f *macho.File
	if fat, err := macho.OpenFat(target); err == nil {
		defer fat.Close()
		if len(fat.Arches) > 0 {
			f = fat.Arches[0].File
		}
	} else if single, err := macho.Open(target); err == nil {
		defer single.Close()
		f = single
	}
	if f == nil {
		return
	}
	terrain.Format = "Mach-O"
	terrain.Arch = f.Cpu.String()
	for _, s := range f.Sections {
		if s.Size == 0 {
			continue
		}
		ent := 0.0
		if int(s.Offset) < len(data) {
			end := minInt(len(data), int(s.Offset)+int(minUint64(s.Size, 4*1024*1024)))
			ent = shannonEntropy(data[s.Offset:end])
		}
		isCtor := s.Name == "__mod_init_func" || s.Name == "__init_offsets"
		flags := "R"
		if s.Seg == "__TEXT" {
			flags = "RX"
		} else if s.Seg == "__DATA" {
			flags = "RW"
		}
		terrain.Sections = append(terrain.Sections, TerrainSection{
			Name:          s.Name,
			Segment:       s.Seg,
			Offset:        int64(s.Offset),
			Size:          int64(s.Size),
			VAddr:         fmt.Sprintf("0x%x", s.Addr),
			Flags:         flags,
			Entropy:       round3(ent),
			IsConstructor: isCtor,
		})
	}
}

func buildTerrainAnti(target string, data []byte) []TerrainAnti {
	var findings []antiFinding
	// Reuse string rules directly with exact file offset resolution.
	type rule struct {
		cat, conf, needle, desc string
		ci                      bool
	}
	rules := []rule{
		{"anti_debug", "high", "ptrace", "ptrace reference (PTRACE_TRACEME / PT_DENY_ATTACH)", false},
		{"anti_debug", "high", "/proc/self/status", "TracerPid check via /proc/self/status", false},
		{"anti_debug", "high", "TracerPid", "Explicit TracerPid debugger detection", false},
		{"anti_debug", "high", "PT_DENY_ATTACH", "macOS/iOS PT_DENY_ATTACH anti-debug", false},
		{"anti_debug", "high", "IsDebuggerPresent", "Win32 IsDebuggerPresent check", false},
		{"anti_debug", "high", "NtQueryInformationProcess", "NtQueryInformationProcess anti-debug", false},
		{"anti_frida", "high", "frida-agent", "frida-agent library/maps scan", true},
		{"anti_frida", "high", "frida-server", "frida-server process/port scan", true},
		{"anti_frida", "high", "gum-js-loop", "Frida GumJS thread name check", true},
		{"anti_frida", "high", "XposedBridge", "Xposed framework detection", true},
		{"anti_frida", "medium", "27042", "Frida default port 27042 string check", false},
		{"packer_obfuscation", "high", "UPX!", "UPX packer magic header", false},
		{"packer_obfuscation", "high", "UPX0", "UPX section name", false},
		{"packer_obfuscation", "high", ".vmp0", "VMProtect section marker", true},
		{"packer_obfuscation", "high", "Themida", "Themida/WinLicense marker", false},
		{"packer_obfuscation", "high", "libjiagu", "360 Jiagu packer marker", true},
		{"packer_obfuscation", "high", "libshella", "Tencent Legu packer marker", true},
		{"anti_vm", "high", "ro.kernel.qemu", "Android QEMU emulator property check", false},
		{"anti_vm", "high", "VMwareVMware", "VMware hypervisor signature", false},
	}
	lowerData := bytes.ToLower(data)
	var out []TerrainAnti
	for _, r := range rules {
		idx := -1
		if r.ci {
			idx = bytes.Index(lowerData, bytes.ToLower([]byte(r.needle)))
		} else {
			idx = bytes.Index(data, []byte(r.needle))
		}
		if idx < 0 {
			continue
		}
		f := antiFinding{category: r.cat, confidence: r.conf, desc: r.desc, detail: r.needle}
		findings = append(findings, f)
		bypass := ""
		if hints := antiBypassHints([]antiFinding{f}); len(hints) > 0 {
			bypass = hints[0]
		}
		out = append(out, TerrainAnti{
			Category:    r.cat,
			Confidence:  r.conf,
			Description: r.desc,
			Detail:      r.needle,
			Offset:      int64(idx),
			Bypass:      bypass,
		})
	}
	// Also surface ELF RWX / encrypted executable sections / ARM64 svc #0 / x86 rdtsc.
	var secFindings []antiFinding
	scanExecSectionAnomalies(target, data, &secFindings)
	for _, f := range secFindings {
		bypass := ""
		if hints := antiBypassHints([]antiFinding{f}); len(hints) > 0 {
			bypass = hints[0]
		}
		out = append(out, TerrainAnti{
			Category:    f.category,
			Confidence:  f.confidence,
			Description: f.desc,
			Detail:      f.detail,
			Offset:      0,
			Bypass:      bypass,
		})
	}
	return out
}

func buildTerrainDiffs(dataA, dataB []byte, maxDiffs int) []TerrainDiff {
	minLen := minInt(len(dataA), len(dataB))
	var out []TerrainDiff
	for i := 0; i < minLen && len(out) < maxDiffs; {
		if dataA[i] == dataB[i] {
			i++
			continue
		}
		start := i
		end := i + 1
		for end < minLen {
			if dataA[end] != dataB[end] {
				end++
				continue
			}
			gap := 0
			for end+gap < minLen && gap < 4 && dataA[end+gap] == dataB[end+gap] {
				gap++
			}
			if end+gap < minLen && gap < 4 && dataA[end+gap] != dataB[end+gap] {
				end += gap + 1
				continue
			}
			break
		}
		cls := classifyPatchBytes(dataA[start:end], dataB[start:end])
		// Also recognize common x86/x64 return override 6-byte `mov eax, 0/1; ret` and 3-byte `xor eax, eax; ret`.
		b := dataB[start:end]
		if bytes.Equal(b, []byte{0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3}) {
			cls = append(cls, "x86/x64 `mov eax, 1; ret` (force true)")
		} else if bytes.Equal(b, []byte{0xb8, 0x00, 0x00, 0x00, 0x00, 0xc3}) || bytes.Equal(b, []byte{0x31, 0xc0, 0xc3}) {
			cls = append(cls, "x86/x64 `return 0` override")
		}
		showLen := minInt(end-start, 24)
		out = append(out, TerrainDiff{
			Offset:         int64(start),
			Length:         end - start,
			BytesA:         hex.EncodeToString(dataA[start : start+showLen]),
			BytesB:         hex.EncodeToString(dataB[start : start+showLen]),
			Classification: cls,
		})
		i = end
	}
	return out
}

func round3(v float64) float64 {
	return float64(int64(v*1000+0.5)) / 1000
}
