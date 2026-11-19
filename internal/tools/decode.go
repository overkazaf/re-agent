package tools

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

var decodeModes = []string{
	"auto", "base64", "base64url", "base32", "hex", "url", "rot13",
	"zlib", "gzip", "xor", "xor_bruteforce", "rc4",
}

func ctfDecodeTool() types.Tool {
	return types.Tool{
		Name:        "ctf_decode",
		Description: "Decode common CTF/RE encodings and stream ciphers: auto, base64, base64url, base32, hex, URL, ROT13, zlib, gzip, XOR with key, single-byte XOR brute force, or RC4 with key.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"input":          map[string]any{"type": "string", "description": "Text or hex:/base64: payload to decode."},
			"mode":           map[string]any{"type": "string", "enum": decodeModes, "default": "auto"},
			"key":            map[string]any{"type": "string", "description": "XOR or RC4 key as text, decimal byte, 0xNN, or hex:..."},
			"maxOutputBytes": map[string]any{"type": "number", "default": 4096},
		}, "input"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			input := util.AsString(args["input"])
			mode := util.AsString(args["mode"], "auto")
			if !isDecodeMode(mode) {
				mode = "auto"
			}
			maxOutputBytes := clampInt(util.AsInt(args["maxOutputBytes"], 4096), 128, 64*1024)
			candidates, err := decodeCandidates(input, mode, util.AsString(args["key"]), maxOutputBytes)
			if err != nil {
				return types.ToolResult{}, err
			}
			out := []string{"CTF DECODE", "mode: " + mode, ""}
			for _, candidate := range candidates {
				out = append(out,
					"## "+candidate.label,
					fmt.Sprintf("score: %.2f  bytes: %d", candidate.score, len(candidate.bytes)),
					renderBytes(candidate.bytes, maxOutputBytes),
					"",
				)
			}
			if len(candidates) == 0 {
				out = append(out, "No plausible decode candidates.")
			}
			text := util.Clip(strings.TrimRight(strings.Join(out, "\n"), "\n"), tc.Policy.MaxReadBytes)
			return textResult(text, map[string]any{"mode": mode, "candidates": len(candidates)}), nil
		},
	}
}

type decodeCandidate struct {
	label string
	bytes []byte
	score float64
}

func isDecodeMode(value string) bool {
	for _, mode := range decodeModes {
		if mode == value {
			return true
		}
	}
	return false
}

func decodeCandidates(input, mode, key string, maxBytes int) ([]decodeCandidate, error) {
	var candidates []decodeCandidate
	add := func(label string, data []byte) {
		if len(data) == 0 {
			return
		}
		clipped := data
		if len(clipped) > maxBytes {
			clipped = clipped[:maxBytes]
		}
		for _, existing := range candidates {
			if bytes.Equal(existing.bytes, clipped) {
				return
			}
		}
		candidates = append(candidates, decodeCandidate{label, clipped, scoreBytes(clipped)})
	}

	tryBase64 := func(variant string) {
		if decoded, ok := decodeBase64(input, variant); ok {
			add(variant, decoded)
		}
	}
	tryHex := func() {
		if decoded, ok := decodeHex(input); ok {
			add("hex", decoded)
		}
	}
	tryURL := func() {
		if decoded, ok := decodeURL(input); ok && decoded != input {
			add("url", []byte(decoded))
		}
	}
	tryRot13 := func() { add("rot13", []byte(rot13(input))) }

	tryBase32 := func() {
		if decoded, ok := decodeBase32(input); ok {
			add("base32", decoded)
		}
	}
	tryZlib := func() {
		for _, raw := range binaryPayloadInputs(input) {
			if out, ok := inflateZlib(raw, maxBytes); ok {
				add("zlib", out)
			}
		}
	}
	tryGzip := func() {
		for _, raw := range binaryPayloadInputs(input) {
			if out, ok := inflateGzip(raw, maxBytes); ok {
				add("gzip", out)
			}
		}
	}

	switch mode {
	case "auto":
		tryBase64("base64")
		tryBase64("base64url")
		tryBase32()
		tryHex()
		tryURL()
		tryRot13()
		tryZlib()
		tryGzip()
		for _, raw := range binaryPayloadInputs(input) {
			for _, candidate := range singleByteXorCandidates(raw, 3) {
				if candidate.score >= 1.4 {
					add(candidate.label, candidate.bytes)
				}
			}
		}
	case "base64", "base64url":
		tryBase64(mode)
	case "base32":
		tryBase32()
	case "hex":
		tryHex()
	case "url":
		tryURL()
	case "rot13":
		tryRot13()
	case "zlib":
		tryZlib()
	case "gzip":
		tryGzip()
	case "xor":
		keyBytes, ok := parseXorKey(key)
		if !ok {
			return nil, fmt.Errorf("ctf_decode mode=xor requires key as text, decimal byte, 0xNN, or hex:...")
		}
		for _, raw := range binaryPayloadInputs(input) {
			add("xor key="+key, xorBytes(raw, keyBytes))
		}
	case "xor_bruteforce":
		for _, raw := range binaryPayloadInputs(input) {
			for _, candidate := range singleByteXorCandidates(raw, 8) {
				add(candidate.label, candidate.bytes)
			}
		}
	case "rc4":
		keyBytes, ok := parseXorKey(key)
		if !ok {
			return nil, fmt.Errorf("ctf_decode mode=rc4 requires key as text, 0xNN, or hex:...")
		}
		for _, raw := range binaryPayloadInputs(input) {
			add("rc4 key="+key, rc4Crypt(raw, keyBytes))
		}
	}

	sort.SliceStable(candidates, func(a, b int) bool { return candidates[a].score > candidates[b].score })
	return candidates, nil
}

