// Package providers adapts each backend — Anthropic Messages, OpenAI
// Responses, OpenAI-compatible Chat, a local CLI in tmux, and an offline mock —
// to one Complete() call.
package providers

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

func Create(name string, config *types.ProviderConfig) (types.Provider, error) {
	base := baseProvider{name: name, config: config}
	switch config.Type {
	case types.KindAnthropic:
		return AnthropicProvider{base}, nil
	case types.KindOpenAIResponses:
		return OpenAIResponsesProvider{base}, nil
	case types.KindOpenAIChat:
		return OpenAIChatProvider{base}, nil
	case types.KindCLITmux:
		return &CLITmuxProvider{baseProvider: base}, nil
	case types.KindMock:
		return &MockProvider{baseProvider: base}, nil
	default:
		return nil, fmt.Errorf("unsupported provider type: %s", config.Type)
	}
}

// MockProvider is the offline stand-in. By default it echoes the prompt and
// calls nothing, which is what `--smoke` wants. A `mockScript` in the provider
// config turns it into a scripted actor instead — one entry per turn — so
// tool-driven behaviour can be exercised without a network or an API key. The
// last entry repeats once the script runs out.
type MockProvider struct {
	baseProvider
	turn int
}

func (p *MockProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	script := p.config.MockScript
	if len(script) > 0 {
		index := p.turn
		if index > len(script)-1 {
			index = len(script) - 1
		}
		p.turn++
		step := script[index]
		var calls []types.ToolCall
		for i, call := range step.ToolCalls {
			id := call.ID
			if id == "" {
				id = fmt.Sprintf("mock_%d_%d", p.turn, i)
			}
			arguments := call.Arguments
			if arguments == nil {
				arguments = map[string]any{}
			}
			calls = append(calls, types.ToolCall{ID: id, Name: call.Name, Arguments: arguments})
		}
		if input.OnProgress != nil {
			input.OnProgress(types.ProviderProgress{Kind: "status", Status: "mock"})
		}
		response := types.ProviderResponse{Text: step.Text, ToolCalls: calls}
		if step.Usage != nil {
			response.Usage = *step.Usage
		}
		return response, nil
	}

	prompt := ""
	for i := len(input.Messages) - 1; i >= 0; i-- {
		if input.Messages[i].Role == types.MessageUser {
			prompt = input.Messages[i].Text()
			break
		}
	}
	if prompt == "" {
		prompt = "(empty prompt)"
	}
	names := make([]string, 0, len(input.Tools))
	for _, tool := range input.Tools {
		names = append(names, tool.Name)
	}
	return types.ProviderResponse{
		Text: fmt.Sprintf("0xAF-Re mock response via %s.\n\nReceived: %s\n\nAvailable tools: %s",
			p.name, prompt, strings.Join(names, ", ")),
	}, nil
}

func jsonUnmarshal(text string, target any) error {
	return json.Unmarshal([]byte(text), target)
}
