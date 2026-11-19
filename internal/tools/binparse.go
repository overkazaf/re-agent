package tools

import (
	"archive/zip"
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

const maxBinaryAnalyzeBytes = 64 * 1024 * 1024

func binaryInspectTool() types.Tool {
	return types.Tool{
		Name:        "binary_inspect",
		Description: "Cross-platform structural parser for ELF, PE/DLL, Mach-O (including Universal/Fat), and WASM binaries: headers, entry points, pre-main initializers (.init_array/TLS/__mod_init_func), sections/segments with R/W/X flags and Shannon entropy, imports, exports (including JNI), and relocations.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":       map[string]any{"type": "string", "description": "Workspace-relative binary path."},
			"maxSymbols": map[string]any{"type": "number", "default": 80, "description": "Max imports/exports to display inline."},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			maxSyms := clampInt(util.AsInt(args["maxSymbols"], 80), 10, 500)
			report, details, err := inspectBinaryFile(target, relative(tc.Workspace, target), maxSyms)
			if err != nil {
				return types.ToolResult{}, err
			}
			spilled := SpillIfLarge(report, SpillOptions{
				Context: tc, Label: "inspect-" + util.AsString(args["path"]),
			})
			if spilled.Artifact != "" {
				details["artifact"] = spilled.Artifact
			}
			return textResult(spilled.Text, details), nil
		},
	}
}

func antiAnalysisTool() types.Tool {
	return types.Tool{
		Name:        "anti_analysis",
		Description: "Detect anti-debugging, anti-Frida/hooking, anti-VM, anti-root/jailbreak, direct ARM64 SVC syscalls, RWX unpacker stubs, high-entropy code sections, and commercial packers (UPX, VMProtect, Themida, Jiagu, Legu, Bangcle, Ijiami, Yidun, OLLVM) with actionable bypass hints.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path": map[string]any{"type": "string", "description": "Workspace-relative binary path."},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			report, details, err := scanAntiAnalysis(target, relative(tc.Workspace, target))
			if err != nil {
				return types.ToolResult{}, err
			}
			return textResult(util.Clip(report, tc.Policy.MaxReadBytes), details), nil
		},
	}
}

func binaryDiffTool() types.Tool {
	return types.Tool{
		Name:        "binary_diff",
		Description: "Compare two workspace binaries (original vs patched/unpacked): hashes, size/section deltas, byte diff regions with hex/ASCII context, and x86/x64 + ARM64 patch pattern recognition (NOPs, conditional branch flips, return overrides).",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"pathA":    map[string]any{"type": "string", "description": "First workspace-relative binary path (baseline)."},
			"pathB":    map[string]any{"type": "string", "description": "Second workspace-relative binary path (modified)."},
			"maxDiffs": map[string]any{"type": "number", "default": 50, "description": "Max contiguous diff regions to report."},
			"context":  map[string]any{"type": "number", "default": 8, "description": "Context bytes around each diff."},
		}, "pathA", "pathB"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			pathA, err := util.ResolveInside(tc.Workspace, util.AsString(args["pathA"]))
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := security.ValidatePathRead(pathA, tc.Policy); err != nil {
				return types.ToolResult{}, err
			}
			pathB, err := util.ResolveInside(tc.Workspace, util.AsString(args["pathB"]))
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := security.ValidatePathRead(pathB, tc.Policy); err != nil {
				return types.ToolResult{}, err
			}
			maxDiffs := clampInt(util.AsInt(args["maxDiffs"], 50), 1, 300)
			ctxBytes := clampInt(util.AsInt(args["context"], 8), 0, 64)
			report, details, err := diffBinaryFiles(
				pathA, relative(tc.Workspace, pathA),
				pathB, relative(tc.Workspace, pathB),
				maxDiffs, ctxBytes,
			)
			if err != nil {
				return types.ToolResult{}, err
			}
			return textResult(util.Clip(report, tc.Policy.MaxReadBytes), details), nil
		},
	}
}

// --- cross-platform structural inspection -----------------------------------

func readBoundedFile(path string, maxBytes int64) ([]byte, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	if info.IsDir() {
		return nil, 0, fmt.Errorf("expected a file path, got directory: %s", path)
	}
	limit := info.Size()
	if limit > maxBytes {
		limit = maxBytes
	}
	data, err := readPrefix(path, int(limit))
	return data, info.Size(), err
}

func inspectBinaryFile(target, rel string, maxSyms int) (string, map[string]any, error) {
	data, fullSize, err := readBoundedFile(target, maxBinaryAnalyzeBytes)
	if err != nil {
		return "", nil, err
	}
	digest, _ := sha256File(target)
	switch {
	case len(data) >= 4 && bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}):
		return inspectELF(target, rel, data, fullSize, digest, maxSyms)
	case isPEBytes(data):
		return inspectPE(target, rel, data, fullSize, digest, maxSyms)
	case isMachOBytes(data):
		return inspectMachO(target, rel, data, fullSize, digest, maxSyms)
	case len(data) >= 8 && bytes.Equal(data[:4], []byte{0x00, 'a', 's', 'm'}):
		return inspectWASM(rel, data, fullSize, digest)
	default:
		out := []string{
			"BINARY INSPECT",
			"path: " + rel,
			"format: raw/unrecognized container",
			fmt.Sprintf("size: %d bytes", fullSize),
			"sha256: " + digest,
			fmt.Sprintf("entropy: %.3f bits/byte", shannonEntropy(data)),
			"magic.hex: " + hex.EncodeToString(data[:minInt(len(data), 16)]),
			"",
			"hint: Not an ELF/PE/Mach-O/WASM container; try ctf_triage, carve_artifacts, apk_inspect, or entropy_scan.",
		}
		return strings.Join(out, "\n"), map[string]any{"format": "raw", "size": fullSize, "sha256": digest}, nil
	}
}

