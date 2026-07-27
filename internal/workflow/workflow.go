// Package workflow defines high-level RE execution modes. Specialist mode is a
// prompt contract for purpose-built routes; caveman mode is a host-level
// planner -> isolated executor delegation with a narrow local-evidence surface.
package workflow

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

type Mode string

const (
	Off        Mode = "off"
	Auto       Mode = "auto"
	Specialist Mode = "specialist"
	Caveman    Mode = "caveman"
)

var Modes = []Mode{Off, Auto, Specialist, Caveman}

func IsMode(value string) bool {
	for _, mode := range Modes {
		if string(mode) == value {
			return true
		}
	}
	return false
}

func List() string {
	values := make([]string, 0, len(Modes))
	for _, mode := range Modes {
		values = append(values, string(mode))
	}
	return strings.Join(values, ", ")
}

// Effective resolves auto mode. A specialist provider is opt-in by naming a
// provider/model/label/CLI with cyber/CVP terms in config; otherwise auto falls
// back to caveman, the local-first decomposition mode for ordinary providers.
func Effective(requested Mode, config *types.AgentConfig, pinnedProvider string) Mode {
	if requested == "" || requested == Off {
		return Off
	}
	if requested != Auto {
		return requested
	}
	if HasSpecialistProvider(config, pinnedProvider) {
		return Specialist
	}
	return Caveman
}

func HasSpecialistProvider(config *types.AgentConfig, pinnedProvider string) bool {
	if config == nil {
		return false
	}
	if pinnedProvider != "" {
		return providerLooksSpecialist(pinnedProvider, config.Providers[pinnedProvider])
	}
	for _, name := range []string{config.PlannerProvider, config.ExecutorProvider, researcherProvider(config)} {
		if providerLooksSpecialist(name, config.Providers[name]) {
			return true
		}
	}
	return false
}

func researcherProvider(config *types.AgentConfig) string {
	if config.ResearcherProvider != "" {
		return config.ResearcherProvider
	}
	return config.PlannerProvider
}

func providerLooksSpecialist(name string, provider *types.ProviderConfig) bool {
	fields := []string{name}
	if provider != nil {
		fields = append(fields, provider.Label, provider.Model, provider.CLICommand)
		fields = append(fields, provider.CLIArgs...)
	}
	joined := strings.ToLower(strings.Join(fields, " "))
	for _, marker := range []string{"gpt-cyber", "gpt cyber", "cyber", "cvp", "claude-cvp", "cc-cvp"} {
		if strings.Contains(joined, marker) {
			return true
		}
	}
	return false
}

func Status(requested Mode, config *types.AgentConfig, pinnedProvider string) string {
	effective := Effective(requested, config, pinnedProvider)
	specialist := "not configured"
	if HasSpecialistProvider(config, pinnedProvider) {
		specialist = "configured"
	}
	runner := "single-provider"
	if effective == Caveman && pinnedProvider == "" {
		runner = "delegated-planner-executor"
	}
	return fmt.Sprintf("workflow=%s effective=%s specialist=%s runner=%s", orOff(requested), effective, specialist, runner)
}

func WrapPrompt(prompt string, requested Mode, config *types.AgentConfig, pinnedProvider string) string {
	effective := Effective(requested, config, pinnedProvider)
	switch effective {
	case Specialist:
		return wrapSpecialist(prompt, requested)
	case Caveman:
		return wrapCaveman(prompt, requested)
	default:
		return prompt
	}
}

func wrapSpecialist(prompt string, requested Mode) string {
	return strings.Join([]string{
		"0xAF-Re workflow mode: specialist",
		"",
		"Use this path when the configured route is backed by a GPT Cyber, CC CVP,",
		"or comparable authorized reverse-engineering subscription.",
		"",
		"Rules:",
		"1. Treat the task as authorized local reverse engineering only.",
		"2. Publish a 3-7 step plan before tool work, then execute it.",
		"3. Prefer built-in skills and local tools (`ctf_triage`, `reverse_toolkit`,",
		"   `apk_inspect`, `frida_hook_template`, `knowledge_search`) before broad shell.",
		"4. Preserve evidence: paths, offsets, hashes, commands, outputs, and confidence.",
		"5. If a request moves outside local authorized RE, refuse that part and keep the",
		"   allowed artifact analysis moving.",
		"",
		"Original user task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func wrapCaveman(prompt string, requested Mode) string {
	return strings.Join([]string{
		"0xAF-Re workflow mode: caveman",
		"",
		"This is the fallback for ordinary providers when no GPT Cyber / CC CVP style",
		"specialist route is configured. Do not use translation, classical Chinese,",
		"ciphering, euphemisms, or prompt laundering to bypass a model or site policy.",
		"The point of caveman mode is smaller safe contexts, local evidence, and clear",
		"artifact-focused decomposition.",
		"",
		"Rules:",
		"1. Treat the task as authorized local reverse engineering only.",
		"2. Publish a short plan, then split work into evidence packets:",
		"   artifact -> file type -> strings -> entropy -> imports/symbols -> platform skill",
		"   -> focused hypothesis -> one local verification.",
		"3. Use read-only/local tools first: `ctf_triage`, `file_info`, `strings`,",
		"   `entropy_scan`, `find_bytes`, `carve_artifacts`, `binary_mitigations`,",
		"   `apk_inspect`, `reverse_toolkit inventory/info`, and relevant skills.",
		"4. Keep each reasoning step plain and bounded. Summarize what is known, what",
		"   remains unknown, and the next smallest local command.",
		"5. Do not provide live intrusion, credential theft, persistence, malware",
		"   deployment, or policy-evasion instructions. If that appears, refuse only",
		"   that unsafe part and continue with benign local artifact analysis.",
		"",
		"Original user task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func orOff(mode Mode) Mode {
	if mode == "" {
		return Off
	}
	return mode
}
