package tools

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

func ctfTriageTool() types.Tool {
	return types.Tool{
		Name:        "ctf_triage",
		Description: "Fast offline CTF artifact triage: file type, magic, hash, entropy, string categories, flag/URL/encoding hints, and next-step suggestions.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":       map[string]any{"type": "string", "description": "Workspace-relative file or directory path."},
			"maxBytes":   map[string]any{"type": "number", "default": 1048576, "description": "Maximum bytes to sample from a file."},
			"maxStrings": map[string]any{"type": "number", "default": 40, "description": "Maximum interesting strings to show."},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			info, err := os.Stat(target)
			if err != nil {
				return types.ToolResult{}, err
			}
			if info.IsDir() {
				var entries []string
				walkTree(target, tc.Workspace, true, clampInt(util.AsInt(args["maxStrings"], 40), 1, 200), &entries)
				body := strings.Join(entries, "\n")
				if body == "" {
					body = "(empty)"
				}
				rel := relative(tc.Workspace, target)
				if rel == "" {
					rel = "."
				}
				text := strings.Join([]string{
					"CTF TRIAGE", "path: " + rel, "kind: directory", "", "entries:", body,
				}, "\n")
				return textResult(text, map[string]any{"kind": "directory", "entries": len(entries)}), nil
			}

			maxBytes := clampInt(util.AsInt(args["maxBytes"], 1_048_576), 1024, 8*1024*1024)
			sample, err := readPrefix(target, int(min64(info.Size(), int64(maxBytes))))
			if err != nil {
				return types.ToolResult{}, err
			}
			rel := relative(tc.Workspace, target)
			fileType := "(file unavailable)"
			if result, err := Run([]string{"file", "-b", target}, RunOptions{
				Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context(),
			}); err == nil {
				candidate := strings.TrimSpace(result.Stdout)
				if candidate == "" {
					candidate = strings.TrimSpace(result.Stderr)
				}
				if candidate != "" {
					fileType = candidate
				}
			}
			found := extractPrintableStrings(sample, 4)
			classified := classifyStrings(found, clampInt(util.AsInt(args["maxStrings"], 40), 1, 200))
			digest, err := sha256File(target)
			if err != nil {
				return types.ToolResult{}, err
			}
			first := sample
			if len(first) > 16 {
				first = first[:16]
			}
			entropy := shannonEntropy(sample)
			printable := printableRatio(sample)
			hints := triageHints(fileType, found, entropy, printable)

			magicHex := hex.EncodeToString(first)
			if magicHex == "" {
				magicHex = "(empty)"
			}
			magicAscii := asciiPreview(first)
			if magicAscii == "" {
				magicAscii = "(empty)"
			}
			out := []string{
				"CTF TRIAGE",
				"path: " + rel,
				"type: " + fileType,
				fmt.Sprintf("size: %d bytes", info.Size()),
				"sha256: " + digest,
				"magic.hex: " + magicHex,
				"magic.ascii: " + magicAscii,
				fmt.Sprintf("sample: %d/%d bytes", len(sample), info.Size()),
				fmt.Sprintf("entropy: %.3f bits/byte", entropy),
				fmt.Sprintf("printable: %.1f%%", printable*100),
				"",
				"signals:",
			}
			if len(classified) == 0 {
				out = append(out, "- none found in sample")
			}
			for _, item := range classified {
				out = append(out, fmt.Sprintf("- %s: %s", item.kind, item.value))
			}
			out = append(out, "", "next:")
			for _, hint := range hints {
				out = append(out, "- "+hint)
			}
			if info.Size() > int64(len(sample)) {
				note := fmt.Sprintf("note: sampled first %d bytes; increase maxBytes for deeper scan", len(sample))
				out = append(out[:8], append([]string{note}, out[8:]...)...)
			}
			return textResult(util.Clip(strings.Join(out, "\n"), tc.Policy.MaxReadBytes), map[string]any{
				"kind": "file", "size": info.Size(), "sha256": digest,
				"entropy": entropy, "printable": printable, "signals": len(classified),
			}), nil
		},
	}
}