func inspectELF(target, rel string, data []byte, fullSize int64, digest string, maxSyms int) (string, map[string]any, error) {
	f, err := elf.Open(target)
	if err != nil {
		return "", nil, fmt.Errorf("ELF parse failed: %w", err)
	}
	defer f.Close()

	interp := ""
	var rwxSegs []string
	var segLines []string
	for _, p := range f.Progs {
		flags := elfProgFlags(p.Flags)
		if p.Type == elf.PT_LOAD && p.Flags&(elf.PF_R|elf.PF_W|elf.PF_X) == (elf.PF_R|elf.PF_W|elf.PF_X) {
			rwxSegs = append(rwxSegs, fmt.Sprintf("0x%x (memsz 0x%x)", p.Vaddr, p.Memsz))
		}
		if p.Type == elf.PT_INTERP {
			if raw, rErr := io.ReadAll(io.LimitReader(p.Open(), 256)); rErr == nil {
				interp = strings.TrimRight(string(raw), "\x00\r\n")
			}
		}
		segLines = append(segLines, fmt.Sprintf("  %-14s off=0x%08x vaddr=0x%08x filesz=0x%06x memsz=0x%06x %-3s",
			p.Type.String(), p.Off, p.Vaddr, p.Filesz, p.Memsz, flags))
	}

	var secLines []string
	var inits []string
	for _, s := range f.Sections {
		if s.Type == elf.SHT_NULL {
			continue
		}
		ent := 0.0
		if s.Type != elf.SHT_NOBITS && s.Size > 0 && int(s.Offset) < len(data) {
			end := minInt(len(data), int(s.Offset)+int(minUint64(s.Size, 4*1024*1024)))
			if end > int(s.Offset) {
				ent = shannonEntropy(data[s.Offset:end])
			}
		}
		secLines = append(secLines, fmt.Sprintf("  %-20s %-12s addr=0x%08x off=0x%08x size=0x%06x %-3s ent=%.2f",
			s.Name, s.Type.String(), s.Addr, s.Offset, s.Size, elfSecFlags(s.Flags), ent))
		if s.Name == ".init_array" || s.Name == ".ctors" || s.Name == ".preinit_array" || s.Name == ".init" {
			ptrSize := 8
			if f.Class == elf.ELFCLASS32 {
				ptrSize = 4
			}
			count := int(s.Size) / ptrSize
			inits = append(inits, fmt.Sprintf("%s @ 0x%x (%d bytes, ~%d entries)", s.Name, s.Addr, s.Size, count))
		}
	}

	libs, _ := f.ImportedLibraries()
	impSyms, _ := f.ImportedSymbols()
	dynSyms, _ := f.DynamicSymbols()
	symtab, _ := f.Symbols()
	soname, _ := f.DynString(elf.DT_SONAME)
	rpath, _ := f.DynString(elf.DT_RPATH)
	runpath, _ := f.DynString(elf.DT_RUNPATH)

	var imports []string
	for _, imp := range impSyms {
		if imp.Library != "" {
			imports = append(imports, imp.Name+"@"+imp.Library)
		} else {
			imports = append(imports, imp.Name)
		}
	}
	var exports []string
	var jniExports []string
	seenExp := map[string]bool{}
	for _, s := range append(dynSyms, symtab...) {
		if s.Name == "" || s.Section == elf.SHN_UNDEF || seenExp[s.Name] {
			continue
		}
		if elf.ST_BIND(s.Info) == elf.STB_LOCAL && !strings.HasPrefix(s.Name, "Java_") && s.Name != "JNI_OnLoad" {
			continue
		}
		seenExp[s.Name] = true
		line := fmt.Sprintf("0x%08x  %s", s.Value, s.Name)
		exports = append(exports, line)
		if s.Name == "JNI_OnLoad" || s.Name == "JNI_OnUnload" || strings.HasPrefix(s.Name, "Java_") {
			jniExports = append(jniExports, line)
		}
	}

	out := []string{
		"BINARY INSPECT (ELF)",
		"path: " + rel,
		fmt.Sprintf("size: %d bytes", fullSize),
		"sha256: " + digest,
		fmt.Sprintf("class: %s  endian: %s  machine: %s  type: %s", f.Class, f.ByteOrder, f.Machine, f.Type),
		fmt.Sprintf("entry: 0x%x", f.Entry),
	}
	if interp != "" {
		out = append(out, "interpreter: "+interp)
	}
	if len(soname) > 0 {
		out = append(out, "soname: "+strings.Join(soname, ", "))
	}
	if len(rpath) > 0 || len(runpath) > 0 {
		out = append(out, "rpath/runpath: "+strings.Join(append(rpath, runpath...), ", "))
	}
	out = append(out, fmt.Sprintf("stripped: %s", ternary(len(symtab) == 0, "yes (no .symtab)", fmt.Sprintf("no (%d .symtab entries)", len(symtab)))))
	if len(rwxSegs) > 0 {
		out = append(out, "WARNING rwx segments: "+strings.Join(rwxSegs, ", "))
	}
	if len(inits) > 0 {
		out = append(out, "", "initializers (pre-main / constructors):")
		out = append(out, bullets(inits, "- none")...)
	}
	if len(libs) > 0 {
		out = append(out, "", "needed libraries: "+strings.Join(libs, ", "))
	}
	if len(jniExports) > 0 {
		out = append(out, "", fmt.Sprintf("JNI entrypoints (%d):", len(jniExports)))
		out = append(out, bullets(capStrings(jniExports, maxSyms), "- none")...)
	}
	out = append(out, "", fmt.Sprintf("segments (%d):", len(segLines)))
	out = append(out, segLines...)
	out = append(out, "", fmt.Sprintf("sections (%d):", len(secLines)))
	out = append(out, secLines...)
	out = append(out, "", fmt.Sprintf("imports (%d):", len(imports)))
	out = append(out, bullets(capStrings(imports, maxSyms), "- none")...)
	out = append(out, "", fmt.Sprintf("exports/defined symbols (%d):", len(exports)))
	out = append(out, bullets(capStrings(exports, maxSyms), "- none")...)

	return strings.Join(out, "\n"), map[string]any{
		"format": "ELF", "arch": f.Machine.String(), "entry": fmt.Sprintf("0x%x", f.Entry),
		"sha256": digest, "sections": len(secLines), "imports": len(imports), "exports": len(exports),
		"jni": len(jniExports), "stripped": len(symtab) == 0,
	}, nil
}

func inspectPE(target, rel string, data []byte, fullSize int64, digest string, maxSyms int) (string, map[string]any, error) {
	f, err := pe.Open(target)
	if err != nil {
		return "", nil, fmt.Errorf("PE parse failed: %w", err)
	}
	defer f.Close()

	class := "PE32"
	var entry uint32
	var imageBase uint64
	var subsystem uint16
	var hasTLS, hasCLR bool
	switch opt := f.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		entry = opt.AddressOfEntryPoint
		imageBase = uint64(opt.ImageBase)
		subsystem = opt.Subsystem
		hasTLS = opt.DataDirectory[9].VirtualAddress != 0
		hasCLR = opt.DataDirectory[14].VirtualAddress != 0
	case *pe.OptionalHeader64:
		class = "PE32+"
		entry = opt.AddressOfEntryPoint
		imageBase = opt.ImageBase
		subsystem = opt.Subsystem
		hasTLS = opt.DataDirectory[9].VirtualAddress != 0
		hasCLR = opt.DataDirectory[14].VirtualAddress != 0
	}

	var secLines []string
	var rwx []string
	var maxEnd uint64
	for _, s := range f.Sections {
		ent := 0.0
		if raw, sErr := s.Data(); sErr == nil && len(raw) > 0 {
			ent = shannonEntropy(raw)
		}
		endOff := uint64(s.Offset) + uint64(s.Size)
		if endOff > maxEnd {
			maxEnd = endOff
		}
		perms := peSectionPerms(s.Characteristics)
		if perms == "RWX" {
			rwx = append(rwx, s.Name)
		}
		secLines = append(secLines, fmt.Sprintf("  %-10s va=0x%08x vsz=0x%06x raw=0x%08x rsz=0x%06x %-3s ent=%.2f",
			s.Name, s.VirtualAddress, s.VirtualSize, s.Offset, s.Size, perms, ent))
	}

	imports, _ := f.ImportedSymbols()
	exports := parsePEExports(f, data)
	isDLL := f.Characteristics&0x2000 != 0

	out := []string{
		"BINARY INSPECT (PE)",
		"path: " + rel,
		fmt.Sprintf("size: %d bytes", fullSize),
		"sha256: " + digest,
		fmt.Sprintf("class: %s  machine: %s  kind: %s  subsystem: %s",
			class, peMachineName(f.Machine), ternary(isDLL, "DLL", "EXE"), peSubsystemName(subsystem)),
		fmt.Sprintf("image_base: 0x%x  entry_rva: 0x%x (va 0x%x)", imageBase, entry, imageBase+uint64(entry)),
	}
	if hasCLR {
		out = append(out, "runtime: .NET CLR metadata present (use dnSpy/ILSpy)")
	}
	if hasTLS {
		out = append(out, "initializers: PE TLS Directory present (check TLS callbacks for pre-entry anti-debug!)")
	}
	if fullSize > int64(maxEnd) && maxEnd > 0 {
		out = append(out, fmt.Sprintf("overlay: %d trailing bytes at 0x%x (check for appended archive/PyInstaller/config)", fullSize-int64(maxEnd), maxEnd))
	}
	if len(rwx) > 0 {
		out = append(out, "WARNING rwx sections: "+strings.Join(rwx, ", "))
	}
	out = append(out, "", fmt.Sprintf("sections (%d):", len(secLines)))
	out = append(out, secLines...)
	out = append(out, "", fmt.Sprintf("imports (%d):", len(imports)))
	out = append(out, bullets(capStrings(imports, maxSyms), "- none (possibly packed or dynamically resolved via LoadLibrary/GetProcAddress)")...)
	out = append(out, "", fmt.Sprintf("exports (%d):", len(exports)))
	out = append(out, bullets(capStrings(exports, maxSyms), "- none")...)

	return strings.Join(out, "\n"), map[string]any{
		"format": class, "arch": peMachineName(f.Machine), "entry": fmt.Sprintf("0x%x", imageBase+uint64(entry)),
		"sha256": digest, "sections": len(secLines), "imports": len(imports), "exports": len(exports), "tls": hasTLS,
	}, nil
}

func inspectMachO(target, rel string, data []byte, fullSize int64, digest string, maxSyms int) (string, map[string]any, error) {
	if fat, fatErr := macho.OpenFat(target); fatErr == nil {
		defer fat.Close()
		out := []string{
			"BINARY INSPECT (Mach-O Universal/Fat)",
			"path: " + rel,
			fmt.Sprintf("size: %d bytes", fullSize),
			"sha256: " + digest,
			fmt.Sprintf("slices: %d", len(fat.Arches)),
		}
		var arches []string
		for i, arch := range fat.Arches {
			arches = append(arches, arch.Cpu.String())
			out = append(out, "", fmt.Sprintf("--- slice [%d] %s (offset 0x%x, size %d) ---", i, arch.Cpu, arch.Offset, arch.Size))
			out = append(out, formatMachOSingle(arch.File, maxSyms)...)
		}
		return strings.Join(out, "\n"), map[string]any{
			"format": "Mach-O Fat", "arches": arches, "slices": len(fat.Arches), "sha256": digest,
		}, nil
	}
	f, err := macho.Open(target)
	if err != nil {
		return "", nil, fmt.Errorf("Mach-O parse failed: %w", err)
	}
	defer f.Close()
	out := []string{
		"BINARY INSPECT (Mach-O)",
		"path: " + rel,
		fmt.Sprintf("size: %d bytes", fullSize),
		"sha256: " + digest,
	}
	out = append(out, formatMachOSingle(f, maxSyms)...)
	return strings.Join(out, "\n"), map[string]any{
		"format": "Mach-O", "arch": f.Cpu.String(), "sha256": digest, "sections": len(f.Sections),
	}, nil
}

