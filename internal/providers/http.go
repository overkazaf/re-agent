package providers

// The three HTTP adapters: Anthropic Messages, OpenAI Responses, and
// OpenAI-compatible Chat Completions. They share request plumbing and usage
// extraction; only the wire shapes differ.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/types"
)

var httpClient = &http.Client{Timeout: 10 * time.Minute}

type baseProvider struct {
	name   string
	config *types.ProviderConfig
}

func (p baseProvider) Name() string                  { return p.name }
func (p baseProvider) Config() *types.ProviderConfig { return p.config }

func trimSlash(value string) string { return strings.TrimRight(value, "/") }

// postJSON sends a request and decodes the response body, mapping 401/403 to
// the credential hint the operator actually needs.
func postJSON(
	ctx interface{ Done() <-chan struct{} },
	url string,
	headers map[string]string,
	body any,
	input types.ProviderInput,
	name string,
	provider *types.ProviderConfig,
	label string,
) (map[string]any, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(input.Context(), http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	for key, value := range provider.Headers {
		request.Header.Set(key, value)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(payload, &parsed); err != nil {
		parsed = map[string]any{"error": string(payload)}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		rendered, _ := json.Marshal(parsed)
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return nil, fmt.Errorf("%s %s response: %s",
				auth.InvalidCredentialHint(name, provider), label, string(rendered))
		}
		return nil, fmt.Errorf("%s error %d: %s", label, response.StatusCode, string(rendered))
	}
	return parsed, nil
}

// --- Anthropic ---------------------------------------------------------------

type AnthropicProvider struct{ baseProvider }

type anthropicCredential struct {
	value  string
	scheme string
}

func (p AnthropicProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	credential, ok := resolveAnthropicCredential(p.config)
	if !ok {
		return types.ProviderResponse{}, fmt.Errorf("%s", auth.MissingCredentialHint(p.name, p.config))
	}
	maxTokens := p.config.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
	}
	headers := map[string]string{
		"anthropic-version": "2023-06-01",
		"Content-Type":      "application/json",
	}
	if credential.scheme == "bearer" {
		headers["Authorization"] = "Bearer " + credential.value
	} else {
		headers["x-api-key"] = credential.value
	}
	body := map[string]any{
		"model":      p.config.Model,
		"max_tokens": maxTokens,
		"system":     input.System,
		"messages":   toAnthropicMessages(input.Messages),
		"tools":      toAnthropicTools(input.Tools),
	}
	url := trimSlash(orDefault(p.config.BaseURL, "https://api.anthropic.com")) + "/v1/messages"
	raw, err := postJSON(input.Context(), url, headers, body, input, p.name, p.config, "Anthropic")
	if err != nil {
		return types.ProviderResponse{}, err
	}
	return parseAnthropic(raw), nil
}

func resolveAnthropicCredential(provider *types.ProviderConfig) (anthropicCredential, bool) {
	if key := strings.TrimSpace(provider.APIKey); key != "" {
		scheme := provider.AuthScheme
		if scheme == "" {
			scheme = inferSchemeFromValue(key)
		}
		return anthropicCredential{key, scheme}, true
	}
	for _, name := range provider.APIKeyEnv {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			scheme := provider.AuthScheme
			if scheme == "" {
				scheme = inferSchemeFromEnv(name)
			}
			return anthropicCredential{value, scheme}, true
		}
	}
	return anthropicCredential{}, false
}

func inferSchemeFromEnv(envName string) string {
	if strings.Contains(envName, "OAUTH") || strings.Contains(envName, "AUTH_TOKEN") {
		return "bearer"
	}
	return "api-key"
}

func inferSchemeFromValue(value string) string {
	if strings.HasPrefix(strings.TrimSpace(value), "sk-ant-") {
		return "api-key"
	}
	return "bearer"
}