func entropyScanTool() types.Tool {
	return types.Tool{
		Name:        "entropy_scan",
		Description: "Scan a file with sliding-window entropy to spot packed, encrypted, compressed, or unusually structured regions.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":     map[string]any{"type": "string", "description": "Workspace-relative file path."},
			"window":   map[string]any{"type": "number", "default": 1024},
			"step":     map[string]any{"type": "number", "default": 512},
			"top":      map[string]any{"type": "number", "default": 12},
			"maxBytes": map[string]any{"type": "number", "default": 4194304},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			info, err := os.Stat(target)
			if err != nil {
				return types.ToolResult{}, err
			}
			if info.IsDir() {
				return types.ToolResult{}, fmt.Errorf("entropy_scan expects a file path")
			}
			maxBytes := clampInt(util.AsInt(args["maxBytes"], 4*1024*1024), 1024, 32*1024*1024)
			data, err := readPrefix(target, int(min64(info.Size(), int64(maxBytes))))
			if err != nil {
				return types.ToolResult{}, err
			}
			window := clampInt(util.AsInt(args["window"], 1024), 32, maxInt(32, len(data)))
			step := clampInt(util.AsInt(args["step"], window/2), 1, window)
			rows := entropyWindows(data, window, step)
			top := clampInt(util.AsInt(args["top"], 12), 1, 50)

			sorted := make([]entropyWindow, len(rows))
			copy(sorted, rows)
			sort.SliceStable(sorted, func(a, b int) bool { return sorted[a].entropy > sorted[b].entropy })
			if len(sorted) > top {
				sorted = sorted[:top]
			}
			sum, low, high := 0.0, math.Inf(1), 0.0
			for _, row := range rows {
				sum += row.entropy
				low = math.Min(low, row.entropy)
				high = math.Max(high, row.entropy)
			}
			average := sum / float64(maxInt(1, len(rows)))

			out := []string{
				"ENTROPY SCAN",
				"path: " + relative(tc.Workspace, target),
				fmt.Sprintf("size: %d bytes", info.Size()),
				fmt.Sprintf("sample: %d/%d bytes", len(data), info.Size()),
				fmt.Sprintf("window: %d  step: %d  windows: %d", window, step, len(rows)),
				fmt.Sprintf("entropy: min %.3f  avg %.3f  max %.3f", low, average, high),
				"",
				"highest windows:",
			}
			for _, row := range sorted {
				end := minInt(len(data), row.offset+minInt(16, window))
				chunk := data[row.offset:end]
				out = append(out, fmt.Sprintf("- 0x%08x  %.3f  %s  %s",
					row.offset, row.entropy, hex.EncodeToString(chunk), asciiPreview(chunk)))
			}
			if info.Size() > int64(len(data)) {
				note := fmt.Sprintf("note: sampled first %d bytes; increase maxBytes for deeper scan", len(data))
				out = append(out[:4], append([]string{note}, out[4:]...)...)
			}
			return textResult(util.Clip(strings.Join(out, "\n"), tc.Policy.MaxReadBytes), map[string]any{
				"size": info.Size(), "sampled": len(data), "window": window,
				"step": step, "windows": len(rows), "min": low, "avg": average, "max": high,
			}), nil
		},
	}
}