func formatMachOSingle(f *macho.File, maxSyms int) []string {
	var out []string
	out = append(out, fmt.Sprintf("cpu: %s  type: %s  flags: 0x%x", f.Cpu, f.Type, f.Flags))
	libs, _ := f.ImportedLibraries()
	imps, _ := f.ImportedSymbols()

	var rpaths []string
	var entryOff uint64
	hasEntry := false
	for _, load := range f.Loads {
		if r, ok := load.(*macho.Rpath); ok {
			rpaths = append(rpaths, r.Path)
		}
		raw := load.Raw()
		if len(raw) >= 16 {
			cmd := f.ByteOrder.Uint32(raw[0:4])
			if cmd == 0x80000028 { // LC_MAIN
				entryOff = f.ByteOrder.Uint64(raw[8:16])
				hasEntry = true
			}
		}
	}
	if hasEntry {
		out = append(out, fmt.Sprintf("entry_offset (LC_MAIN): 0x%x", entryOff))
	}
	if len(rpaths) > 0 {
		out = append(out, "rpaths: "+strings.Join(rpaths, ", "))
	}
	if len(libs) > 0 {
		out = append(out, "dylibs: "+strings.Join(libs, ", "))
	}

	var inits []string
	var secLines []string
	for _, s := range f.Sections {
		ent := 0.0
		if raw, err := s.Data(); err == nil && len(raw) > 0 {
			ent = shannonEntropy(raw)
		}
		secLines = append(secLines, fmt.Sprintf("  %-10s,%-16s addr=0x%08x off=0x%08x size=0x%06x ent=%.2f",
			s.Seg, s.Name, s.Addr, s.Offset, s.Size, ent))
		if s.Name == "__mod_init_func" || (s.Flags&0xff) == 0x9 {
			inits = append(inits, fmt.Sprintf("%s,%s @ 0x%x (%d bytes)", s.Seg, s.Name, s.Addr, s.Size))
		}
	}
	if len(inits) > 0 {
		out = append(out, "initializers: "+strings.Join(inits, "; "))
	}
	out = append(out, fmt.Sprintf("sections (%d):", len(secLines)))
	out = append(out, secLines...)

	var defined []string
	if f.Symtab != nil {
		for _, sym := range f.Symtab.Syms {
			if sym.Value != 0 && sym.Name != "" {
				defined = append(defined, fmt.Sprintf("0x%08x  %s", sym.Value, sym.Name))
			}
		}
	}
	out = append(out, fmt.Sprintf("imports (%d):", len(imps)))
	out = append(out, bullets(capStrings(imps, maxSyms), "- none")...)
	out = append(out, fmt.Sprintf("defined symbols (%d):", len(defined)))
	out = append(out, bullets(capStrings(defined, maxSyms), "- none")...)
	return out
}

func inspectWASM(rel string, data []byte, fullSize int64, digest string) (string, map[string]any, error) {
	ver := binary.LittleEndian.Uint32(data[4:8])
	secNames := map[byte]string{
		0: "Custom", 1: "Type", 2: "Import", 3: "Function", 4: "Table", 5: "Memory",
		6: "Global", 7: "Export", 8: "Start", 9: "Element", 10: "Code", 11: "Data", 12: "DataCount",
	}
	var secs []string
	pos := 8
	for pos < len(data) {
		id := data[pos]
		pos++
		size, n := readULEB128(data[pos:])
		if n == 0 {
			break
		}
		pos += n
		name := secNames[id]
		if name == "" {
			name = fmt.Sprintf("Section(%d)", id)
		}
		end := minInt(len(data), pos+int(size))
		ent := shannonEntropy(data[pos:end])
		secs = append(secs, fmt.Sprintf("  %-10s offset=0x%06x size=%d ent=%.2f", name, pos, size, ent))
		pos += int(size)
	}
	out := []string{
		"BINARY INSPECT (WASM)",
		"path: " + rel,
		fmt.Sprintf("size: %d bytes  version: %d", fullSize, ver),
		"sha256: " + digest,
		"",
		fmt.Sprintf("sections (%d):", len(secs)),
	}
	out = append(out, secs...)
	return strings.Join(out, "\n"), map[string]any{"format": "WASM", "version": ver, "sections": len(secs), "sha256": digest}, nil
}

// --- cross-platform native mitigations --------------------------------------

func analyzeNativeMitigations(target, rel string) (string, map[string]any, bool) {
	header, err := readPrefix(target, 64)
	if err != nil || len(header) < 4 {
		return "", nil, false
	}
	switch {
	case bytes.Equal(header[:4], []byte{0x7f, 'E', 'L', 'F'}):
		return elfMitigations(target, rel)
	case isPEBytes(header):
		return peMitigations(target, rel)
	case isMachOBytes(header):
		return machoMitigations(target, rel)
	}
	return "", nil, false
}

func elfMitigations(target, rel string) (string, map[string]any, bool) {
	f, err := elf.Open(target)
	if err != nil {
		return "", nil, false
	}
	defer f.Close()

	hasInterp := false
	hasGNUStack := false
	execStack := false
	hasGNURelro := false
	hasRWX := false
	for _, p := range f.Progs {
		if p.Type == elf.PT_INTERP {
			hasInterp = true
		}
		if p.Type == elf.PT_GNU_STACK {
			hasGNUStack = true
			if p.Flags&elf.PF_X != 0 {
				execStack = true
			}
		}
		if p.Type == elf.PT_GNU_RELRO {
			hasGNURelro = true
		}
		if p.Type == elf.PT_LOAD && p.Flags&(elf.PF_R|elf.PF_W|elf.PF_X) == (elf.PF_R|elf.PF_W|elf.PF_X) {
			hasRWX = true
		}
	}

	bindNow := elfHasBindNow(f)
	pie := "no (fixed-address ET_EXEC)"
	if f.Type == elf.ET_DYN {
		if hasInterp || elfHasPIEFlag(f) {
			pie = "yes (PIE executable)"
		} else {
			pie = "dso (position-independent shared library)"
		}
	}
	nx := "yes (platform default, no executable PT_GNU_STACK)"
	if hasGNUStack {
		if execStack {
			nx = "no (executable stack!)"
		} else {
			nx = "yes"
		}
	}
	relro := "no"
	if hasGNURelro && bindNow {
		relro = "full"
	} else if hasGNURelro {
		relro = "partial"
	}

	dynSyms, _ := f.DynamicSymbols()
	symtab, _ := f.Symbols()
	imps, _ := f.ImportedSymbols()
	var symNames []string
	hasCanary := false
	hasFortify := false
	for _, s := range append(dynSyms, symtab...) {
		symNames = append(symNames, s.Name)
		if strings.Contains(s.Name, "__stack_chk_fail") || strings.Contains(s.Name, "__stack_chk_guard") {
			hasCanary = true
		}
		if strings.HasPrefix(s.Name, "__") && strings.HasSuffix(s.Name, "_chk") {
			hasFortify = true
		}
	}
	for _, imp := range imps {
		symNames = append(symNames, imp.Name)
		if strings.Contains(imp.Name, "__stack_chk_fail") || strings.Contains(imp.Name, "__stack_chk_guard") {
			hasCanary = true
		}
		if strings.HasPrefix(imp.Name, "__") && strings.HasSuffix(imp.Name, "_chk") {
			hasFortify = true
		}
	}
	rpath, _ := f.DynString(elf.DT_RPATH)
	runpath, _ := f.DynString(elf.DT_RUNPATH)
	dangerous := dangerousImports(strings.Join(symNames, "\n"))

	details := map[string]any{
		"format":   fmt.Sprintf("ELF (%s, %s)", f.Class, f.Machine),
		"PIE":      pie,
		"NX":       nx,
		"RELRO":    relro,
		"canary":   ternary(hasCanary, "yes", "no"),
		"FORTIFY":  ternary(hasFortify, "yes", "no"),
		"RWX":      ternary(hasRWX, "yes (self-modifying/unpacker risk)", "no"),
		"stripped": ternary(len(symtab) == 0, "yes", "no"),
	}
	out := []string{
		"BINARY MITIGATIONS",
		"path: " + rel,
		"",
		"format: " + details["format"].(string),
		"arch: " + f.Machine.String(),
		"PIE: " + pie,
		"NX: " + nx,
		"RELRO: " + relro,
		"canary: " + details["canary"].(string),
		"FORTIFY: " + details["FORTIFY"].(string),
		"RWX segments: " + details["RWX"].(string),
		"stripped: " + details["stripped"].(string),
	}
	if len(rpath) > 0 || len(runpath) > 0 {
		out = append(out, "RPATH/RUNPATH: "+strings.Join(append(rpath, runpath...), ", "))
	}
	out = append(out, "", "dangerous imports:")
	out = append(out, bullets(dangerous, "- none found in symbol tables")...)
	return strings.Join(out, "\n"), details, true
}

