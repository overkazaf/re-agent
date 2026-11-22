package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/providers"
	"github.com/overkazaf/re-agent/internal/types"
)

// GreetingHypothesisSummary is a compact hypothesis snapshot passed from the
// frontend's local investigation memory cache.
type GreetingHypothesisSummary struct {
	ID     string `json:"id"`
	Claim  string `json:"claim"`
	Status string `json:"status"`
}

// GreetingSessionMemory is a compact summary of one recent session stored in
// the frontend's local cache.
type GreetingSessionMemory struct {
	SessionID       string                      `json:"sessionId"`
	Workspace       string                      `json:"workspace"`
	TargetFile      string                      `json:"targetFile,omitempty"`
	Objective       string                      `json:"objective,omitempty"`
	REPhase         string                      `json:"rePhase,omitempty"`
	OpenHypotheses  []GreetingHypothesisSummary `json:"openHypotheses,omitempty"`
	PendingCount    int                         `json:"pendingCount,omitempty"`
	UnverifiedCount int                         `json:"unverifiedCount,omitempty"`
	LastPrompt      string                      `json:"lastPrompt,omitempty"`
	UpdatedAt       int64                       `json:"updatedAt,omitempty"`
}

// GreetingRequest carries time-of-day context and compact cached session memory
// for a single-shot read-only startup greeting.
type GreetingRequest struct {
	TimeOfDay       string                  `json:"timeOfDay,omitempty"`
	LocalHour       int                     `json:"localHour,omitempty"`
	ActiveSession   string                  `json:"activeSession,omitempty"`
	ActiveWorkspace string                  `json:"activeWorkspace,omitempty"`
	PreferredModel  string                  `json:"preferredModel,omitempty"`
	RecentSessions  []GreetingSessionMemory `json:"recentSessions,omitempty"`
	ForceRefresh    bool                    `json:"forceRefresh,omitempty"`
}

// GreetingSuggestion is one executable next-step chip rendered in the startup
// greeting card.
type GreetingSuggestion struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Reason     string `json:"reason"`
	ActionKind string `json:"actionKind"` // resume_session | send_prompt | fill_prompt | run_command | open_re_picker | new_session
	Payload    string `json:"payload"`
}

// GreetingResponse is the greeting payload returned to the frontend.
type GreetingResponse struct {
	Salutation   string               `json:"salutation"`
	Summary      string               `json:"summary"`
	Suggestions  []GreetingSuggestion `json:"suggestions"`
	Model        string               `json:"model"`
	Provider     string               `json:"provider"`
	Source       string               `json:"source"` // "llm" | "local-cache"
	GeneratedAt  int64                `json:"generatedAt"`
	FallbackNote string               `json:"fallbackNote,omitempty"`
}

// Testable seams for unit testing without network calls or global config files.
var (
	greetingTimeout        = 6 * time.Second
	greetingLoadConfig     = loadConfig
	greetingCreateProvider = providers.Create
)

var validGreetingActionKinds = map[string]bool{
	"resume_session": true,
	"send_prompt":    true,
	"fill_prompt":    true,
	"run_command":    true,
	"open_re_picker": true,
	"new_session":    true,
}

func (a *App) greetWithModel(req GreetingRequest) GreetingResponse {
	cfg := a.resolveGreetingConfig(req.ActiveWorkspace)
	providerName, providerCfg := selectGreetingProvider(cfg, req.PreferredModel)
	modelName := ""
	if providerCfg != nil {
		modelName = strings.TrimSpace(providerCfg.Model)
	}
	if modelName == "" {
		modelName = providerName
	}

	// Never attempt network calls for unconfigured or mock providers (keeps E2E
	// and offline startups instantaneous with zero console noise).
	if providerCfg == nil || providerCfg.Type == types.KindMock || strings.EqualFold(providerName, "mock") {
		note := "mock provider active"
		if providerCfg == nil {
			note = "no llm provider configured"
		}
		return buildDeterministicGreeting(req, providerName, modelName, note)
	}

	provider, err := greetingCreateProvider(providerName, providerCfg)
	if err != nil {
		return buildDeterministicGreeting(req, providerName, modelName, fmt.Sprintf("provider init: %v", err))
	}

	baseCtx := a.ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	ctx, cancel := context.WithTimeout(baseCtx, greetingTimeout)
	defer cancel()

	systemPrompt, userPrompt := buildGreetingPrompt(req, providerName, modelName)
	resp, err := provider.Complete(types.ProviderInput{
		System:       systemPrompt,
		Messages:     []types.Message{types.UserMessage(userPrompt)},
		Tools:        nil, // strictly read-only, zero-tool single-shot
		Workspace:    strings.TrimSpace(req.ActiveWorkspace),
		Ctx:          ctx,
		FreshSession: true,
	})
	if err != nil {
		return buildDeterministicGreeting(req, providerName, modelName, shortGreetingErr(err))
	}

	parsed, parseErr := parseGreetingLLMOutput(resp.Text, req, providerName, modelName)
	if parseErr != nil {
		return buildDeterministicGreeting(req, providerName, modelName, shortGreetingErr(parseErr))
	}
	return parsed
}