func toAnthropicMessages(messages []types.Message) []any {
	var out []any
	for _, message := range messages {
		switch message.Role {
		case types.MessageSystem:
			continue
		case types.MessageUser:
			content := contentToAnthropic(message.Blocks)
			if len(content) == 0 {
				content = []any{map[string]any{"type": "text", "text": ""}}
			}
			out = append(out, map[string]any{
				"role": "user", "content": content,
			})
		case types.MessageAssistant:
			var content []any
			if text := message.Text(); text != "" {
				content = append(content, map[string]any{"type": "text", "text": text})
			}
			for _, call := range message.ToolCalls {
				content = append(content, map[string]any{
					"type": "tool_use", "id": call.ID, "name": call.Name, "input": orEmpty(call.Arguments),
				})
			}
			if len(content) > 0 {
				out = append(out, map[string]any{"role": "assistant", "content": content})
			}
		case types.MessageToolResult:
			out = append(out, map[string]any{
				"role": "user",
				"content": []any{map[string]any{
					"type": "tool_result", "tool_use_id": message.ToolCallID,
					"content": message.Text(), "is_error": message.IsError,
				}},
			})
		}
	}
	return out
}

func contentToAnthropic(blocks []types.ContentBlock) []any {
	var out []any
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if block.Text != "" {
				out = append(out, map[string]any{"type": "text", "text": block.Text})
			}
		case "image":
			if block.Data != "" {
				out = append(out, map[string]any{"type": "image", "source": map[string]any{
					"type": "base64", "media_type": imageMime(block.MimeType), "data": block.Data,
				}})
			}
		}
	}
	return out
}

func toAnthropicTools(list []types.Tool) []any {
	out := make([]any, 0, len(list))
	for _, tool := range list {
		out = append(out, map[string]any{
			"name": tool.Name, "description": tool.Description, "input_schema": tool.Parameters,
		})
	}
	return out
}

func parseAnthropic(raw map[string]any) types.ProviderResponse {
	response := types.ProviderResponse{Raw: raw}
	content, _ := raw["content"].([]any)
	for _, item := range content {
		part := asRecord(item)
		if part == nil {
			continue
		}
		switch str(part["type"]) {
		case "text":
			if text := str(part["text"]); text != "" {
				if response.Text != "" {
					response.Text += "\n"
				}
				response.Text += text
			}
		case "tool_use":
			response.ToolCalls = append(response.ToolCalls, types.ToolCall{
				ID:        idOr(part["id"], len(response.ToolCalls)),
				Name:      str(part["name"]),
				Arguments: orEmpty(asRecord(part["input"])),
			})
		}
	}
	response.Usage = anthropicUsage(raw)
	return response
}

// --- OpenAI Responses --------------------------------------------------------

type OpenAIResponsesProvider struct{ baseProvider }

func (p OpenAIResponsesProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	apiKey := config.ResolveAPIKey(p.config)
	if apiKey == "" {
		return types.ProviderResponse{}, fmt.Errorf("%s", auth.MissingCredentialHint(p.name, p.config))
	}
	maxTokens := p.config.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
	}
	body := map[string]any{
		"model":             p.config.Model,
		"instructions":      input.System,
		"input":             ToResponsesInput(input.Messages),
		"tools":             toResponsesTools(input.Tools),
		"max_output_tokens": maxTokens,
	}
	if p.config.ReasoningEffort != "" {
		body["reasoning"] = map[string]any{"effort": string(p.config.ReasoningEffort)}
	}
	headers := map[string]string{
		"Authorization": "Bearer " + apiKey,
		"Content-Type":  "application/json",
	}
	url := trimSlash(orDefault(p.config.BaseURL, "https://api.openai.com/v1")) + "/responses"
	raw, err := postJSON(input.Context(), url, headers, body, input, p.name, p.config, "OpenAI Responses")
	if err != nil {
		return types.ProviderResponse{}, err
	}
	return parseResponses(raw), nil
}