func binaryMitigationsTool() types.Tool {
	return types.Tool{
		Name:        "binary_mitigations",
		Description: "Summarize binary security posture for ELF/Mach-O/PE artifacts: arch, PIE, NX, canary, RELRO, stripped, and dangerous imports when available.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path": map[string]any{"type": "string", "description": "Workspace-relative binary path."},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			rel := relative(tc.Workspace, target)
			options := RunOptions{Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context()}
			fileType := "(file unavailable)"
			if result, err := Run([]string{"file", "-b", target}, options); err == nil {
				candidate := strings.TrimSpace(result.Stdout)
				if candidate == "" {
					candidate = strings.TrimSpace(result.Stderr)
				}
				if candidate != "" {
					fileType = candidate
				}
			}
			symbols := collectSymbols(target, tc)
			readelf, _ := Run([]string{"readelf", "-h", "-l", "-d", "-s", target}, options)
			otool, _ := Run([]string{"otool", "-hv", "-l", "-Iv", target}, options)
			combined := strings.Join([]string{fileType, symbols, readelf.Stdout, otool.Stdout}, "\n")

			findings := [][2]string{
				{"format", fileType},
				{"stripped", ternary(matches(`(?i)stripped`, fileType), "yes",
					ternary(matches(`(?i)not stripped`, fileType), "no", "unknown"))},
				{"PIE", ternary(matches(`\bDYN\b`, readelf.Stdout) || matches(`(?i)PIE`, fileType) || matches(`MH_PIE`, otool.Stdout),
					"likely yes", "unknown/no evidence")},
				{"NX", ternary(matches(`GNU_STACK[^\n]*RWE`, readelf.Stdout), "no (executable stack)",
					ternary(matches(`GNU_STACK`, readelf.Stdout), "likely yes", "unknown"))},
				{"canary", ternary(matches(`__stack_chk_fail|__stack_chk_guard`, combined), "yes", "no evidence")},
				{"RELRO", ternary(matches(`BIND_NOW|GNU_RELRO`, readelf.Stdout),
					ternary(matches(`BIND_NOW`, readelf.Stdout), "full/strong", "partial"), "unknown/no evidence")},
			}
			dangerous := dangerousImports(symbols)

			out := []string{"BINARY MITIGATIONS", "path: " + rel, ""}
			details := map[string]any{}
			for _, finding := range findings {
				out = append(out, fmt.Sprintf("%s: %s", finding[0], finding[1]))
				details[finding[0]] = finding[1]
			}
			out = append(out, "", "dangerous imports:")
			if len(dangerous) == 0 {
				out = append(out, "- none found in extracted symbols")
			}
			for _, item := range dangerous {
				out = append(out, "- "+item)
			}
			out = append(out,
				"",
				"notes:",
				"- Treat unknown as a prompt for deeper tool-specific analysis, not as absence.",
				"- For ELF, prefer readelf/checksec/r2/Ghidra if installed.",
			)
			return textResult(strings.Join(out, "\n"), details), nil
		},
	}
}

func findBytesTool() types.Tool {
	return types.Tool{
		Name:        "find_bytes",
		Description: "Find text, hex, or regex byte/string patterns in a workspace file and report offsets with hex/ascii context.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":       map[string]any{"type": "string"},
			"needle":     map[string]any{"type": "string", "description": "Text, hex bytes, or regex depending on mode."},
			"mode":       map[string]any{"type": "string", "enum": []string{"text", "hex", "regex"}, "default": "text"},
			"maxMatches": map[string]any{"type": "number", "default": 30},
			"context":    map[string]any{"type": "number", "default": 16},
		}, "path", "needle"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			data, err := os.ReadFile(target)
			if err != nil {
				return types.ToolResult{}, err
			}
			needle := util.AsString(args["needle"])
			mode := util.AsString(args["mode"], "text")
			maxMatches := clampInt(util.AsInt(args["maxMatches"], 30), 1, 200)
			contextBytes := clampInt(util.AsInt(args["context"], 16), 0, 128)
			offsets, err := findPatternOffsets(data, needle, mode, maxMatches)
			if err != nil {
				return types.ToolResult{}, err
			}
			limitNote := ""
			if len(offsets) == maxMatches {
				limitNote = " (limit reached)"
			}
			out := []string{
				"FIND BYTES",
				"path: " + relative(tc.Workspace, target),
				"mode: " + mode,
				fmt.Sprintf("matches: %d%s", len(offsets), limitNote),
				"",
			}
			for _, offset := range offsets {
				start := maxInt(0, offset-contextBytes)
				end := minInt(len(data), offset+contextBytes+maxInt(1, patternLength(needle, mode)))
				chunk := data[start:end]
				out = append(out, fmt.Sprintf("- 0x%08x  %s  %s", offset, hex.EncodeToString(chunk), asciiPreview(chunk)))
			}
			return textResult(strings.Join(out, "\n"), map[string]any{"matches": len(offsets)}), nil
		},
	}
}