func (a *App) resolveGreetingConfig(activeWorkspace string) *types.AgentConfig {
	if a != nil && a.manager != nil {
		if state := a.manager.anyState(); state != nil && state.Config != nil {
			return state.Config
		}
	}
	cfg, cfgPath, err := greetingLoadConfig()
	if err != nil || cfg == nil {
		return nil
	}
	ws := strings.TrimSpace(activeWorkspace)
	if ws != "" {
		localCfg := filepath.Join(ws, "agent.config.json")
		if localCfg != cfgPath {
			if _, statErr := os.Stat(localCfg); statErr == nil {
				if loaded, _, loadErr := config.Load(localCfg); loadErr == nil && loaded != nil {
					cfg = loaded
				}
			}
		}
		auth.InitializeSources(cfg, ws)
	} else {
		auth.InitializeSources(cfg, guiHomeDir())
	}
	return cfg
}

func selectGreetingProvider(cfg *types.AgentConfig, preferred string) (string, *types.ProviderConfig) {
	if cfg == nil || len(cfg.Providers) == 0 {
		return "", nil
	}
	// Honor explicit preferred provider/model name if it matches a configured provider.
	pref := strings.TrimSpace(preferred)
	if pref != "" {
		if p, ok := cfg.Providers[pref]; ok && p != nil {
			return pref, p
		}
		for name, p := range cfg.Providers {
			if p != nil && strings.EqualFold(strings.TrimSpace(p.Model), pref) {
				return name, p
			}
		}
	}
	for _, candidate := range []string{cfg.PlannerProvider, cfg.ExecutorProvider, cfg.ResearcherProvider} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if p, ok := cfg.Providers[candidate]; ok && p != nil {
			return candidate, p
		}
	}
	names := make([]string, 0, len(cfg.Providers))
	for name := range cfg.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if p := cfg.Providers[name]; p != nil && p.Type != types.KindMock {
			return name, p
		}
	}
	for _, name := range names {
		if p := cfg.Providers[name]; p != nil {
			return name, p
		}
	}
	return "", nil
}