func peMitigations(target, rel string) (string, map[string]any, bool) {
	f, err := pe.Open(target)
	if err != nil {
		return "", nil, false
	}
	defer f.Close()

	class := "PE32"
	var dllChars uint16
	hasCert := false
	hasLoadCfg := false
	switch opt := f.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		dllChars = opt.DllCharacteristics
		hasCert = opt.DataDirectory[4].VirtualAddress != 0
		hasLoadCfg = opt.DataDirectory[10].VirtualAddress != 0
	case *pe.OptionalHeader64:
		class = "PE32+"
		dllChars = opt.DllCharacteristics
		hasCert = opt.DataDirectory[4].VirtualAddress != 0
		hasLoadCfg = opt.DataDirectory[10].VirtualAddress != 0
	}

	aslr := dllChars&0x0040 != 0
	highEnt := dllChars&0x0020 != 0
	dep := dllChars&0x0100 != 0
	cfg := dllChars&0x4000 != 0
	noSEH := dllChars&0x0400 != 0
	forceInteg := dllChars&0x0080 != 0

	hasRWX := false
	for _, s := range f.Sections {
		if peSectionPerms(s.Characteristics) == "RWX" {
			hasRWX = true
		}
	}
	imps, _ := f.ImportedSymbols()
	joinedImps := strings.Join(imps, "\n")
	gsCookie := hasLoadCfg || strings.Contains(joinedImps, "security_cookie")
	dangerous := dangerousImports(joinedImps)

	aslrText := ternary(aslr, ternary(highEnt, "yes (High-Entropy VA)", "yes"), "no")
	details := map[string]any{
		"format":       fmt.Sprintf("%s (%s)", class, peMachineName(f.Machine)),
		"ASLR":         aslrText,
		"DEP/NX":       ternary(dep, "yes", "no"),
		"CFG":          ternary(cfg, "yes", "no"),
		"SEH":          ternary(noSEH, "disabled (NO_SEH)", "enabled"),
		"GS_cookie":    ternary(gsCookie, "likely yes (LoadConfig/cookie)", "no evidence"),
		"Authenticode": ternary(hasCert, "present", "none"),
		"RWX":          ternary(hasRWX, "yes (packer/shellcode risk)", "no"),
	}
	out := []string{
		"BINARY MITIGATIONS",
		"path: " + rel,
		"",
		"format: " + details["format"].(string),
		"ASLR (PIE): " + aslrText,
		"DEP (NX): " + details["DEP/NX"].(string),
		"Control Flow Guard (CFG): " + details["CFG"].(string),
		"SEH: " + details["SEH"].(string),
		"Stack Cookie (/GS): " + details["GS_cookie"].(string),
		"Force Integrity: " + ternary(forceInteg, "yes", "no"),
		"Authenticode: " + details["Authenticode"].(string),
		"RWX sections: " + details["RWX"].(string),
		"",
		"dangerous imports:",
	}
	out = append(out, bullets(dangerous, "- none found in import table")...)
	return strings.Join(out, "\n"), details, true
}

func machoMitigations(target, rel string) (string, map[string]any, bool) {
	var files []*macho.File
	if fat, err := macho.OpenFat(target); err == nil {
		defer fat.Close()
		for _, a := range fat.Arches {
			files = append(files, a.File)
		}
	} else if single, err := macho.Open(target); err == nil {
		defer single.Close()
		files = append(files, single)
	} else {
		return "", nil, false
	}

	f := files[0]
	pie := f.Flags&0x200000 != 0 || f.Type == macho.TypeDylib
	allowStackExec := f.Flags&0x20000 != 0
	noHeapExec := f.Flags&0x1000000 != 0
	hasCodeSig := false
	encrypted := false
	restricted := false
	for _, load := range f.Loads {
		raw := load.Raw()
		if len(raw) >= 8 {
			cmd := f.ByteOrder.Uint32(raw[0:4])
			switch cmd {
			case 0x1d: // LC_CODE_SIGNATURE
				hasCodeSig = true
			case 0x21, 0x2c: // LC_ENCRYPTION_INFO / 64
				if len(raw) >= 20 && f.ByteOrder.Uint32(raw[16:20]) != 0 {
					encrypted = true
				}
			}
		}
	}
	for _, s := range f.Sections {
		if strings.EqualFold(s.Seg, "__RESTRICT") {
			restricted = true
		}
	}
	imps, _ := f.ImportedSymbols()
	joined := strings.Join(imps, "\n")
	hasCanary := strings.Contains(joined, "stack_chk_fail") || strings.Contains(joined, "stack_chk_guard")
	hasARC := strings.Contains(joined, "_objc_release") || strings.Contains(joined, "_objc_retain")
	stripped := f.Symtab == nil || len(f.Symtab.Syms) == 0
	dangerous := dangerousImports(joined)

	var archNames []string
	for _, slice := range files {
		archNames = append(archNames, slice.Cpu.String())
	}
	details := map[string]any{
		"format":         "Mach-O (" + strings.Join(archNames, ", ") + ")",
		"PIE":            ternary(pie, "yes", "no"),
		"NX":             ternary(!allowStackExec, "yes", "no (MH_ALLOW_STACK_EXECUTION)"),
		"canary":         ternary(hasCanary, "yes", "no"),
		"ARC":            ternary(hasARC, "yes", "no"),
		"code_signature": ternary(hasCodeSig, "present", "none"),
		"encrypted":      ternary(encrypted, "yes (FairPlay/cryptid!=0)", "no"),
		"restricted":     ternary(restricted, "yes (__RESTRICT)", "no"),
		"stripped":       ternary(stripped, "yes", "no"),
	}
	out := []string{
		"BINARY MITIGATIONS",
		"path: " + rel,
		"",
		"format: " + details["format"].(string),
		"PIE: " + details["PIE"].(string),
		"NX (non-exec stack): " + details["NX"].(string),
		"No Heap Exec: " + ternary(noHeapExec, "yes", "default"),
		"canary: " + details["canary"].(string),
		"ARC: " + details["ARC"].(string),
		"Code Signature: " + details["code_signature"].(string),
		"Encrypted: " + details["encrypted"].(string),
		"__RESTRICT segment: " + details["restricted"].(string),
		"stripped: " + details["stripped"].(string),
		"",
		"dangerous imports:",
	}
	out = append(out, bullets(dangerous, "- none found in imported symbols")...)
	return strings.Join(out, "\n"), details, true
}

// --- structured symbol extraction -------------------------------------------

