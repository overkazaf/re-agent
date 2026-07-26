// Package util holds the small shared helpers: argument coercion, path
// containment, truncation, and the interrupt sentinel.
package util

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrInterrupted is what a cancelled turn reports. It wraps context.Canceled so
// errors.Is works against either.
var ErrInterrupted = fmt.Errorf("interrupted by operator: %w", context.Canceled)

// IsAbort is true for every flavour of "we cancelled this".
func IsAbort(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, ErrInterrupted) {
		return true
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "context canceled") || strings.Contains(lower, "interrupted")
}

func ThrowIfAborted(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ErrInterrupted
	default:
		return nil
	}
}

func AsString(value any, fallback ...string) string {
	if text, ok := value.(string); ok {
		return text
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}

func AsNumber(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		if parsed, err := typed.Float64(); err == nil {
			return parsed
		}
	}
	return fallback
}

func AsInt(value any, fallback int) int {
	return int(AsNumber(value, float64(fallback)))
}

func AsBool(value any, fallback bool) bool {
	if flag, ok := value.(bool); ok {
		return flag
	}
	return fallback
}

// ParseJSONObject requires a JSON object, rejecting arrays and scalars.
func ParseJSONObject(value string) (map[string]any, error) {
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, err
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return nil, errors.New("expected a JSON object")
	}
	return object, nil
}

// SafeJSONObject never fails: an unparseable payload comes back as {raw: …},
// which is what models occasionally emit for tool arguments.
func SafeJSONObject(value string) map[string]any {
	object, err := ParseJSONObject(value)
	if err != nil {
		return map[string]any{"raw": value}
	}
	return object
}

func FileExists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

// ResolveInside resolves a workspace-relative path and refuses to leave the
// workspace.
func ResolveInside(root, inputPath string) (string, error) {
	normalizedRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	resolved := inputPath
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(normalizedRoot, inputPath)
	}
	resolved = filepath.Clean(resolved)
	if resolved != normalizedRoot && !strings.HasPrefix(resolved, normalizedRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace: %s", inputPath)
	}
	return resolved, nil
}

// Clip truncates to maxChars runes, appending a note about what was dropped.
func Clip(text string, maxChars int) string {
	runes := []rune(text)
	if len(runes) <= maxChars || maxChars <= 0 {
		return text
	}
	return fmt.Sprintf("%s\n\n[truncated %d chars]", string(runes[:maxChars]), len(runes)-maxChars)
}

// Truncate cuts to maxRunes and appends an ellipsis when it clipped.
func Truncate(text string, maxRunes int) string {
	runes := []rune(text)
	if len(runes) <= maxRunes {
		return text
	}
	if maxRunes <= 1 {
		return "…"
	}
	return string(runes[:maxRunes-1]) + "…"
}

func ReadTextIfExists(file string) (string, bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	return string(data), true
}

func FormatError(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func FirstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		return text[:index]
	}
	return text
}

// Lines splits on \n after normalizing \r\n, without the trailing empty entry a
// final newline would produce.
func Lines(text string) []string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.TrimSuffix(normalized, "\n")
	if normalized == "" {
		return nil
	}
	return strings.Split(normalized, "\n")
}

// StringSlice coerces a JSON array of strings.
func StringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}