// buildGreetingPrompt constructs a tight, token-efficient system + user prompt
// for single-shot JSON synthesis in natural Chinese.
func buildGreetingPrompt(req GreetingRequest, providerName, modelName string) (string, string) {
	systemPrompt := strings.Join([]string{
		"你是 0xAF-Re 逆向取证工作台的智能副驾。",
		"任务：根据当前时段和用户最近本地缓存的逆向会话记忆，生成一句简短温暖的中文问候、1-2句精炼进展回顾，以及 2-3 个可直接点击执行的下一步任务建议。",
		"要求：",
		"1. 严格只输出一个 JSON 对象，不要输出任何额外说明或 Markdown 代码块。",
		`2. JSON 结构：{"salutation":"...","summary":"...","suggestions":[{"id":"s1","label":"<=12字短标签","reason":"<=36字悬停提示原因","actionKind":"resume_session|run_command|fill_prompt|send_prompt|open_re_picker|new_session","payload":"..."}]}`,
		"3. actionKind 规则：",
		"   - resume_session: payload 为要恢复的历史 sessionId（仅限给定记忆中出现的 sessionId）",
		"   - run_command: payload 为斜杠命令，如 /audit、/phase、/status",
		"   - fill_prompt 或 send_prompt: payload 为一句具体的中文逆向分析指令",
		"   - open_re_picker: payload 留空字符串，用于打开逆向样本选择器",
		"   - new_session: payload 留空字符串，用于新建工作区会话",
		"4. 保持专业克制、简短优雅，避免冗长客套，绝不捏造不存在的文件或证据编号。",
	}, "\n")

	var b strings.Builder
	tod := normalizeTimeOfDay(req.TimeOfDay, req.LocalHour)
	fmt.Fprintf(&b, "时段: %s (hour=%d)\n", tod, req.LocalHour)
	if modelName != "" {
		fmt.Fprintf(&b, "当前模型: %s (provider=%s)\n", modelName, providerName)
	}
	if req.ActiveSession != "" {
		fmt.Fprintf(&b, "当前活跃会话: %s", req.ActiveSession)
		if req.ActiveWorkspace != "" {
			fmt.Fprintf(&b, " (%s)", greetingBaseName(req.ActiveWorkspace))
		}
		b.WriteByte('\n')
	} else {
		b.WriteString("当前活跃会话: 无\n")
	}

	limit := len(req.RecentSessions)
	if limit > 4 {
		limit = 4
	}
	if limit == 0 {
		b.WriteString("本地缓存会话记忆: 暂无历史记录（首次启动或已清空）。\n")
	} else {
		b.WriteString("最近缓存会话记忆（按时间倒序）:\n")
		for i := 0; i < limit; i++ {
			s := req.RecentSessions[i]
			ws := greetingBaseName(s.Workspace)
			fmt.Fprintf(&b, "- [%s] workspace=%s", s.SessionID, ws)
			if s.TargetFile != "" {
				fmt.Fprintf(&b, " target=%s", truncateRunes(s.TargetFile, 48))
			}
			if s.REPhase != "" {
				fmt.Fprintf(&b, " phase=%s", s.REPhase)
			}
			if s.PendingCount > 0 {
				fmt.Fprintf(&b, " pending=%d", s.PendingCount)
			}
			if s.UnverifiedCount > 0 {
				fmt.Fprintf(&b, " unverified=%d", s.UnverifiedCount)
			}
			if s.Objective != "" {
				fmt.Fprintf(&b, " objective=%q", truncateRunes(s.Objective, 80))
			}
			if s.LastPrompt != "" {
				fmt.Fprintf(&b, " lastPrompt=%q", truncateRunes(s.LastPrompt, 64))
			}
			b.WriteByte('\n')
			hypLimit := len(s.OpenHypotheses)
			if hypLimit > 3 {
				hypLimit = 3
			}
			for j := 0; j < hypLimit; j++ {
				h := s.OpenHypotheses[j]
				fmt.Fprintf(&b, "  * %s [%s]: %s\n", h.ID, h.Status, truncateRunes(h.Claim, 72))
			}
		}
	}

	return systemPrompt, b.String()
}

type rawGreetingJSON struct {
	Salutation  string               `json:"salutation"`
	Summary     string               `json:"summary"`
	Suggestions []GreetingSuggestion `json:"suggestions"`
}

func parseGreetingLLMOutput(raw string, req GreetingRequest, providerName, modelName string) (GreetingResponse, error) {
	cleaned := extractJSONBlock(raw)
	if cleaned == "" {
		return GreetingResponse{}, fmt.Errorf("empty json in model response")
	}
	var parsed rawGreetingJSON
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		return GreetingResponse{}, fmt.Errorf("invalid greeting json: %w", err)
	}
	salutation := truncateRunes(strings.TrimSpace(parsed.Salutation), 24)
	summary := truncateRunes(strings.TrimSpace(parsed.Summary), 180)
	if salutation == "" {
		salutation = greetingSalutation(normalizeTimeOfDay(req.TimeOfDay, req.LocalHour))
	}
	if summary == "" {
		return GreetingResponse{}, fmt.Errorf("greeting json missing summary")
	}

	validSessionIDs := map[string]bool{}
	for _, s := range req.RecentSessions {
		if id := strings.TrimSpace(s.SessionID); id != "" {
			validSessionIDs[id] = true
		}
	}

	suggestions := make([]GreetingSuggestion, 0, 3)
	seenLabels := map[string]bool{}
	for i, s := range parsed.Suggestions {
		if len(suggestions) >= 3 {
			break
		}
		label := truncateRunes(strings.TrimSpace(s.Label), 24)
		reason := truncateRunes(strings.TrimSpace(s.Reason), 72)
		kind := strings.TrimSpace(s.ActionKind)
		payload := strings.TrimSpace(s.Payload)
		if label == "" || !validGreetingActionKinds[kind] {
			continue
		}
		if kind == "resume_session" && !validSessionIDs[payload] {
			continue
		}
		if (kind == "run_command" || kind == "send_prompt" || kind == "fill_prompt") && payload == "" {
			continue
		}
		if seenLabels[label] {
			continue
		}
		seenLabels[label] = true
		id := strings.TrimSpace(s.ID)
		if id == "" {
			id = fmt.Sprintf("llm-%d", i+1)
		}
		if reason == "" {
			reason = "基于当前模型与近期分析上下文推荐的下一步操作"
		}
		suggestions = append(suggestions, GreetingSuggestion{
			ID:         id,
			Label:      label,
			Reason:     reason,
			ActionKind: kind,
			Payload:    payload,
		})
	}

	// Ensure at least 2 actionable chips by padding from deterministic defaults.
	if len(suggestions) < 2 {
		fallback := buildDeterministicGreeting(req, providerName, modelName, "")
		for _, item := range fallback.Suggestions {
			if len(suggestions) >= 3 {
				break
			}
			if seenLabels[item.Label] {
				continue
			}
			seenLabels[item.Label] = true
			suggestions = append(suggestions, item)
		}
	}

	return GreetingResponse{
		Salutation:  salutation,
		Summary:     summary,
		Suggestions: suggestions,
		Model:       modelName,
		Provider:    providerName,
		Source:      "llm",
		GeneratedAt: types.NowMs(),
	}, nil
}