func extractNativeSymbols(target string) (string, bool) {
	header, err := readPrefix(target, 64)
	if err != nil || len(header) < 4 {
		return "", false
	}
	switch {
	case bytes.Equal(header[:4], []byte{0x7f, 'E', 'L', 'F'}):
		f, err := elf.Open(target)
		if err != nil {
			return "", false
		}
		defer f.Close()
		var lines []string
		if libs, _ := f.ImportedLibraries(); len(libs) > 0 {
			lines = append(lines, "## Needed Libraries", strings.Join(libs, ", "), "")
		}
		if imps, _ := f.ImportedSymbols(); len(imps) > 0 {
			lines = append(lines, fmt.Sprintf("## Imported Symbols (%d)", len(imps)))
			for _, imp := range imps {
				if imp.Library != "" {
					lines = append(lines, fmt.Sprintf("  U %s@%s", imp.Name, imp.Library))
				} else {
					lines = append(lines, "  U "+imp.Name)
				}
			}
			lines = append(lines, "")
		}
		dyns, _ := f.DynamicSymbols()
		syms, _ := f.Symbols()
		all := append(dyns, syms...)
		seen := map[string]bool{}
		var defs []string
		for _, s := range all {
			if s.Name == "" || s.Section == elf.SHN_UNDEF {
				continue
			}
			key := fmt.Sprintf("%x:%s", s.Value, s.Name)
			if seen[key] {
				continue
			}
			seen[key] = true
			defs = append(defs, fmt.Sprintf("  0x%016x %6d %-7s %s", s.Value, s.Size, elf.ST_TYPE(s.Info), s.Name))
		}
		if len(defs) > 0 {
			lines = append(lines, fmt.Sprintf("## Defined Symbols (%d)", len(defs)))
			lines = append(lines, defs...)
		}
		if len(lines) == 0 {
			return "", false
		}
		return strings.Join(lines, "\n"), true

	case isPEBytes(header):
		f, err := pe.Open(target)
		if err != nil {
			return "", false
		}
		defer f.Close()
		var lines []string
		if imps, _ := f.ImportedSymbols(); len(imps) > 0 {
			lines = append(lines, fmt.Sprintf("## Imported Symbols (%d)", len(imps)))
			for _, imp := range imps {
				lines = append(lines, "  "+imp)
			}
			lines = append(lines, "")
		}
		data, _, _ := readBoundedFile(target, maxBinaryAnalyzeBytes)
		if exps := parsePEExports(f, data); len(exps) > 0 {
			lines = append(lines, fmt.Sprintf("## Exported Symbols (%d)", len(exps)))
			for _, exp := range exps {
				lines = append(lines, "  "+exp)
			}
		}
		if len(lines) == 0 {
			return "", false
		}
		return strings.Join(lines, "\n"), true

	case isMachOBytes(header):
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
			return "", false
		}
		var lines []string
		if libs, _ := f.ImportedLibraries(); len(libs) > 0 {
			lines = append(lines, "## Linked Dylibs", strings.Join(libs, ", "), "")
		}
		if imps, _ := f.ImportedSymbols(); len(imps) > 0 {
			lines = append(lines, fmt.Sprintf("## Imported Symbols (%d)", len(imps)))
			for _, imp := range imps {
				lines = append(lines, "  U "+imp)
			}
			lines = append(lines, "")
		}
		if f.Symtab != nil && len(f.Symtab.Syms) > 0 {
			lines = append(lines, fmt.Sprintf("## Symtab (%d)", len(f.Symtab.Syms)))
			for _, sym := range f.Symtab.Syms {
				if sym.Name != "" {
					lines = append(lines, fmt.Sprintf("  0x%016x  %s", sym.Value, sym.Name))
				}
			}
		}
		if len(lines) == 0 {
			return "", false
		}
		return strings.Join(lines, "\n"), true
	}
	return "", false
}

// --- anti-analysis & packer scan --------------------------------------------

type antiFinding struct {
	category   string
	confidence string
	desc       string
	detail     string
}

func scanAntiAnalysis(target, rel string) (string, map[string]any, error) {
	data, fullSize, err := readBoundedFile(target, maxBinaryAnalyzeBytes)
	if err != nil {
		return "", nil, err
	}
	strs := extractAllStrings(data, 4)
	var findings []antiFinding

	matchRule := func(cat, conf, needle, desc string, caseInsensitive bool) {
		for _, s := range strs {
			matched := false
			if caseInsensitive {
				matched = strings.Contains(strings.ToLower(s), strings.ToLower(needle))
			} else {
				matched = strings.Contains(s, needle)
			}
			if matched {
				sample := s
				if len(sample) > 72 {
					sample = sample[:72] + "..."
				}
				findings = append(findings, antiFinding{cat, conf, desc, fmt.Sprintf("%q", sample)})
				return
			}
		}
	}

	// Anti-debug
	for _, r := range []struct{ n, d, c string }{
		{"ptrace", "ptrace reference (PTRACE_TRACEME self-trace check)", "high"},
		{"/proc/self/status", "TracerPid check via /proc/self/status", "high"},
		{"TracerPid", "Explicit TracerPid debugger detection", "high"},
		{"/proc/self/maps", "Memory map inspection (/proc/self/maps)", "medium"},
		{"/proc/self/task", "Thread / debugger task dir inspection", "medium"},
		{"PR_SET_DUMPABLE", "prctl(PR_SET_DUMPABLE) core-dump suppression", "medium"},
		{"PT_DENY_ATTACH", "macOS/iOS PT_DENY_ATTACH anti-debug", "high"},
		{"P_TRACED", "sysctl P_TRACED debugger check", "high"},
		{"IsDebuggerPresent", "Win32 IsDebuggerPresent check", "high"},
		{"CheckRemoteDebuggerPresent", "Win32 CheckRemoteDebuggerPresent check", "high"},
		{"NtQueryInformationProcess", "NtQueryInformationProcess ProcessDebugPort/Flags check", "high"},
		{"NtSetInformationThread", "ThreadHideFromDebugger anti-debug", "high"},
		{"OutputDebugString", "Win32 OutputDebugString check", "low"},
		{"x64dbg", "x64dbg debugger window/process check", "high"},
		{"OllyDbg", "OllyDbg debugger check", "high"},
	} {
		matchRule("anti_debug", r.c, r.n, r.d, false)
	}

	// Anti-Frida / dynamic instrumentation
	for _, r := range []struct{ n, d, c string }{
		{"frida-agent", "frida-agent library/maps scan", "high"},
		{"frida-gadget", "frida-gadget scan", "high"},
		{"frida-server", "frida-server process/port scan", "high"},
		{"gum-js-loop", "Frida GumJS thread name check", "high"},
		{"gmain", "GLib thread name check (Frida/GMain)", "low"},
		{"linjector", "Frida linjector tmp path check", "high"},
		{"LIBFRIDA", "Frida symbol/banner scan", "high"},
		{"27042", "Frida default port 27042 string check", "medium"},
		{"XposedBridge", "Xposed framework detection", "high"},
		{"de.robv.android.xposed", "Xposed package check", "high"},
		{"riru", "Riru/Zygisk injection check", "medium"},
		{"zygisk", "Zygisk module detection", "high"},
	} {
		matchRule("anti_frida", r.c, r.n, r.d, true)
	}

	// Anti-VM / emulator
	for _, r := range []struct{ n, d, c string }{
		{"VMwareVMware", "CPUID VMware hypervisor signature", "high"},
		{"VBoxVBoxVBox", "CPUID VirtualBox signature", "high"},
		{"KVMKVMKVM", "CPUID KVM signature", "high"},
		{"XenVMMXenVMM", "CPUID Xen signature", "high"},
		{"goldfish", "Android QEMU goldfish kernel/hardware check", "medium"},
		{"ranchu", "Android emulator ranchu hardware check", "medium"},
		{"ro.kernel.qemu", "Android ro.kernel.qemu system property check", "high"},
		{"vboxsf", "VirtualBox shared folder check", "medium"},
	} {
		matchRule("anti_vm", r.c, r.n, r.d, false)
	}

	// Anti-root / jailbreak
	for _, r := range []struct{ n, d, c string }{
		{"/system/xbin/su", "Android su binary path check", "high"},
		{"/sbin/su", "su binary path check", "high"},
		{"com.topjohnwu.magisk", "Magisk package detection", "high"},
		{"/data/adb/magisk", "Magisk data path detection", "high"},
		{"Shamiko", "Shamiko root-hiding detection", "high"},
		{"PlayIntegrity", "Google Play Integrity attestation", "medium"},
		{"SafetyNet", "SafetyNet attestation", "medium"},
		{"/Applications/Cydia.app", "iOS Cydia jailbreak path check", "high"},
		{"MobileSubstrate", "iOS MobileSubstrate hook check", "high"},
	} {
		matchRule("anti_root", r.c, r.n, r.d, false)
	}

	// Packers & protectors
	for _, r := range []struct{ n, d, c string }{
		{"UPX!", "UPX packer header/magic", "high"},
		{"VMProtect", "VMProtect virtualization/packing", "high"},
		{".vmp0", "VMProtect .vmp0 section", "high"},
		{"Themida", "Themida/WinLicense protector", "high"},
		{".themida", "Themida section", "high"},
		{"ASPack", "ASPack packer", "high"},
		{".MPRESS", "MPRESS packer", "high"},
		{"libjiagu", "Qihoo 360 Jiagu Android packer", "high"},
		{"libshell", "Tencent Legu Android packer", "high"},
		{"libsecexe", "Bangcle/SecNeo Android packer", "high"},
		{"ijiami", "Ijiami Android packer", "high"},
		{"libnesec", "NetEase Yidun protector", "high"},
		{"MEI\x0c\x0b\x0a\x0b\x0e", "PyInstaller frozen Python archive", "high"},
	} {
		matchRule("packer_obfuscation", r.c, r.n, r.d, false)
	}
	if bytes.Contains(data, []byte("UPX!")) {
		hasUPX := false
		for _, f := range findings {
			if strings.Contains(f.desc, "UPX") {
				hasUPX = true
			}
		}
		if !hasUPX {
			findings = append(findings, antiFinding{"packer_obfuscation", "high", "UPX! byte magic present", "bytes: 55 50 58 21"})
		}
	}

	// Architecture-gated executable section checks (avoids false positives on random data!)
	scanExecSectionAnomalies(target, data, &findings)

	overallEnt := shannonEntropy(data)
	if overallEnt >= 7.35 {
		findings = append(findings, antiFinding{
			"packer_obfuscation", "medium",
			fmt.Sprintf("High overall file entropy (%.2f bits/byte) — compressed, encrypted, or packed", overallEnt),
			"whole-file shannon entropy",
		})
	}

	out := []string{
		"ANTI-ANALYSIS & PACKER SCAN",
		"path: " + rel,
		fmt.Sprintf("size: %d bytes  entropy: %.3f bits/byte", fullSize, overallEnt),
		fmt.Sprintf("findings: %d", len(findings)),
		"",
	}
	if len(findings) == 0 {
		out = append(out, "- No obvious anti-analysis, anti-Frida, or packer signatures detected.")
	} else {
		for _, f := range findings {
			out = append(out, fmt.Sprintf("- [%s | %s] %s (%s)", f.category, f.confidence, f.desc, f.detail))
		}
	}
	if hints := antiBypassHints(findings); len(hints) > 0 {
		out = append(out, "", "bypass hints:")
		out = append(out, bullets(hints, "")...)
	}
	return strings.Join(out, "\n"), map[string]any{"findings": len(findings), "entropy": overallEnt}, nil
}