func carveArtifactsTool() types.Tool {
	return types.Tool{
		Name:        "carve_artifacts",
		Description: "Locate embedded file signatures such as ELF, PE, ZIP, DEX, PNG, JPEG, PDF, SQLite, gzip, Mach-O; optionally extract slices with --write enabled.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":         map[string]any{"type": "string"},
			"extract":      map[string]any{"type": "boolean", "default": false},
			"outDir":       map[string]any{"type": "string", "default": "carved"},
			"maxArtifacts": map[string]any{"type": "number", "default": 50},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			data, err := os.ReadFile(target)
			if err != nil {
				return types.ToolResult{}, err
			}
			maxArtifacts := clampInt(util.AsInt(args["maxArtifacts"], 50), 1, 200)
			hits := carveHits(data)
			if len(hits) > maxArtifacts {
				hits = hits[:maxArtifacts]
			}
			var written []string
			if util.AsBool(args["extract"], false) {
				if err := security.ValidateWriteAllowed(tc.Policy); err != nil {
					return types.ToolResult{}, err
				}
				outDir, err := util.ResolveInside(tc.Workspace, util.AsString(args["outDir"], "carved"))
				if err != nil {
					return types.ToolResult{}, err
				}
				if err := os.MkdirAll(outDir, 0o755); err != nil {
					return types.ToolResult{}, err
				}
				for i, hit := range hits {
					next := len(data)
					if i+1 < len(hits) {
						next = hits[i+1].offset
					}
					outPath := filepath.Join(outDir, fmt.Sprintf("%02d_0x%x.%s", i, hit.offset, hit.extension))
					if err := os.WriteFile(outPath, data[hit.offset:next], 0o644); err != nil {
						return types.ToolResult{}, err
					}
					written = append(written, relative(tc.Workspace, outPath))
				}
			}
			out := []string{
				"CARVE ARTIFACTS",
				"path: " + relative(tc.Workspace, target),
				fmt.Sprintf("hits: %d", len(hits)),
				"",
			}
			for _, hit := range hits {
				out = append(out, fmt.Sprintf("- 0x%08x  %s  %s", hit.offset, hit.kind, hit.signature))
			}
			if len(written) > 0 {
				out = append(out, "", "written:")
				for _, file := range written {
					out = append(out, "- "+file)
				}
			}
			return textResult(strings.Join(out, "\n"), map[string]any{"hits": len(hits), "written": written}), nil
		},
	}
}

func apkInspectTool() types.Tool {
	return types.Tool{
		Name:        "apk_inspect",
		Description: "Inspect APK/ZIP structure for DEX files, native libraries, packer signatures, frameworks, manifest/resources, and likely Android reverse targets.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":       map[string]any{"type": "string"},
			"maxEntries": map[string]any{"type": "number", "default": 200},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			entries, err := zipEntries(target, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			maxEntries := clampInt(util.AsInt(args["maxEntries"], 200), 20, 1000)
			packers := detectApkPackers(entries)
			frameworks := detectApkFrameworks(entries)
			dex := filterEntries(entries, `(?i)(^|/)classes.*\.dex$`)
			libs := filterEntries(entries, `(?i)^lib/.*\.so$`)
			assets := filterEntries(entries, `(?i)^assets/`)
			if len(assets) > 50 {
				assets = assets[:50]
			}

			out := []string{
				"APK INSPECT",
				"path: " + relative(tc.Workspace, target),
				fmt.Sprintf("entries: %d", len(entries)),
				fmt.Sprintf("dex: %d", len(dex)),
				fmt.Sprintf("native libs: %d", len(libs)),
				"packers: " + joinOr(packers, "none detected"),
				"frameworks: " + joinOr(frameworks, "native/unknown"),
				"",
				"dex files:",
			}
			out = append(out, bullets(dex, "- none")...)
			out = append(out, "", "native libs:")
			shownLibs := libs
			if len(shownLibs) > maxEntries {
				shownLibs = shownLibs[:maxEntries]
			}
			out = append(out, bullets(shownLibs, "- none")...)
			out = append(out, "", "interesting assets:")
			out = append(out, bullets(assets, "- none")...)
			out = append(out,
				"",
				"next:",
				"- Use jadx/apktool for decompile when available.",
				"- Search for crypto/sign/token/root/frida/debug keywords.",
				"- Run ctf_triage/extract_symbols on interesting native libraries after extraction.",
			)
			return textResult(util.Clip(strings.Join(out, "\n"), tc.Policy.MaxReadBytes), map[string]any{
				"entries": len(entries), "dex": len(dex), "libs": len(libs),
				"packers": packers, "frameworks": frameworks,
			}), nil
		},
	}
}