func extractJSONBlock(text string) string {
	s := strings.TrimSpace(text)
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "```") {
		if idx := strings.Index(s, "\n"); idx >= 0 {
			s = s[idx+1:]
		}
		if end := strings.LastIndex(s, "```"); end >= 0 {
			s = s[:end]
		}
		s = strings.TrimSpace(s)
	}
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start < 0 || end <= start {
		return ""
	}
	return strings.TrimSpace(s[start : end+1])
}

func buildDeterministicGreeting(req GreetingRequest, providerName, modelName, fallbackNote string) GreetingResponse {
	tod := normalizeTimeOfDay(req.TimeOfDay, req.LocalHour)
	salutation := greetingSalutation(tod)

	var summary string
	suggestions := make([]GreetingSuggestion, 0, 3)

	if len(req.RecentSessions) == 0 {
		if req.ActiveWorkspace != "" {
			ws := greetingBaseName(req.ActiveWorkspace)
			summary = fmt.Sprintf("工作区 %s 已就绪，暂无历史假设或取证缓存。可以从选择逆向样本或直接发起静态分诊开始。", ws)
		} else {
			summary = "工作台已就绪，本地暂无历史逆向会话记录。可以新建工作区会话，或启动 9 阶段逆向工作流快速分诊样本。"
		}
		if req.ActiveSession != "" {
			suggestions = append(suggestions,
				GreetingSuggestion{
					ID:         "open-re-picker",
					Label:      "新建逆向样本",
					Reason:     "按样本类型（ELF/APK/PE/固件）启动 9 阶段取证主线",
					ActionKind: "open_re_picker",
					Payload:    "",
				},
				GreetingSuggestion{
					ID:         "quick-scan",
					Label:      "快速工作区盘点",
					Reason:     "列出当前工作区待分析目标并做初始指纹分诊",
					ActionKind: "fill_prompt",
					Payload:    "先扫描当前工作区文件结构与可疑二进制入口，给出分诊建议",
				},
			)
		} else {
			suggestions = append(suggestions,
				GreetingSuggestion{
					ID:         "new-session",
					Label:      "新建逆向会话",
					Reason:     "选择本地工作区目录并初始化分析会话",
					ActionKind: "new_session",
					Payload:    "",
				},
				GreetingSuggestion{
					ID:         "quick-help",
					Label:      "查看命令速览",
					Reason:     "了解内置离线取证、解码与审计斜杠命令",
					ActionKind: "fill_prompt",
					Payload:    "/help",
				},
			)
		}
	} else {
		latest := req.RecentSessions[0]
		ws := greetingBaseName(latest.Workspace)
		target := strings.TrimSpace(latest.TargetFile)
		if target == "" {
			target = ws
		} else {
			target = greetingBaseName(target)
		}

		// Build concise 1-2 sentence progress recap.
		parts := make([]string, 0, 3)
		if latest.REPhase != "" {
			parts = append(parts, fmt.Sprintf("上次在 %s（%s）停留在 %s 阶段", ws, target, latest.REPhase))
		} else {
			parts = append(parts, fmt.Sprintf("上次在工作区 %s 开展分析", ws))
		}

		reevalCount := 0
		for _, h := range latest.OpenHypotheses {
			if strings.EqualFold(h.Status, "reevaluate") {
				reevalCount++
			}
		}
		if reevalCount > 0 {
			parts = append(parts, fmt.Sprintf("有 %d 条假设待重新评估", reevalCount))
		} else if len(latest.OpenHypotheses) > 0 {
			parts = append(parts, fmt.Sprintf("保留 %d 条活跃假设", len(latest.OpenHypotheses)))
		}
		if latest.UnverifiedCount > 0 {
			parts = append(parts, fmt.Sprintf("%d 项结论尚待动态验证", latest.UnverifiedCount))
		} else if latest.PendingCount > 0 {
			parts = append(parts, fmt.Sprintf("%d 个计划步骤未完成", latest.PendingCount))
		}
		summary = strings.Join(parts, "，") + "。"

		// Action 1: resume previous session if not already active, otherwise continue work.
		if latest.SessionID != "" && latest.SessionID != req.ActiveSession {
			suggestions = append(suggestions, GreetingSuggestion{
				ID:         "resume-last",
				Label:      "继续上次任务",
				Reason:     fmt.Sprintf("恢复 %s 的历史上下文与证据账本", ws),
				ActionKind: "resume_session",
				Payload:    latest.SessionID,
			})
		} else if len(latest.OpenHypotheses) > 0 {
			topHyp := latest.OpenHypotheses[0]
			suggestions = append(suggestions, GreetingSuggestion{
				ID:         "continue-hyp",
				Label:      fmt.Sprintf("推进 %s 验证", topHyp.ID),
				Reason:     fmt.Sprintf("继续核验假设 %s：%s", topHyp.ID, truncateRunes(topHyp.Claim, 40)),
				ActionKind: "fill_prompt",
				Payload:    fmt.Sprintf("基于现有证据继续验证假设 %s（%s），补充缺失的动静态交叉证据", topHyp.ID, truncateRunes(topHyp.Claim, 60)),
			})
		}

		// Action 2: suggest /audit when in verify/audit phase or when open hypotheses exist.
		phase := strings.ToLower(strings.TrimSpace(latest.REPhase))
		if phase == "verify" || phase == "audit" || latest.UnverifiedCount > 0 || len(latest.OpenHypotheses) > 0 {
			suggestions = append(suggestions, GreetingSuggestion{
				ID:         "run-audit",
				Label:      "执行 /audit 复核",
				Reason:     "触发独立审计席位检查当前假设栈与证据引用缺口",
				ActionKind: "run_command",
				Payload:    "/audit",
			})
		} else if latest.LastPrompt != "" {
			suggestions = append(suggestions, GreetingSuggestion{
				ID:         "follow-up",
				Label:      "接续上次提问",
				Reason:     fmt.Sprintf("延续上一次分析意图：%s", truncateRunes(latest.LastPrompt, 36)),
				ActionKind: "fill_prompt",
				Payload:    fmt.Sprintf("接着上次的分析继续推进：%s", truncateRunes(latest.LastPrompt, 80)),
			})
		}

		// Action 3: start fresh RE sample or new session.
		if len(suggestions) < 3 {
			if req.ActiveSession != "" {
				suggestions = append(suggestions, GreetingSuggestion{
					ID:         "open-re-picker",
					Label:      "新建逆向样本",
					Reason:     "在当前会话选择新的样本类型并开启 9 阶段逆向流程",
					ActionKind: "open_re_picker",
					Payload:    "",
				})
			} else {
				suggestions = append(suggestions, GreetingSuggestion{
					ID:         "new-session",
					Label:      "新建逆向会话",
					Reason:     "打开新工作区开始独立逆向任务",
					ActionKind: "new_session",
					Payload:    "",
				})
			}
		}
	}

	return GreetingResponse{
		Salutation:   salutation,
		Summary:      summary,
		Suggestions:  suggestions,
		Model:        modelName,
		Provider:     providerName,
		Source:       "local-cache",
		GeneratedAt:  types.NowMs(),
		FallbackNote: fallbackNote,
	}
}

func normalizeTimeOfDay(raw string, hour int) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "morning", "afternoon", "evening", "late_night":
		return strings.ToLower(strings.TrimSpace(raw))
	}
	if hour >= 5 && hour < 12 {
		return "morning"
	}
	if hour >= 12 && hour < 18 {
		return "afternoon"
	}
	if hour >= 18 && hour < 23 {
		return "evening"
	}
	return "late_night"
}

func greetingSalutation(tod string) string {
	switch tod {
	case "morning":
		return "早上好"
	case "afternoon":
		return "下午好"
	case "evening":
		return "晚上好"
	default:
		return "夜深了"
	}
}

func greetingBaseName(path string) string {
	cleaned := strings.TrimRight(strings.TrimSpace(path), "/\\")
	if cleaned == "" {
		return "workspace"
	}
	base := filepath.Base(cleaned)
	if base == "" || base == "." || base == "/" {
		return cleaned
	}
	return base
}

func truncateRunes(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 1 {
		return string(runes[:max])
	}
	return string(runes[:max-1]) + "…"
}

func shortGreetingErr(err error) string {
	if err == nil {
		return ""
	}
	return truncateRunes(err.Error(), 96)
}