func scanExecSectionAnomalies(target string, data []byte, findings *[]antiFinding) {
	if len(data) >= 4 && bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		f, err := elf.Open(target)
		if err != nil {
			return
		}
		defer f.Close()
		for _, p := range f.Progs {
			if p.Type == elf.PT_LOAD && p.Flags&(elf.PF_R|elf.PF_W|elf.PF_X) == (elf.PF_R|elf.PF_W|elf.PF_X) {
				*findings = append(*findings, antiFinding{
					"packer_obfuscation", "high",
					"RWX PT_LOAD segment (self-modifying code or runtime unpacker stub)",
					fmt.Sprintf("vaddr=0x%x memsz=0x%x", p.Vaddr, p.Memsz),
				})
			}
		}
		for _, s := range f.Sections {
			if s.Flags&elf.SHF_EXECINSTR == 0 || s.Size == 0 || s.Type == elf.SHT_NOBITS {
				continue
			}
			raw, err := s.Data()
			if err != nil || len(raw) == 0 {
				continue
			}
			ent := shannonEntropy(raw)
			if ent >= 7.3 {
				*findings = append(*findings, antiFinding{
					"packer_obfuscation", "high",
					fmt.Sprintf("Encrypted/packed executable section %s (entropy %.2f)", s.Name, ent),
					fmt.Sprintf("addr=0x%x size=0x%x", s.Addr, s.Size),
				})
			}
			if f.Machine == elf.EM_AARCH64 && len(raw)%4 == 0 {
				svcCount := 0
				var firstOff int
				for i := 0; i+4 <= len(raw); i += 4 {
					// ARM64 `svc #0` = 0xd4000001 (LE: 01 00 00 d4)
					if raw[i] == 0x01 && raw[i+1] == 0x00 && raw[i+2] == 0x00 && raw[i+3] == 0xd4 {
						if svcCount == 0 {
							firstOff = i
						}
						svcCount++
					}
				}
				if svcCount > 0 {
					*findings = append(*findings, antiFinding{
						"anti_frida", "high",
						fmt.Sprintf("Direct ARM64 `svc #0` instructions in %s (%d hits) — bypasses libc PLT/Frida hooks", s.Name, svcCount),
						fmt.Sprintf("first at VA 0x%x", s.Addr+uint64(firstOff)),
					})
				}
			}
			if f.Machine == elf.EM_X86_64 || f.Machine == elf.EM_386 {
				if idx := bytes.Index(raw, []byte{0x0f, 0x31}); idx >= 0 {
					*findings = append(*findings, antiFinding{
						"anti_debug", "low",
						fmt.Sprintf("x86 RDTSC timing instruction in %s", s.Name),
						fmt.Sprintf("VA 0x%x", s.Addr+uint64(idx)),
					})
				}
			}
		}
	}
}

func antiBypassHints(findings []antiFinding) []string {
	var hints []string
	seen := map[string]bool{}
	add := func(h string) {
		if !seen[h] {
			seen[h] = true
			hints = append(hints, h)
		}
	}
	for _, f := range findings {
		switch {
		case strings.Contains(f.desc, "svc #0"):
			add("Direct ARM64 SVC: libc hooks (openat/ptrace/read) will miss these; use seccomp/ptrace, kernel module, Stalker, or Unicorn/unidbg syscall hooks.")
		case strings.Contains(f.desc, "ptrace"):
			add("ptrace: NOP PTRACE_TRACEME or hook ptrace() to return 0 on first call.")
		case strings.Contains(f.desc, "TracerPid") || strings.Contains(f.desc, "/proc/self/status"):
			add("TracerPid: rewrite /proc/self/status read buffer so TracerPid reports 0.")
		case strings.Contains(f.desc, "IsDebuggerPresent") || strings.Contains(f.desc, "NtQueryInformationProcess"):
			add("Win32 anti-debug: use ScyllaHide in x64dbg or clear PEB.BeingDebugged / NtGlobalFlag.")
		case f.category == "anti_frida":
			add("Frida detection: rename frida-server, run on a custom port (-l 0.0.0.0:21337), check .init_array threads before JNI_OnLoad, or emulate offline with unidbg.")
		case strings.Contains(f.desc, "UPX"):
			add("UPX: test `upx -d` first; if header magic/l_info is patched, repair UPX header or dump after OEP jump.")
		case strings.Contains(f.desc, "RWX") || strings.Contains(f.desc, "Encrypted/packed executable"):
			add("Packed/RWX stub: break after .init_array / VirtualProtect / mprotect transition and dump unpacked memory.")
		}
	}
	return hints
}

// --- binary diffing (x86/x64 + ARM64 patch recognition) ---------------------

func diffBinaryFiles(pathA, relA, pathB, relB string, maxDiffs, ctxBytes int) (string, map[string]any, error) {
	dataA, sizeA, err := readBoundedFile(pathA, maxBinaryAnalyzeBytes)
	if err != nil {
		return "", nil, err
	}
	dataB, sizeB, err := readBoundedFile(pathB, maxBinaryAnalyzeBytes)
	if err != nil {
		return "", nil, err
	}
	hashA, _ := sha256File(pathA)
	hashB, _ := sha256File(pathB)

	minLen := minInt(len(dataA), len(dataB))
	matching := 0
	type region struct {
		start, end int
		notes      []string
	}
	var regions []region
	totalRegions := 0

	i := 0
	for i < minLen {
		if dataA[i] == dataB[i] {
			matching++
			i++
			continue
		}
		start := i
		end := i
		for end < minLen {
			if dataA[end] != dataB[end] {
				end++
				continue
			}
			gapEnd := minInt(minLen, end+maxInt(1, ctxBytes))
			allSame := true
			for j := end; j < gapEnd; j++ {
				if dataA[j] != dataB[j] {
					allSame = false
					break
				}
			}
			if allSame {
				break
			}
			matching++
			end++
		}
		totalRegions++
		if len(regions) < maxDiffs {
			regions = append(regions, region{
				start: start, end: end,
				notes: classifyPatchBytes(dataA[start:end], dataB[start:end]),
			})
		}
		i = end
	}

	pct := 100.0
	if minLen > 0 {
		pct = float64(matching) / float64(minLen) * 100.0
	}
	out := []string{
		"BINARY DIFF",
		fmt.Sprintf("A: %s (%d bytes, sha256 %s…)", relA, sizeA, hashA[:minInt(12, len(hashA))]),
		fmt.Sprintf("B: %s (%d bytes, sha256 %s…)", relB, sizeB, hashB[:minInt(12, len(hashB))]),
		fmt.Sprintf("compared: %d bytes  matching: %.2f%%  size_delta: %+d  diff_regions: %d",
			minLen, pct, sizeB-sizeA, totalRegions),
		"",
	}
	if totalRegions == 0 && sizeA == sizeB {
		out = append(out, "Files are byte-identical.")
	}
	for idx, r := range regions {
		cStart := maxInt(0, r.start-ctxBytes)
		cEnd := minInt(minLen, r.end+ctxBytes)
		noteStr := ""
		if len(r.notes) > 0 {
			noteStr = "  [" + strings.Join(r.notes, "; ") + "]"
		}
		out = append(out,
			fmt.Sprintf("#%d offset=0x%08x len=%d%s", idx+1, r.start, r.end-r.start, noteStr),
			"  - A: "+hex.EncodeToString(dataA[r.start:r.end])+"  (ctx "+hex.EncodeToString(dataA[cStart:cEnd])+")",
			"  + B: "+hex.EncodeToString(dataB[r.start:r.end])+"  (ctx "+hex.EncodeToString(dataB[cStart:cEnd])+")",
		)
	}
	if totalRegions > len(regions) {
		out = append(out, fmt.Sprintf("… %d additional diff regions omitted (increase maxDiffs)", totalRegions-len(regions)))
	}
	return strings.Join(out, "\n"), map[string]any{
		"sizeA": sizeA, "sizeB": sizeB, "sha256A": hashA, "sha256B": hashB,
		"diffRegions": totalRegions, "matchingPct": pct,
	}, nil
}

