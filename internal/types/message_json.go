package types

import "encoding/json"

// The session JSONL format is shared with the TypeScript implementation, where
// `content` is a plain string for system messages and a block array for every
// other role. Message keeps both shapes in typed fields and reconciles them
// here, so a log written by either implementation loads in the other.

type messageWire struct {
	Role       Role            `json:"role"`
	Content    json.RawMessage `json:"content,omitempty"`
	ToolCalls  []ToolCall      `json:"toolCalls,omitempty"`
	Provider   string          `json:"provider,omitempty"`
	Model      string          `json:"model,omitempty"`
	ToolCallID string          `json:"toolCallId,omitempty"`
	ToolName   string          `json:"toolName,omitempty"`
	IsError    bool            `json:"isError,omitempty"`
	Details    any             `json:"details,omitempty"`
	Timestamp  int64           `json:"timestamp,omitempty"`
}

func (m Message) MarshalJSON() ([]byte, error) {
	wire := messageWire{
		Role:       m.Role,
		ToolCalls:  m.ToolCalls,
		Provider:   m.Provider,
		Model:      m.Model,
		ToolCallID: m.ToolCallID,
		ToolName:   m.ToolName,
		IsError:    m.IsError,
		Details:    m.Details,
		Timestamp:  m.Timestamp,
	}
	var (
		raw []byte
		err error
	)
	if m.Role == MessageSystem {
		raw, err = json.Marshal(m.System)
	} else {
		blocks := m.Blocks
		if blocks == nil {
			blocks = []ContentBlock{}
		}
		raw, err = json.Marshal(blocks)
	}
	if err != nil {
		return nil, err
	}
	wire.Content = raw
	return json.Marshal(wire)
}

func (m *Message) UnmarshalJSON(data []byte) error {
	var wire messageWire
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*m = Message{
		Role:       wire.Role,
		ToolCalls:  wire.ToolCalls,
		Provider:   wire.Provider,
		Model:      wire.Model,
		ToolCallID: wire.ToolCallID,
		ToolName:   wire.ToolName,
		IsError:    wire.IsError,
		Details:    wire.Details,
		Timestamp:  wire.Timestamp,
	}
	if len(wire.Content) == 0 {
		return nil
	}
	// A string body belongs to a system message; anything else is blocks. Both
	// are attempted regardless of role, since a hand-edited log may disagree.
	var text string
	if err := json.Unmarshal(wire.Content, &text); err == nil {
		m.System = text
		if m.Role != MessageSystem {
			m.Blocks = []ContentBlock{TextBlock(text)}
		}
		return nil
	}
	var blocks []ContentBlock
	if err := json.Unmarshal(wire.Content, &blocks); err == nil {
		m.Blocks = blocks
	}
	return nil
}
