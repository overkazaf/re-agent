// Package core is the agent runtime: the append-only session log, context
// budgeting, the tool loop, and the operator shell escape.
package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

type SessionEntry struct {
	Type      string          `json:"type"` // session | message | event
	Timestamp string          `json:"timestamp"`
	Data      json.RawMessage `json:"data"`
}

// Summary is one row of the `--resume` / `/sessions` picker.
type Summary struct {
	// ID is a stable handle: the file name without `.jsonl`, also accepted as a prefix.
	ID        string
	File      string
	StartedAt string
	UpdatedAt time.Time
	Workspace string
	Messages  int
	// FirstPrompt is what makes a session recognizable.
	FirstPrompt string
	LastPrompt  string
}

type Loaded struct {
	File     string
	Meta     map[string]any
	Messages []types.Message
	// Plan is the last task list recorded, so a resumed session picks it back up.
	Plan *types.PlanSnapshot
}

// Session is an append-only JSONL transcript.
type Session struct {
	File string
	mu   sync.Mutex
}

func NewSession(sessionDir, name string) *Session {
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	return &Session{File: filepath.Join(sessionDir, fmt.Sprintf("%s-%s.jsonl", stamp, name))}
}

func (s *Session) Init(meta map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(s.File), 0o755); err != nil {
		return err
	}
	return s.append("session", meta)
}

func (s *Session) AppendMessage(message types.Message) error {
	return s.append("message", message)
}

func (s *Session) AppendEvent(data any) error {
	return s.append("event", data)
}

func (s *Session) append(kind string, data any) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	entry := SessionEntry{
		Type:      kind,
		Timestamp: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Data:      encoded,
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	handle, err := os.OpenFile(s.File, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer handle.Close()
	_, err = handle.Write(append(line, '\n'))
	return err
}

// ListSessions returns the newest sessions first. Unreadable or empty files are
// skipped rather than fatal.
func ListSessions(sessionDir string, limit int) []Summary {
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		return nil
	}
	var summaries []Summary
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		summary, ok := summarize(filepath.Join(sessionDir, entry.Name()))
		if ok {
			summaries = append(summaries, summary)
		}
	}
	sort.SliceStable(summaries, func(a, b int) bool {
		return summaries[a].UpdatedAt.After(summaries[b].UpdatedAt)
	})
	if limit > 0 && len(summaries) > limit {
		summaries = summaries[:limit]
	}
	return summaries
}

// ResolveSession accepts an id, an id prefix, or a path.
func ResolveSession(sessionDir, idOrPath string) *Summary {
	sessions := ListSessions(sessionDir, 500)
	if len(sessions) == 0 {
		return nil
	}
	if idOrPath == "" {
		return &sessions[0]
	}
	if resolved, err := filepath.Abs(idOrPath); err == nil {
		for i := range sessions {
			if candidate, err := filepath.Abs(sessions[i].File); err == nil && candidate == resolved {
				return &sessions[i]
			}
		}
	}
	wanted := strings.TrimSuffix(filepath.Base(idOrPath), ".jsonl")
	for i := range sessions {
		if sessions[i].ID == wanted {
			return &sessions[i]
		}
	}
	for i := range sessions {
		if strings.HasPrefix(sessions[i].ID, wanted) {
			return &sessions[i]
		}
	}
	return nil
}

func LoadSession(file string) (Loaded, error) {
	entries, err := readEntries(file)
	if err != nil {
		return Loaded{}, err
	}
	loaded := Loaded{File: file, Meta: map[string]any{}}
	for _, entry := range entries {
		switch entry.Type {
		case "session":
			_ = json.Unmarshal(entry.Data, &loaded.Meta)
		case "message":
			var message types.Message
			if err := json.Unmarshal(entry.Data, &message); err == nil {
				loaded.Messages = append(loaded.Messages, message)
			}
		case "event":
			var event struct {
				Type   string           `json:"type"`
				Steps  []types.PlanStep `json:"steps"`
				Source string           `json:"source"`
				Note   string           `json:"note"`
			}
			if err := json.Unmarshal(entry.Data, &event); err != nil {
				continue
			}
			if event.Type == "plan" && len(event.Steps) > 0 {
				source := event.Source
				if source == "" {
					source = "resumed"
				}
				loaded.Plan = &types.PlanSnapshot{Steps: event.Steps, Source: source, Note: event.Note}
			}
		}
	}
	loaded.Messages = repair(loaded.Messages)
	return loaded, nil
}

// repair makes the transcript loadable again after a crash, a kill mid-tool, or
// a corrupt line that readEntries had to skip. Providers reject a dangling call
// *and* an orphan result, so both directions are pruned: a tool call with no
// result loses the call, and a result with no call is dropped entirely.
func repair(messages []types.Message) []types.Message {
	issued := map[string]bool{}
	for _, message := range messages {
		if message.Role == types.MessageAssistant {
			for _, call := range message.ToolCalls {
				issued[call.ID] = true
			}
		}
	}
	answered := map[string]bool{}
	for _, message := range messages {
		if message.Role == types.MessageToolResult && issued[message.ToolCallID] {
			answered[message.ToolCallID] = true
		}
	}
	out := make([]types.Message, 0, len(messages))
	for _, message := range messages {
		if message.Role == types.MessageToolResult && !issued[message.ToolCallID] {
			continue // nothing ever asked for this result
		}
		if message.Role == types.MessageAssistant && len(message.ToolCalls) > 0 {
			var kept []types.ToolCall
			for _, call := range message.ToolCalls {
				if answered[call.ID] {
					kept = append(kept, call)
				}
			}
			if len(kept) == 0 {
				// Nothing but unanswered calls: keep any text, drop the calls.
				if strings.TrimSpace(message.Text()) != "" {
					message.ToolCalls = nil
					out = append(out, message)
				}
				continue
			}
			message.ToolCalls = kept
			out = append(out, message)
			continue
		}
		out = append(out, message)
	}
	return out
}

func summarize(file string) (Summary, bool) {
	entries, err := readEntries(file)
	if err != nil || len(entries) == 0 {
		return Summary{}, false
	}
	info, err := os.Stat(file)
	if err != nil {
		return Summary{}, false
	}
	meta := map[string]any{}
	var prompts []string
	messages := 0
	for _, entry := range entries {
		switch entry.Type {
		case "session":
			_ = json.Unmarshal(entry.Data, &meta)
		case "message":
			messages++
			var message types.Message
			if err := json.Unmarshal(entry.Data, &message); err != nil || message.Role != types.MessageUser {
				continue
			}
			line := util.FirstLine(message.Text())
			if strings.TrimSpace(line) == "" ||
				strings.HasPrefix(line, "[operator shell]") ||
				strings.HasPrefix(line, "[context compacted]") {
				continue
			}
			prompts = append(prompts, line)
		}
	}
	summary := Summary{
		ID:        strings.TrimSuffix(filepath.Base(file), ".jsonl"),
		File:      file,
		StartedAt: entries[0].Timestamp,
		UpdatedAt: info.ModTime(),
		Messages:  messages,
	}
	if workspace, ok := meta["workspace"].(string); ok {
		summary.Workspace = workspace
	}
	if len(prompts) > 0 {
		summary.FirstPrompt = prompts[0]
		summary.LastPrompt = prompts[len(prompts)-1]
	}
	return summary, true
}

func readEntries(file string) ([]SessionEntry, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var entries []SessionEntry
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry SessionEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			// A truncated last line is expected when a session was killed
			// mid-write.
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}
