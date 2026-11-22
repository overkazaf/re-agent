package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
)

type stubGreetingProvider struct {
	name   string
	cfg    *types.ProviderConfig
	fn     func(input types.ProviderInput) (types.ProviderResponse, error)
	called int
	lastIn types.ProviderInput
}

func (s *stubGreetingProvider) Name() string                  { return s.name }
func (s *stubGreetingProvider) Config() *types.ProviderConfig { return s.cfg }
func (s *stubGreetingProvider) Complete(input types.ProviderInput) (types.ProviderResponse, error) {
	s.called++
	s.lastIn = input
	return s.fn(input)
}

func withGreetingHooks(
	t *testing.T,
	cfg *types.AgentConfig,
	factory func(name string, cfg *types.ProviderConfig) (types.Provider, error),
	timeout time.Duration,
) {
	t.Helper()
	origLoad := greetingLoadConfig
	origCreate := greetingCreateProvider
	origTimeout := greetingTimeout
	t.Cleanup(func() {
		greetingLoadConfig = origLoad
		greetingCreateProvider = origCreate
		greetingTimeout = origTimeout
	})
	greetingLoadConfig = func() (*types.AgentConfig, string, error) {
		if cfg == nil {
			return nil, "", errors.New("no config")
		}
		return cfg, "", nil
	}
	if factory != nil {
		greetingCreateProvider = factory
	}
	if timeout > 0 {
		greetingTimeout = timeout
	}
}

func TestGreetWithModelConfiguredLLMCall(t *testing.T) {
	cfg := &types.AgentConfig{
		Name:            "0xaf",
		PlannerProvider: "codex-sol",
		Providers: map[string]*types.ProviderConfig{
			"codex-sol": {
				Type:  types.KindOpenAIResponses,
				Model: "gpt-5.3-codex",
			},
		},
	}

	stub := &stubGreetingProvider{
		name: "codex-sol",
		cfg:  cfg.Providers["codex-sol"],
		fn: func(input types.ProviderInput) (types.ProviderResponse, error) {
			if len(input.Tools) != 0 {
				t.Fatalf("greeting must be zero-tool read-only, got %d tools", len(input.Tools))
			}
			if !input.FreshSession {
				t.Fatalf("greeting must run with FreshSession=true")
			}
			return types.ProviderResponse{
				Text: "```json\n" + `{
					"salutation": "晚上好",
					"summary": "上次在 reverse-lab 分析 carrier.bin 停在 verify 阶段，H-004 已就绪但尚未做最终对抗审计。",
					"suggestions": [
						{
							"id": "s1",
							"label": "继续上次任务",
							"reason": "恢复 reverse-lab 会话的证据账本与假设栈",
							"actionKind": "resume_session",
							"payload": "sess-rev-1"
						},
						{
							"id": "s2",
							"label": "运行 /audit 复核",
							"reason": "使用独立审计席位复核 H-004 证据链",
							"actionKind": "run_command",
							"payload": "/audit"
						},
						{
							"id": "bad-session",
							"label": "非法恢复",
							"reason": "不应通过未知 sessionId",
							"actionKind": "resume_session",
							"payload": "non-existent"
						}
					]
				}` + "\n```",
			}, nil
		},
	}

	withGreetingHooks(t, cfg, func(name string, pcfg *types.ProviderConfig) (types.Provider, error) {
		if name != "codex-sol" {
			t.Fatalf("expected planner provider codex-sol, got %s", name)
		}
		return stub, nil
	}, 2*time.Second)

	app := NewApp()
	resp := app.GreetWithModel(GreetingRequest{
		TimeOfDay: "evening",
		LocalHour: 21,
		RecentSessions: []GreetingSessionMemory{
			{
				SessionID:       "sess-rev-1",
				Workspace:       "/lab/reverse-lab",
				TargetFile:      "carrier.bin",
				Objective:       "解出内嵌载荷与校验逻辑",
				REPhase:         "verify",
				UnverifiedCount: 1,
				OpenHypotheses: []GreetingHypothesisSummary{
					{ID: "H-004", Claim: "二阶段 XOR 密钥来自偏移 0x40", Status: "active"},
				},
			},
		},
	})

	if stub.called != 1 {
		t.Fatalf("expected 1 LLM call, got %d", stub.called)
	}
	if resp.Source != "llm" {
		t.Fatalf("source = %q, want llm (fallbackNote=%q)", resp.Source, resp.FallbackNote)
	}
	if resp.Salutation != "晚上好" {
		t.Fatalf("salutation = %q, want 晚上好", resp.Salutation)
	}
	if resp.Model != "gpt-5.3-codex" || resp.Provider != "codex-sol" {
		t.Fatalf("model/provider = %q/%q", resp.Model, resp.Provider)
	}
	if len(resp.Suggestions) != 2 {
		t.Fatalf("expected 2 valid suggestions (invalid resume_session filtered), got %d: %+v", len(resp.Suggestions), resp.Suggestions)
	}
	if resp.Suggestions[0].ActionKind != "resume_session" || resp.Suggestions[0].Payload != "sess-rev-1" {
		t.Fatalf("unexpected first suggestion: %+v", resp.Suggestions[0])
	}
	if !strings.Contains(stub.lastIn.Messages[0].Text(), "carrier.bin") || !strings.Contains(stub.lastIn.Messages[0].Text(), "H-004") {
		t.Fatalf("prompt missing cached memory details: %s", stub.lastIn.Messages[0].Text())
	}
}