// --- analysis primitives -----------------------------------------------------

func sha256File(file string) (string, error) {
	handle, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, handle); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func shannonEntropy(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}
	var counts [256]int
	for _, b := range data {
		counts[b]++
	}
	entropy := 0.0
	for _, count := range counts {
		if count == 0 {
			continue
		}
		p := float64(count) / float64(len(data))
		entropy -= p * math.Log2(p)
	}
	return entropy
}

func printableRatio(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}
	printable := 0
	for _, b := range data {
		if isPrintableByte(b) || b == 0x0a || b == 0x0d || b == 0x09 {
			printable++
		}
	}
	return float64(printable) / float64(len(data))
}

func extractPrintableStrings(data []byte, minLength int) []string {
	var out []string
	var current []byte
	for _, b := range data {
		if isPrintableByte(b) {
			current = append(current, b)
			continue
		}
		if len(current) >= minLength {
			out = append(out, string(current))
		}
		current = current[:0]
	}
	if len(current) >= minLength {
		out = append(out, string(current))
	}
	return out
}

func isPrintableByte(b byte) bool { return b >= 0x20 && b <= 0x7e }

func asciiPreview(data []byte) string {
	out := make([]byte, len(data))
	for i, b := range data {
		if isPrintableByte(b) {
			out[i] = b
		} else {
			out[i] = '.'
		}
	}
	return string(out)
}

type classifiedString struct {
	kind  string
	value string
}