func ToResponsesInput(messages []types.Message) []any {
	var out []any
	for _, message := range messages {
		switch message.Role {
		case types.MessageSystem:
			continue
		case types.MessageUser:
			content := contentToResponses(message.Blocks)
			if len(content) == 0 {
				content = []any{map[string]any{"type": "input_text", "text": ""}}
			}
			out = append(out, map[string]any{
				"role": "user", "content": content,
			})
		case types.MessageAssistant:
			if text := message.Text(); text != "" {
				out = append(out, map[string]any{
					"role":    "assistant",
					"content": []any{map[string]any{"type": "output_text", "text": text}},
				})
			}
			// The tool calls have to go back too. Without them the
			// `function_call_output` below references a `call_id` that is not in
			// the input, and the API rejects the whole turn.
			for _, call := range message.ToolCalls {
				arguments, _ := json.Marshal(orEmpty(call.Arguments))
				out = append(out, map[string]any{
					"type": "function_call", "call_id": call.ID, "name": call.Name,
					"arguments": string(arguments),
				})
			}
		case types.MessageToolResult:
			out = append(out, map[string]any{
				"type": "function_call_output", "call_id": message.ToolCallID, "output": message.Text(),
			})
		}
	}
	return out
}

func contentToResponses(blocks []types.ContentBlock) []any {
	var out []any
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if block.Text != "" {
				out = append(out, map[string]any{"type": "input_text", "text": block.Text})
			}
		case "image":
			if block.Data != "" {
				out = append(out, map[string]any{
					"type": "input_image", "image_url": imageDataURI(block),
				})
			}
		}
	}
	return out
}

func toResponsesTools(list []types.Tool) []any {
	out := make([]any, 0, len(list))
	for _, tool := range list {
		out = append(out, map[string]any{
			"type": "function", "name": tool.Name,
			"description": tool.Description, "parameters": tool.Parameters,
		})
	}
	return out
}

func parseResponses(raw map[string]any) types.ProviderResponse {
	response := types.ProviderResponse{Raw: raw, Text: str(raw["output_text"])}
	output, _ := raw["output"].([]any)
	for _, item := range output {
		record := asRecord(item)
		if record == nil {
			continue
		}
		switch str(record["type"]) {
		case "function_call":
			id := record["call_id"]
			if str(id) == "" {
				id = record["id"]
			}
			response.ToolCalls = append(response.ToolCalls, types.ToolCall{
				ID:        idOr(id, len(response.ToolCalls)),
				Name:      str(record["name"]),
				Arguments: safeArguments(str(record["arguments"])),
			})
		case "message":
			parts, _ := record["content"].([]any)
			for _, raw := range parts {
				part := asRecord(raw)
				if part == nil || str(part["type"]) != "output_text" {
					continue
				}
				if text := str(part["text"]); text != "" {
					if response.Text != "" {
						response.Text += "\n"
					}
					response.Text += text
				}
			}
		}
	}
	response.Usage = responsesUsage(raw)
	return response
}

// --- OpenAI Chat Completions -------------------------------------------------

type OpenAIChatProvider struct{ baseProvider }

func (p OpenAIChatProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	apiKey := config.ResolveAPIKey(p.config)
	if apiKey == "" {
		return types.ProviderResponse{}, fmt.Errorf("%s", auth.MissingCredentialHint(p.name, p.config))
	}
	maxTokens := p.config.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
	}
	body := map[string]any{
		"model":       p.config.Model,
		"messages":    ToChatMessages(input.System, input.Messages),
		"tools":       toChatTools(input.Tools),
		"tool_choice": "auto",
		"max_tokens":  maxTokens,
	}
	headers := map[string]string{
		"Authorization": "Bearer " + apiKey,
		"Content-Type":  "application/json",
	}
	url := trimSlash(orDefault(p.config.BaseURL, "https://api.openai.com/v1")) + "/chat/completions"
	raw, err := postJSON(input.Context(), url, headers, body, input, p.name, p.config, "OpenAI-compatible chat")
	if err != nil {
		return types.ProviderResponse{}, err
	}
	return parseChat(raw), nil
}