var (
	whitespaceRE = regexp.MustCompile(`\s+`)
	base64StdRE  = regexp.MustCompile(`^[A-Za-z0-9+/]*={0,2}$`)
	base64URLRE  = regexp.MustCompile(`^[A-Za-z0-9_-]*={0,2}$`)
	hexBodyRE    = regexp.MustCompile(`^[0-9a-fA-F]+$`)
	hexCleanRE   = regexp.MustCompile(`[\s:_-]+`)
	hexEscapeRE  = regexp.MustCompile(`(?i)\\x`)
	xorHexKeyRE  = regexp.MustCompile(`(?i)^0x[0-9a-f]{1,2}$`)
	decimalKeyRE = regexp.MustCompile(`^\d{1,3}$`)
	hexKeyRE     = regexp.MustCompile(`(?i)^hex:`)
	flagWordRE   = regexp.MustCompile(`\b(flag|ctf|password|secret|token)\b`)
	braceRE      = regexp.MustCompile(`[a-z]{3,}\{[^}]{2,}\}`)
	schemeRE     = regexp.MustCompile(`https?://`)
)

func decodeBase64(input, variant string) ([]byte, bool) {
	normalized := whitespaceRE.ReplaceAllString(input, "")
	if normalized == "" || len(normalized)%4 == 1 {
		return nil, false
	}
	if variant == "base64" {
		if !base64StdRE.MatchString(normalized) {
			return nil, false
		}
	} else {
		if !base64URLRE.MatchString(normalized) {
			return nil, false
		}
		normalized = strings.NewReplacer("-", "+", "_", "/").Replace(normalized)
	}
	for len(normalized)%4 != 0 {
		normalized += "="
	}
	decoded, err := base64.StdEncoding.DecodeString(normalized)
	if err != nil || len(decoded) == 0 {
		return nil, false
	}
	return decoded, true
}

func decodeHex(input string) ([]byte, bool) {
	normalized := strings.TrimSpace(input)
	normalized = hexEscapeRE.ReplaceAllString(normalized, "")
	normalized = regexp.MustCompile(`(?i)^0x`).ReplaceAllString(normalized, "")
	normalized = hexCleanRE.ReplaceAllString(normalized, "")
	if normalized == "" || len(normalized)%2 != 0 || !hexBodyRE.MatchString(normalized) {
		return nil, false
	}
	decoded, err := hex.DecodeString(normalized)
	if err != nil {
		return nil, false
	}
	return decoded, true
}

func decodeURL(input string) (string, bool) {
	decoded, err := url.QueryUnescape(input)
	if err != nil {
		return "", false
	}
	return decoded, true
}

func rot13(input string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return 'a' + (r-'a'+13)%26
		case r >= 'A' && r <= 'Z':
			return 'A' + (r-'A'+13)%26
		}
		return r
	}, input)
}

func parseXorKey(value string) ([]byte, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, false
	}
	if xorHexKeyRE.MatchString(trimmed) {
		parsed, err := strconv.ParseUint(trimmed[2:], 16, 8)
		if err != nil {
			return nil, false
		}
		return []byte{byte(parsed)}, true
	}
	if decimalKeyRE.MatchString(trimmed) {
		parsed, err := strconv.Atoi(trimmed)
		if err == nil && parsed >= 0 && parsed <= 255 {
			return []byte{byte(parsed)}, true
		}
	}
	if hexKeyRE.MatchString(trimmed) {
		return decodeHex(trimmed[4:])
	}
	return []byte(trimmed), true
}