var (
	flagRE     = regexp.MustCompile(`(?i)\b(?:flag|ctf|picoCTF|HTB|DUCTF|N1CTF|hxp|uiuctf|0xaf)\{[^}\r\n]{0,160}\}`)
	urlRE      = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>` + "`" + `]+`)
	emailRE    = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	ipv4RE     = regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`)
	secretRE   = regexp.MustCompile(`(?i)\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\b`)
	cryptoRE   = regexp.MustCompile(`(?i)\b(?:xor|base64|rot13|aes|des|rsa|ecb|cbc|md5|sha1|sha256|crc32|zlib|gzip)\b`)
	pwnRE      = regexp.MustCompile(`(?i)(?:\bsystem\b|\bexecve\b|\bpopen\b|\bgets\b|\bstrcpy\b|\bsprintf\b|\bmprotect\b|\bptrace\b|\bseccomp\b|\bcanary\b|/bin/sh)`)
	packerRE   = regexp.MustCompile(`(?i)\b(?:UPX!|pyinstaller|nuitka|packed|obfuscat|vmprotect|themida)\b`)
	base64ish  = regexp.MustCompile(`^(?:[A-Za-z0-9+/]{24,}={0,2}|[A-Za-z0-9_-]{24,})$`)
	hexishRE   = regexp.MustCompile(`^(?:0x)?[0-9a-fA-F]{24,}$`)
	hexPrefixR = regexp.MustCompile(`(?i)^0x`)
)

func classifyStrings(found []string, limit int) []classifiedString {
	var out []classifiedString
	seen := map[string]bool{}
	add := func(kind, value string) {
		clean := strings.TrimSpace(value)
		if clean == "" {
			return
		}
		rendered := clean
		if len([]rune(rendered)) > 180 {
			rendered = string([]rune(rendered)[:177]) + "..."
		}
		key := kind + "\x00" + rendered
		if seen[key] || len(out) >= limit {
			return
		}
		seen[key] = true
		out = append(out, classifiedString{kind, rendered})
	}

	for _, raw := range found {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		for _, match := range flagRE.FindAllString(value, -1) {
			add("flag-like", match)
		}
		for _, match := range urlRE.FindAllString(value, -1) {
			add("url", match)
		}
		for _, match := range emailRE.FindAllString(value, -1) {
			add("email", match)
		}
		for _, match := range ipv4RE.FindAllString(value, -1) {
			add("ipv4", match)
		}
		if secretRE.MatchString(value) {
			add("secret-keyword", value)
		}
		if cryptoRE.MatchString(value) {
			add("crypto-codec", value)
		}
		if pwnRE.MatchString(value) {
			add("pwn-re", value)
		}
		if packerRE.MatchString(value) {
			add("packer", value)
		}
		if base64ish.MatchString(value) && len(value)%4 != 1 {
			add("base64-like", value)
		}
		if hexishRE.MatchString(value) && len(hexPrefixR.ReplaceAllString(value, ""))%2 == 0 {
			add("hex-like", value)
		}
		if len(out) >= limit {
			break
		}
	}
	return out
}

func triageHints(fileType string, found []string, entropy, printable float64) []string {
	lowerType := strings.ToLower(fileType)
	sample := found
	if len(sample) > 200 {
		sample = sample[:200]
	}
	joined := strings.ToLower(strings.Join(sample, "\n"))
	var hints []string
	if strings.Contains(lowerType, "elf") {
		hints = append(hints, "ELF: run extract_symbols, strings, and targeted /run readelf/objdump checks.")
	}
	if strings.Contains(lowerType, "mach-o") {
		hints = append(hints, "Mach-O: run extract_symbols, strings, and otool/lldb checks if needed.")
	}
	if strings.Contains(lowerType, "pe32") || strings.Contains(lowerType, "ms-dos executable") {
		hints = append(hints, "PE: inspect imports, resources, and packer indicators.")
	}
	if strings.Contains(lowerType, "zip") || strings.Contains(lowerType, "archive") || strings.Contains(lowerType, "gzip") {
		hints = append(hints, "Archive/compressed: list contents before extraction and watch for nested files.")
	}
	if strings.Contains(lowerType, "image") || strings.Contains(lowerType, "png") || strings.Contains(lowerType, "jpeg") {
		hints = append(hints, "Forensics image: inspect metadata, trailing bytes, chunks, and embedded strings.")
	}
	if entropy >= 7.4 {
		hints = append(hints, "High entropy: suspect compression, encryption, packing, or embedded ciphertext; run entropy_scan.")
	}
	if printable >= 0.75 {
		hints = append(hints, "Mostly printable: grep for flags, endpoints, scripts, encodings, and protocol grammar.")
	}
	if strings.Contains(joined, "base64") || strings.Contains(joined, "xor") || strings.Contains(joined, "rot13") {
		hints = append(hints, "Codec keyword found: try ctf_decode on nearby candidate strings.")
	}
	if strings.Contains(joined, "/bin/sh") || strings.Contains(joined, "system") || strings.Contains(joined, "gets") {
		hints = append(hints, "Exploit primitive hint: check mitigations and xrefs around dangerous calls.")
	}
	if len(hints) == 0 {
		hints = append(hints, "Start with strings, hexdump around magic/offsets, and entropy_scan for hidden structure.")
	}
	if len(hints) > 6 {
		hints = hints[:6]
	}
	return hints
}

type entropyWindow struct {
	offset  int
	entropy float64
}

func entropyWindows(data []byte, window, step int) []entropyWindow {
	if len(data) == 0 {
		return []entropyWindow{{0, 0}}
	}
	if len(data) <= window {
		return []entropyWindow{{0, shannonEntropy(data)}}
	}
	var out []entropyWindow
	for offset := 0; offset+window <= len(data); offset += step {
		out = append(out, entropyWindow{offset, shannonEntropy(data[offset : offset+window])})
	}
	final := len(data) - window
	if len(out) == 0 || out[len(out)-1].offset != final {
		out = append(out, entropyWindow{final, shannonEntropy(data[final : final+window])})
	}
	return out
}

func collectSymbols(target string, tc types.ToolContext) string {
	attempts := [][]string{
		{"nm", "-an", target},
		{"readelf", "-Ws", target},
		{"objdump", "-T", target},
		{"otool", "-Iv", target},
	}
	var chunks []string
	for _, command := range attempts {
		result, err := Run(command, RunOptions{
			Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context(),
		})
		if err == nil && strings.TrimSpace(result.Stdout) != "" {
			chunks = append(chunks, result.Stdout)
		}
	}
	return strings.Join(chunks, "\n")
}

func dangerousImports(symbolText string) []string {
	patterns := []string{
		"gets", "strcpy", "strcat", "sprintf", "vsprintf", "scanf", "sscanf", "printf",
		"system", "popen", "execve", "mprotect", "mmap", "read", "recv", "memcpy", "strncpy",
	}
	found := map[string]bool{}
	for _, name := range patterns {
		re := regexp.MustCompile(`(^|[^A-Za-z0-9_])` + name + `([^A-Za-z0-9_]|$)`)
		if re.MatchString(symbolText) {
			found[name] = true
		}
	}
	out := make([]string, 0, len(found))
	for name := range found {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func findPatternOffsets(data []byte, needle, mode string, maxMatches int) ([]int, error) {
	if needle == "" {
		return nil, nil
	}
	if mode == "regex" {
		regex, err := regexp.Compile(needle)
		if err != nil {
			return nil, err
		}
		var out []int
		for _, match := range regex.FindAllIndex(data, -1) {
			out = append(out, match[0])
			if len(out) >= maxMatches {
				break
			}
		}
		return out, nil
	}
	var pattern []byte
	if mode == "hex" {
		decoded, ok := decodeHex(needle)
		if !ok {
			return nil, nil
		}
		pattern = decoded
	} else {
		pattern = []byte(needle)
	}
	if len(pattern) == 0 {
		return nil, nil
	}
	var out []int
	offset := 0
	for len(out) < maxMatches {
		hit := bytes.Index(data[offset:], pattern)
		if hit < 0 {
			break
		}
		absolute := offset + hit
		out = append(out, absolute)
		offset = absolute + maxInt(1, len(pattern))
		if offset >= len(data) {
			break
		}
	}
	return out, nil
}

func patternLength(needle, mode string) int {
	if mode == "hex" {
		if decoded, ok := decodeHex(needle); ok {
			return len(decoded)
		}
		return 1
	}
	return maxInt(1, len(needle))
}

type carveHit struct {
	offset    int
	kind      string
	signature string
	extension string
}

var magicSignatures = []struct {
	kind      string
	signature []byte
	extension string
}{
	{"ELF", []byte{0x7f, 0x45, 0x4c, 0x46}, "elf"},
	{"PE/MZ", []byte("MZ"), "exe"},
	{"DEX", []byte("dex\n"), "dex"},
	{"ZIP/APK/JAR", []byte{0x50, 0x4b, 0x03, 0x04}, "zip"},
	{"PNG", []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, "png"},
	{"JPEG", []byte{0xff, 0xd8, 0xff}, "jpg"},
	{"GIF", []byte("GIF8"), "gif"},
	{"PDF", []byte("%PDF-"), "pdf"},
	{"gzip", []byte{0x1f, 0x8b, 0x08}, "gz"},
	{"SQLite", []byte("SQLite format 3"), "sqlite"},
	{"Mach-O 64 LE", []byte{0xcf, 0xfa, 0xed, 0xfe}, "macho"},
	{"Mach-O 64 BE", []byte{0xfe, 0xed, 0xfa, 0xcf}, "macho"},
	{"WASM", []byte{0x00, 0x61, 0x73, 0x6d}, "wasm"},
}

func carveHits(data []byte) []carveHit {
	var hits []carveHit
	for _, magic := range magicSignatures {
		offset := 0
		for offset < len(data) {
			hit := bytes.Index(data[offset:], magic.signature)
			if hit < 0 {
				break
			}
			absolute := offset + hit
			hits = append(hits, carveHit{
				offset: absolute, kind: magic.kind,
				signature: hex.EncodeToString(magic.signature), extension: magic.extension,
			})
			offset = absolute + maxInt(1, len(magic.signature))
		}
	}
	sort.SliceStable(hits, func(a, b int) bool {
		if hits[a].offset != hits[b].offset {
			return hits[a].offset < hits[b].offset
		}
		return hits[a].kind < hits[b].kind
	})
	return hits
}

func zipEntries(target string, tc types.ToolContext) ([]string, error) {
	options := RunOptions{Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context()}
	for _, command := range [][]string{
		{"unzip", "-Z", "-1", target},
		{"zipinfo", "-1", target},
	} {
		result, err := Run(command, options)
		if err == nil && strings.TrimSpace(result.Stdout) != "" {
			var out []string
			for _, line := range util.Lines(result.Stdout) {
				if trimmed := strings.TrimSpace(line); trimmed != "" {
					out = append(out, trimmed)
				}
			}
			return out, nil
		}
	}
	// Neither helper is installed: read the ZIP central directory in process.
	if entries, err := zipEntriesNative(target); err == nil {
		return entries, nil
	}
	return nil, fmt.Errorf("could not list APK/ZIP entries; install unzip or zipinfo, or inspect with run_command")
}

func detectApkPackers(entries []string) []string {
	text := strings.ToLower(strings.Join(entries, "\n"))
	checks := []struct {
		name    string
		pattern *regexp.Regexp
	}{
		{"360 jiagu", regexp.MustCompile(`libjiagu|qihoo|360`)},
		{"Tencent Legu", regexp.MustCompile(`libshell|libtup|libexecmain|tencent`)},
		{"Bangcle", regexp.MustCompile(`libsecexe|libsecmain|libdexhelper|bangcle`)},
		{"Ijiami", regexp.MustCompile(`ijiami|libexec\.so`)},
		{"SecNeo", regexp.MustCompile(`(?i)secneo|libDexHelper`)},
		{"NetEase Yidun", regexp.MustCompile(`libnesec|netease|yidun`)},
		{"DexGuard/obfuscation", regexp.MustCompile(`dexguard|proguard`)},
	}
	var out []string
	for _, check := range checks {
		if check.pattern.MatchString(text) {
			out = append(out, check.name)
		}
	}
	return out
}

func detectApkFrameworks(entries []string) []string {
	text := strings.ToLower(strings.Join(entries, "\n"))
	checks := []struct {
		name    string
		pattern *regexp.Regexp
	}{
		{"React Native", regexp.MustCompile(`assets/index\.android\.bundle|libreactnativejni\.so`)},
		{"Flutter", regexp.MustCompile(`libflutter\.so|libapp\.so|flutter_assets`)},
		{"Unity", regexp.MustCompile(`libunity\.so|assets/bin/data`)},
		{"Cordova", regexp.MustCompile(`assets/www/|cordova\.js`)},
		{"Xamarin", regexp.MustCompile(`assemblies/|libmonodroid|libmonosgen`)},
		{"Cocos2d", regexp.MustCompile(`libcocos2d`)},
		{"UniApp", regexp.MustCompile(`assets/apps/|__uni__`)},
		{"WeChat Mini Program", regexp.MustCompile(`\.wxapkg|wxapkg`)},
	}
	var out []string
	for _, check := range checks {
		if check.pattern.MatchString(text) {
			out = append(out, check.name)
		}
	}
	return out
}

func filterEntries(entries []string, pattern string) []string {
	regex := regexp.MustCompile(pattern)
	var out []string
	for _, entry := range entries {
		if regex.MatchString(entry) {
			out = append(out, entry)
		}
	}
	return out
}

func bullets(items []string, empty string) []string {
	if len(items) == 0 {
		return []string{empty}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, "- "+item)
	}
	return out
}

func joinOr(items []string, fallback string) string {
	if len(items) == 0 {
		return fallback
	}
	return strings.Join(items, ", ")
}

func matches(pattern, text string) bool { return regexp.MustCompile(pattern).MatchString(text) }

func ternary(condition bool, whenTrue, whenFalse string) string {
	if condition {
		return whenTrue
	}
	return whenFalse
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var _ = strconv.Itoa