func classifyPatchBytes(a, b []byte) []string {
	var notes []string
	if len(a) == 0 || len(b) == 0 {
		return notes
	}
	allByte := func(buf []byte, v byte) bool {
		for _, x := range buf {
			if x != v {
				return false
			}
		}
		return true
	}
	if allByte(b, 0x90) && !allByte(a, 0x90) {
		notes = append(notes, "x86 NOP sled patch")
	}
	if len(b)%4 == 0 {
		arm64Nop := true
		for i := 0; i < len(b); i += 4 {
			if !bytes.Equal(b[i:i+4], []byte{0x1f, 0x20, 0x03, 0xd5}) {
				arm64Nop = false
				break
			}
		}
		if arm64Nop {
			notes = append(notes, "ARM64 NOP patch (1f 20 03 d5)")
		}
	}
	if allByte(b, 0x00) && !allByte(a, 0x00) {
		notes = append(notes, "zeroed-out bytes")
	}
	if len(a) == 1 && len(b) == 1 {
		pairs := []struct {
			from, to byte
			label    string
		}{
			{0x74, 0x75, "x86 JE→JNE"}, {0x75, 0x74, "x86 JNE→JE"},
			{0x74, 0xeb, "x86 JE→JMP"}, {0x75, 0xeb, "x86 JNE→JMP"},
			{0x84, 0x85, "x86 near JE→JNE"}, {0x85, 0x84, "x86 near JNE→JE"},
			{0x34, 0x35, "ARM64 CBZ→CBNZ"}, {0x35, 0x34, "ARM64 CBNZ→CBZ"},
			{0xb4, 0xb5, "ARM64 CBZ(64)→CBNZ(64)"}, {0xb5, 0xb4, "ARM64 CBNZ(64)→CBZ(64)"},
			{0x36, 0x37, "ARM64 TBZ→TBNZ"}, {0x37, 0x36, "ARM64 TBNZ→TBZ"},
		}
		for _, p := range pairs {
			if a[0] == p.from && b[0] == p.to {
				notes = append(notes, p.label)
			}
		}
	}
	if len(b) == 4 {
		switch {
		case bytes.Equal(b, []byte{0x20, 0x00, 0x80, 0x52}):
			notes = append(notes, "ARM64 `mov w0, #1` force-true patch")
		case bytes.Equal(b, []byte{0x00, 0x00, 0x80, 0x52}):
			notes = append(notes, "ARM64 `mov w0, #0` force-zero patch")
		case bytes.Equal(b, []byte{0x20, 0x00, 0x80, 0xd2}):
			notes = append(notes, "ARM64 `mov x0, #1` force-true patch")
		case bytes.Equal(b, []byte{0x00, 0x00, 0x80, 0xd2}):
			notes = append(notes, "ARM64 `mov x0, #0` force-zero patch")
		case bytes.Equal(b, []byte{0xc0, 0x03, 0x5f, 0xd6}):
			notes = append(notes, "ARM64 `ret` early-return patch")
		}
	}
	if len(b) == 8 && bytes.Equal(b, []byte{0x20, 0x00, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6}) {
		notes = append(notes, "ARM64 `mov w0, #1; ret` force-true patch")
	}
	if len(b) == 8 && bytes.Equal(b, []byte{0x00, 0x00, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6}) {
		notes = append(notes, "ARM64 `mov w0, #0; ret` force-zero patch")
	}
	return notes
}

// --- pure-Go Android AXML manifest string-pool extractor --------------------

type apkManifestInfo struct {
	Package     string
	Application string
	Permissions []string
	Components  []string
}