func ToChatMessages(system string, messages []types.Message) []any {
	out := []any{map[string]any{"role": "system", "content": system}}
	for _, message := range messages {
		switch message.Role {
		case types.MessageSystem:
			continue
		case types.MessageUser:
			entry := map[string]any{"role": "user"}
			if hasImages(message.Blocks) {
				entry["content"] = contentToChat(message.Blocks)
			} else {
				entry["content"] = message.Text()
			}
			out = append(out, entry)
		case types.MessageAssistant:
			var toolCalls []any
			for _, call := range message.ToolCalls {
				arguments, _ := json.Marshal(orEmpty(call.Arguments))
				toolCalls = append(toolCalls, map[string]any{
					"id": call.ID, "type": "function",
					"function": map[string]any{"name": call.Name, "arguments": string(arguments)},
				})
			}
			text := message.Text()
			// Strict backends (DeepSeek, GLM) reject `tool_calls: []` and a null
			// content with no tool calls, so both keys are only sent when
			// meaningful.
			entry := map[string]any{"role": "assistant"}
			if text != "" {
				entry["content"] = text
			} else if len(toolCalls) > 0 {
				entry["content"] = nil
			} else {
				entry["content"] = ""
			}
			if len(toolCalls) > 0 {
				entry["tool_calls"] = toolCalls
			}
			out = append(out, entry)
		case types.MessageToolResult:
			out = append(out, map[string]any{
				"role": "tool", "tool_call_id": message.ToolCallID, "content": message.Text(),
			})
		}
	}
	return out
}

func contentToChat(blocks []types.ContentBlock) []any {
	var out []any
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if block.Text != "" {
				out = append(out, map[string]any{"type": "text", "text": block.Text})
			}
		case "image":
			if block.Data != "" {
				out = append(out, map[string]any{"type": "image_url", "image_url": map[string]any{
					"url": imageDataURI(block),
				}})
			}
		}
	}
	return out
}

func hasImages(blocks []types.ContentBlock) bool {
	for _, block := range blocks {
		if block.Type == "image" && block.Data != "" {
			return true
		}
	}
	return false
}

func imageDataURI(block types.ContentBlock) string {
	return "data:" + imageMime(block.MimeType) + ";base64," + block.Data
}

func imageMime(mime string) string {
	if mime == "" {
		return "image/png"
	}
	return mime
}

func toChatTools(list []types.Tool) []any {
	out := make([]any, 0, len(list))
	for _, tool := range list {
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters,
			},
		})
	}
	return out
}

func parseChat(raw map[string]any) types.ProviderResponse {
	response := types.ProviderResponse{Raw: raw}
	choices, _ := raw["choices"].([]any)
	if len(choices) > 0 {
		if choice := asRecord(choices[0]); choice != nil {
			if message := asRecord(choice["message"]); message != nil {
				response.Text = str(message["content"])
				calls, _ := message["tool_calls"].([]any)
				for _, item := range calls {
					call := asRecord(item)
					if call == nil {
						continue
					}
					function := asRecord(call["function"])
					arguments := "{}"
					name := ""
					if function != nil {
						name = str(function["name"])
						if raw := str(function["arguments"]); raw != "" {
							arguments = raw
						}
					}
					response.ToolCalls = append(response.ToolCalls, types.ToolCall{
						ID:        idOr(call["id"], len(response.ToolCalls)),
						Name:      name,
						Arguments: safeArguments(arguments),
					})
				}
			}
		}
	}
	response.Usage = chatUsage(raw)
	return response
}

// --- shared helpers ----------------------------------------------------------

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func orEmpty(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func idOr(value any, index int) string {
	if text := str(value); text != "" {
		return text
	}
	return fmt.Sprintf("call_%d", index)
}

func safeArguments(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return map[string]any{"raw": raw}
	}
	return parsed
}