func TestGreetWithModelTimeoutAndMissingKeyFallback(t *testing.T) {
	cfg := &types.AgentConfig{
		Name:            "0xaf",
		PlannerProvider: "slow-llm",
		Providers: map[string]*types.ProviderConfig{
			"slow-llm": {
				Type:  types.KindAnthropic,
				Model: "claude-opus-4-6",
			},
		},
	}

	t.Run("timeout falls back gracefully to local-cache", func(t *testing.T) {
		stub := &stubGreetingProvider{
			name: "slow-llm",
			cfg:  cfg.Providers["slow-llm"],
			fn: func(input types.ProviderInput) (types.ProviderResponse, error) {
				<-input.Context().Done()
				return types.ProviderResponse{}, input.Context().Err()
			},
		}
		withGreetingHooks(t, cfg, func(string, *types.ProviderConfig) (types.Provider, error) {
			return stub, nil
		}, 40*time.Millisecond)

		app := NewApp()
		start := time.Now()
		resp := app.GreetWithModel(GreetingRequest{
			LocalHour: 9,
			RecentSessions: []GreetingSessionMemory{
				{
					SessionID:       "s-1",
					Workspace:       "/tmp/fw-audit",
					REPhase:         "dynamic",
					UnverifiedCount: 2,
					OpenHypotheses: []GreetingHypothesisSummary{
						{ID: "H-001", Claim: "固件解密表位于 0x8020", Status: "reevaluate"},
					},
				},
			},
		})
		if time.Since(start) > 2*time.Second {
			t.Fatalf("timeout took too long: %v", time.Since(start))
		}
		if resp.Source != "local-cache" {
			t.Fatalf("source = %q, want local-cache", resp.Source)
		}
		if resp.Salutation != "早上好" {
			t.Fatalf("salutation = %q, want 早上好", resp.Salutation)
		}
		if len(resp.Suggestions) < 2 {
			t.Fatalf("expected >= 2 fallback suggestions, got %+v", resp.Suggestions)
		}
		if !strings.Contains(resp.Summary, "fw-audit") {
			t.Fatalf("fallback summary should mention workspace, got %q", resp.Summary)
		}
	})

	t.Run("missing API key falls back without crashing", func(t *testing.T) {
		stub := &stubGreetingProvider{
			name: "slow-llm",
			cfg:  cfg.Providers["slow-llm"],
			fn: func(input types.ProviderInput) (types.ProviderResponse, error) {
				return types.ProviderResponse{}, errors.New("missing ANTHROPIC_API_KEY")
			},
		}
		withGreetingHooks(t, cfg, func(string, *types.ProviderConfig) (types.Provider, error) {
			return stub, nil
		}, time.Second)

		app := NewApp()
		resp := app.GreetWithModel(GreetingRequest{LocalHour: 15})
		if resp.Source != "local-cache" {
			t.Fatalf("source = %q, want local-cache", resp.Source)
		}
		if resp.Salutation != "下午好" {
			t.Fatalf("salutation = %q, want 下午好", resp.Salutation)
		}
		if !strings.Contains(resp.FallbackNote, "ANTHROPIC_API_KEY") {
			t.Fatalf("expected fallback note to retain error context, got %q", resp.FallbackNote)
		}
	})

	t.Run("mock provider skips Complete instantaneously", func(t *testing.T) {
		mockCfg := &types.AgentConfig{
			Name:            "0xaf",
			PlannerProvider: "mock",
			Providers: map[string]*types.ProviderConfig{
				"mock": {Type: types.KindMock, Model: "mock-1"},
			},
		}
		created := false
		withGreetingHooks(t, mockCfg, func(string, *types.ProviderConfig) (types.Provider, error) {
			created = true
			return nil, errors.New("should not be called for mock provider")
		}, time.Second)

		app := NewApp()
		resp := app.GreetWithModel(GreetingRequest{LocalHour: 23})
		if created {
			t.Fatal("mock provider must not invoke provider factory")
		}
		if resp.Source != "local-cache" || resp.Salutation != "夜深了" {
			t.Fatalf("unexpected mock response: %+v", resp)
		}
	})
}

func TestBuildGreetingPromptTruncatesAndCapsSessions(t *testing.T) {
	sessions := make([]GreetingSessionMemory, 0, 6)
	for i := 0; i < 6; i++ {
		sessions = append(sessions, GreetingSessionMemory{
			SessionID:  "s-" + string(rune('a'+i)),
			Workspace:  "/lab/ws-" + string(rune('a'+i)),
			TargetFile: "sample.bin",
			REPhase:    "static",
			Objective:  strings.Repeat("逆向目标分析", 30),
			LastPrompt: strings.Repeat("检查加密函数", 25),
		})
	}
	sys, usr := buildGreetingPrompt(GreetingRequest{
		TimeOfDay:       "morning",
		LocalHour:       8,
		ActiveSession:   "s-a",
		ActiveWorkspace: "/lab/ws-a",
		RecentSessions:  sessions,
	}, "codex-sol", "gpt-5.3-codex")

	if !strings.Contains(sys, "JSON") {
		t.Fatalf("system prompt must instruct JSON output: %s", sys)
	}
	if !strings.Contains(usr, "ws-a") || !strings.Contains(usr, "ws-d") {
		t.Fatalf("user prompt should include top 4 sessions: %s", usr)
	}
	if strings.Contains(usr, "ws-e") || strings.Contains(usr, "ws-f") {
		t.Fatalf("user prompt should cap sessions to 4: %s", usr)
	}
	if !strings.Contains(usr, "…") {
		t.Fatalf("long objective/prompt should be truncated with ellipsis: %s", usr)
	}
}