var javaPkgNameRE = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_$]+){2,}$`)

func parseAPKManifestHints(apkPath string) *apkManifestInfo {
	zr, err := zip.OpenReader(apkPath)
	if err != nil {
		return nil
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != "AndroidManifest.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil
		}
		raw, err := io.ReadAll(io.LimitReader(rc, 4*1024*1024))
		rc.Close()
		if err != nil || len(raw) < 16 {
			return nil
		}
		pool := decodeAXMLStringPool(raw)
		if len(pool) == 0 {
			return nil
		}
		return classifyManifestPool(pool)
	}
	return nil
}

// decodeAXMLStringPool parses the ResStringPool (type 0x0001) inside binary
// AndroidManifest.xml (magic 0x00080003).
func decodeAXMLStringPool(data []byte) []string {
	if len(data) < 16 || binary.LittleEndian.Uint32(data[0:4]) != 0x00080003 {
		return nil
	}
	pos := 8
	for pos+8 <= len(data) {
		chunkType := binary.LittleEndian.Uint16(data[pos : pos+2])
		headerSize := int(binary.LittleEndian.Uint16(data[pos+2 : pos+4]))
		chunkSize := int(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		if chunkSize < 8 || pos+chunkSize > len(data) {
			break
		}
		if chunkType == 0x0001 && chunkSize >= 28 && headerSize >= 28 {
			strCount := int(binary.LittleEndian.Uint32(data[pos+8 : pos+12]))
			flags := binary.LittleEndian.Uint32(data[pos+16 : pos+20])
			stringsStart := pos + int(binary.LittleEndian.Uint32(data[pos+20:pos+24]))
			isUTF8 := flags&(1<<8) != 0
			offsetsBase := pos + headerSize
			var out []string
			for i := 0; i < strCount && offsetsBase+(i+1)*4 <= pos+chunkSize; i++ {
				off := stringsStart + int(binary.LittleEndian.Uint32(data[offsetsBase+i*4:offsetsBase+(i+1)*4]))
				if off < stringsStart || off >= pos+chunkSize {
					continue
				}
				s := readAXMLString(data[off:pos+chunkSize], isUTF8)
				if s != "" {
					out = append(out, s)
				}
			}
			return out
		}
		pos += chunkSize
	}
	return nil
}

func readAXMLString(buf []byte, isUTF8 bool) string {
	if len(buf) < 2 {
		return ""
	}
	if isUTF8 {
		// Skip UTF-16 char length varint (1 or 2 bytes), then read UTF-8 byte length varint.
		idx := 1
		if buf[0]&0x80 != 0 {
			idx = 2
		}
		if idx >= len(buf) {
			return ""
		}
		byteLen := int(buf[idx])
		idx++
		if byteLen&0x80 != 0 {
			if idx >= len(buf) {
				return ""
			}
			byteLen = ((byteLen & 0x7f) << 8) | int(buf[idx])
			idx++
		}
		if idx+byteLen > len(buf) {
			return ""
		}
		return string(buf[idx : idx+byteLen])
	}
	charLen := int(binary.LittleEndian.Uint16(buf[0:2]))
	idx := 2
	if charLen&0x8000 != 0 {
		if len(buf) < 4 {
			return ""
		}
		charLen = ((charLen & 0x7fff) << 16) | int(binary.LittleEndian.Uint16(buf[2:4]))
		idx = 4
	}
	if charLen <= 0 || charLen > 4096 || idx+charLen*2 > len(buf) {
		return ""
	}
	u16 := make([]uint16, charLen)
	for i := 0; i < charLen; i++ {
		u16[i] = binary.LittleEndian.Uint16(buf[idx+i*2 : idx+(i+1)*2])
	}
	return string(utf16.Decode(u16))
}

func classifyManifestPool(pool []string) *apkManifestInfo {
	info := &apkManifestInfo{}
	seenPerm := map[string]bool{}
	seenComp := map[string]bool{}
	stubHints := regexp.MustCompile(`(?i)(StubApp|WrapperProxyApplication|SecShell|ApplicationWrapper|TxAppEntry|ProtectedApp|DexProtector)`)
	for _, s := range pool {
		s = strings.TrimSpace(s)
		switch {
		case strings.HasPrefix(s, "android.permission.") || strings.HasSuffix(s, ".permission.C2D_MESSAGE"):
			if !seenPerm[s] {
				seenPerm[s] = true
				info.Permissions = append(info.Permissions, s)
			}
		case stubHints.MatchString(s):
			if info.Application == "" {
				info.Application = s
			}
		case javaPkgNameRE.MatchString(s) && !strings.HasPrefix(s, "android.") && !strings.HasPrefix(s, "androidx."):
			last := s[strings.LastIndexByte(s, '.')+1:]
			if len(last) > 0 && last[0] >= 'a' && last[0] <= 'z' && info.Package == "" {
				info.Package = s
			} else if len(last) > 0 && last[0] >= 'A' && last[0] <= 'Z' {
				if strings.HasSuffix(s, "App") || strings.HasSuffix(s, "Application") {
					if info.Application == "" {
						info.Application = s
					}
				} else if !seenComp[s] && len(info.Components) < 25 {
					seenComp[s] = true
					info.Components = append(info.Components, s)
				}
			}
		}
	}
	sort.Strings(info.Permissions)
	return info
}

// --- format & string helpers ------------------------------------------------

func extractAllStrings(data []byte, minLength int) []string {
	ascii := extractPrintableStrings(data, minLength)
	wide := extractUTF16LEStrings(data, minLength)
	return append(ascii, wide...)
}

func extractUTF16LEStrings(data []byte, minLength int) []string {
	var out []string
	var cur []byte
	for i := 0; i+1 < len(data); i += 2 {
		if isPrintableByte(data[i]) && data[i+1] == 0 {
			cur = append(cur, data[i])
			continue
		}
		if len(cur) >= minLength {
			out = append(out, string(cur))
		}
		cur = cur[:0]
	}
	if len(cur) >= minLength {
		out = append(out, string(cur))
	}
	return out
}

func isPEBytes(data []byte) bool {
	if len(data) < 0x40 || data[0] != 'M' || data[1] != 'Z' {
		return false
	}
	lfanew := int(binary.LittleEndian.Uint32(data[0x3c:0x40]))
	if lfanew < 0x40 || lfanew+4 > len(data) {
		return false
	}
	return bytes.Equal(data[lfanew:lfanew+4], []byte{'P', 'E', 0, 0})
}

func isMachOBytes(data []byte) bool {
	if len(data) < 8 {
		return false
	}
	magic := binary.BigEndian.Uint32(data[0:4])
	switch magic {
	case 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe:
		return true
	case 0xcafebabe:
		// Distinguish Universal Mach-O (nfat_arch typically 1..16) from Java .class (minor/major >= 45).
		nfat := binary.BigEndian.Uint32(data[4:8])
		return nfat >= 1 && nfat <= 20
	}
	return false
}

func elfProgFlags(flags elf.ProgFlag) string {
	var b strings.Builder
	if flags&elf.PF_R != 0 {
		b.WriteByte('R')
	} else {
		b.WriteByte('-')
	}
	if flags&elf.PF_W != 0 {
		b.WriteByte('W')
	} else {
		b.WriteByte('-')
	}
	if flags&elf.PF_X != 0 {
		b.WriteByte('X')
	} else {
		b.WriteByte('-')
	}
	return b.String()
}

func elfSecFlags(flags elf.SectionFlag) string {
	var b strings.Builder
	if flags&elf.SHF_ALLOC != 0 {
		b.WriteByte('A')
	}
	if flags&elf.SHF_WRITE != 0 {
		b.WriteByte('W')
	}
	if flags&elf.SHF_EXECINSTR != 0 {
		b.WriteByte('X')
	}
	if b.Len() == 0 {
		return "-"
	}
	return b.String()
}

func elfHasBindNow(f *elf.File) bool {
	ds := f.SectionByType(elf.SHT_DYNAMIC)
	if ds == nil {
		return false
	}
	raw, err := ds.Data()
	if err != nil {
		return false
	}
	step := 16
	if f.Class == elf.ELFCLASS32 {
		step = 8
	}
	for i := 0; i+step <= len(raw); i += step {
		var tag, val uint64
		if step == 16 {
			tag = f.ByteOrder.Uint64(raw[i : i+8])
			val = f.ByteOrder.Uint64(raw[i+8 : i+16])
		} else {
			tag = uint64(f.ByteOrder.Uint32(raw[i : i+4]))
			val = uint64(f.ByteOrder.Uint32(raw[i+4 : i+8]))
		}
		if tag == 0 {
			break
		}
		if tag == uint64(elf.DT_BIND_NOW) {
			return true
		}
		if tag == uint64(elf.DT_FLAGS) && val&0x8 != 0 {
			return true
		}
		if tag == 0x6ffffffb && val&0x1 != 0 { // DT_FLAGS_1 & DF_1_NOW
			return true
		}
	}
	return false
}

func elfHasPIEFlag(f *elf.File) bool {
	ds := f.SectionByType(elf.SHT_DYNAMIC)
	if ds == nil {
		return false
	}
	raw, err := ds.Data()
	if err != nil {
		return false
	}
	step := 16
	if f.Class == elf.ELFCLASS32 {
		step = 8
	}
	for i := 0; i+step <= len(raw); i += step {
		var tag, val uint64
		if step == 16 {
			tag = f.ByteOrder.Uint64(raw[i : i+8])
			val = f.ByteOrder.Uint64(raw[i+8 : i+16])
		} else {
			tag = uint64(f.ByteOrder.Uint32(raw[i : i+4]))
			val = uint64(f.ByteOrder.Uint32(raw[i+4 : i+8]))
		}
		if tag == 0x6ffffffb && val&0x08000000 != 0 { // DF_1_PIE
			return true
		}
	}
	return false
}

func peSectionPerms(chars uint32) string {
	var b strings.Builder
	if chars&0x40000000 != 0 {
		b.WriteByte('R')
	} else {
		b.WriteByte('-')
	}
	if chars&0x80000000 != 0 {
		b.WriteByte('W')
	} else {
		b.WriteByte('-')
	}
	if chars&0x20000000 != 0 {
		b.WriteByte('X')
	} else {
		b.WriteByte('-')
	}
	return b.String()
}

func peMachineName(m uint16) string {
	switch m {
	case 0x14c:
		return "x86 (i386)"
	case 0x8664:
		return "x86_64 (AMD64)"
	case 0x1c0, 0x1c4:
		return "ARM"
	case 0xaa64:
		return "ARM64"
	default:
		return fmt.Sprintf("0x%x", m)
	}
}

func peSubsystemName(s uint16) string {
	switch s {
	case 1:
		return "Native/Driver"
	case 2:
		return "Windows GUI"
	case 3:
		return "Windows Console"
	case 10, 11, 12:
		return "UEFI"
	default:
		return fmt.Sprintf("%d", s)
	}
}

func parsePEExports(f *pe.File, raw []byte) []string {
	var dir pe.DataDirectory
	switch opt := f.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		dir = opt.DataDirectory[0]
	case *pe.OptionalHeader64:
		dir = opt.DataDirectory[0]
	default:
		return nil
	}
	if dir.VirtualAddress == 0 || dir.Size < 40 {
		return nil
	}
	rvaToOff := func(rva uint32) (int, bool) {
		for _, s := range f.Sections {
			span := s.VirtualSize
			if s.Size > span {
				span = s.Size
			}
			if rva >= s.VirtualAddress && rva < s.VirtualAddress+span {
				off := int(s.Offset + (rva - s.VirtualAddress))
				if off >= 0 && off < len(raw) {
					return off, true
				}
			}
		}
		return 0, false
	}
	off, ok := rvaToOff(dir.VirtualAddress)
	if !ok || off+40 > len(raw) {
		return nil
	}
	numNames := int(binary.LittleEndian.Uint32(raw[off+24 : off+28]))
	namesRVA := binary.LittleEndian.Uint32(raw[off+32 : off+36])
	namesOff, ok := rvaToOff(namesRVA)
	if !ok {
		return nil
	}
	if numNames > 500 {
		numNames = 500
	}
	var out []string
	for i := 0; i < numNames && namesOff+(i+1)*4 <= len(raw); i++ {
		strRVA := binary.LittleEndian.Uint32(raw[namesOff+i*4 : namesOff+(i+1)*4])
		if strOff, sOK := rvaToOff(strRVA); sOK {
			end := bytes.IndexByte(raw[strOff:], 0)
			if end > 0 && end < 256 {
				out = append(out, string(raw[strOff:strOff+end]))
			}
		}
	}
	return out
}

func readULEB128(buf []byte) (uint64, int) {
	var val uint64
	var shift uint
	for i, b := range buf {
		if i >= 10 {
			return 0, 0
		}
		val |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return val, i + 1
		}
		shift += 7
	}
	return 0, 0
}

func capStrings(items []string, limit int) []string {
	if len(items) <= limit {
		return items
	}
	out := make([]string, limit+1)
	copy(out, items[:limit])
	out[limit] = fmt.Sprintf("… (%d more omitted)", len(items)-limit)
	return out
}

func minUint64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}
