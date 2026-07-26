package providers

// Token-usage extraction for the HTTP providers. Each vendor names the fields
// differently; this normalizes them onto types.TokenUsage.

import "github.com/overkazaf/re-agent/internal/types"

func anthropicUsage(raw map[string]any) types.TokenUsage {
	usage := asRecord(raw["usage"])
	if usage == nil {
		return types.TokenUsage{}
	}
	out := types.TokenUsage{}
	assign(&out.Input, usage["input_tokens"])
	assign(&out.Output, usage["output_tokens"])
	assign(&out.CacheRead, usage["cache_read_input_tokens"])
	assign(&out.CacheWrite, usage["cache_creation_input_tokens"])
	return out
}

func responsesUsage(raw map[string]any) types.TokenUsage {
	usage := asRecord(raw["usage"])
	if usage == nil {
		return types.TokenUsage{}
	}
	out := types.TokenUsage{}
	assign(&out.Input, usage["input_tokens"])
	assign(&out.Output, usage["output_tokens"])
	if details := asRecord(usage["output_tokens_details"]); details != nil {
		assign(&out.Thinking, details["reasoning_tokens"])
	}
	if cached := asRecord(usage["input_tokens_details"]); cached != nil {
		assign(&out.CacheRead, cached["cached_tokens"])
	}
	return out
}

func chatUsage(raw map[string]any) types.TokenUsage {
	usage := asRecord(raw["usage"])
	if usage == nil {
		return types.TokenUsage{}
	}
	out := types.TokenUsage{}
	assign(&out.Input, usage["prompt_tokens"])
	assign(&out.Output, usage["completion_tokens"])
	if details := asRecord(usage["completion_tokens_details"]); details != nil {
		assign(&out.Thinking, details["reasoning_tokens"])
	}
	if cached := asRecord(usage["prompt_tokens_details"]); cached != nil {
		assign(&out.CacheRead, cached["cached_tokens"])
	}
	return out
}

func assign(target *float64, value any) {
	if parsed, ok := num(value); ok {
		*target = parsed
	}
}