func binaryPayloadInputs(input string) [][]byte {
	trimmed := strings.TrimSpace(input)
	if hexKeyRE.MatchString(trimmed) {
		if decoded, ok := decodeHex(trimmed[4:]); ok {
			return [][]byte{decoded}
		}
	}
	if strings.HasPrefix(strings.ToLower(trimmed), "base64:") {
		if decoded, ok := decodeBase64(trimmed[7:], "base64"); ok {
			return [][]byte{decoded}
		}
	}
	var out [][]byte
	if decoded, ok := decodeHex(trimmed); ok {
		out = append(out, decoded)
	}
	if decoded, ok := decodeBase64(trimmed, "base64"); ok && len(trimmed) >= 8 {
		out = append(out, decoded)
	}
	out = append(out, []byte(input))
	return out
}

func decodeBase32(input string) ([]byte, bool) {
	normalized := strings.ToUpper(whitespaceRE.ReplaceAllString(input, ""))
	if len(normalized) < 4 {
		return nil, false
	}
	for len(normalized)%8 != 0 {
		normalized += "="
	}
	decoded, err := base32.StdEncoding.DecodeString(normalized)
	if err != nil || len(decoded) == 0 {
		return nil, false
	}
	return decoded, true
}

func inflateZlib(raw []byte, maxBytes int) ([]byte, bool) {
	r, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, false
	}
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, int64(maxBytes)))
	if err != nil || len(out) == 0 {
		return nil, false
	}
	return out, true
}

func inflateGzip(raw []byte, maxBytes int) ([]byte, bool) {
	r, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, false
	}
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, int64(maxBytes)))
	if err != nil || len(out) == 0 {
		return nil, false
	}
	return out, true
}

func rc4Crypt(data, key []byte) []byte {
	if len(key) == 0 || len(data) == 0 {
		return nil
	}
	var s [256]byte
	for i := 0; i < 256; i++ {
		s[i] = byte(i)
	}
	j := byte(0)
	for i := 0; i < 256; i++ {
		j += s[i] + key[i%len(key)]
		s[i], s[j] = s[j], s[i]
	}
	out := make([]byte, len(data))
	var x, y byte
	for k, b := range data {
		x++
		y += s[x]
		s[x], s[y] = s[y], s[x]
		out[k] = b ^ s[s[x]+s[y]]
	}
	return out
}

func xorBytes(input, key []byte) []byte {
	if len(key) == 0 {
		return nil
	}
	out := make([]byte, len(input))
	for i := range input {
		out[i] = input[i] ^ key[i%len(key)]
	}
	return out
}

func singleByteXorCandidates(input []byte, limit int) []decodeCandidate {
	candidates := make([]decodeCandidate, 0, 256)
	for key := 0; key <= 255; key++ {
		data := xorBytes(input, []byte{byte(key)})
		candidates = append(candidates, decodeCandidate{
			label: fmt.Sprintf("xor_bruteforce key=0x%02x", key),
			bytes: data,
			score: scoreBytes(data),
		})
	}
	sort.SliceStable(candidates, func(a, b int) bool { return candidates[a].score > candidates[b].score })
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates
}

func scoreBytes(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}
	printable := printableRatio(data)
	text := strings.ToLower(string(data))
	bonus := 0.0
	if flagWordRE.MatchString(text) {
		bonus += 1.0
	}
	if braceRE.MatchString(text) {
		bonus += 1.2
	}
	if schemeRE.MatchString(text) {
		bonus += 0.5
	}
	allPrintable := true
	for _, b := range data {
		if !isPrintableByte(b) && b != '\t' && b != '\r' && b != '\n' {
			allPrintable = false
			break
		}
	}
	if allPrintable {
		bonus += 0.3
	}
	return printable + bonus
}

func renderBytes(data []byte, maxBytes int) string {
	clipped := data
	suffix := ""
	if len(clipped) > maxBytes {
		clipped = clipped[:maxBytes]
		suffix = fmt.Sprintf("\n[truncated %d bytes]", len(data)-len(clipped))
	}
	if printableRatio(clipped) >= 0.75 {
		text := strings.Map(func(r rune) rune {
			if r == '\n' || r == '\r' || r == '\t' {
				return r
			}
			if unicode.IsControl(r) {
				return '.'
			}
			return r
		}, string(clipped))
		return text + suffix
	}
	encoded := hex.EncodeToString(clipped)
	var rows []string
	for i := 0; i < len(encoded); i += 32 {
		end := minInt(len(encoded), i+32)
		rows = append(rows, encoded[i:end])
	}
	return fmt.Sprintf("hex:\n%s\nascii:\n%s%s", strings.Join(rows, "\n"), asciiPreview(clipped), suffix)
}
