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
	Off         Mode = "off"
	Auto        Mode = "auto"
	Specialist  Mode = "specialist"
	Caveman     Mode = "caveman"
	Research    Mode = "research"
	Writeup     Mode = "writeup"
	CTF         Mode = "ctf"
	Reverse     Mode = "reverse"
	Engineering Mode = "engineering"
)

var Modes = []Mode{Off, Auto, Specialist, Caveman, Research, Writeup, CTF, Reverse, Engineering}

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

func WrapPrompt(prompt string, requested Mode, config *types.AgentConfig, pinnedProvider string, reState *REState) string {
	effective := Effective(requested, config, pinnedProvider)
	switch effective {
	case Specialist:
		return wrapSpecialist(prompt, requested)
	case Caveman:
		return wrapCaveman(prompt, requested)
	case Research:
		return wrapResearch(prompt, requested)
	case Writeup:
		return wrapWriteup(prompt, requested)
	case CTF:
		return wrapCTF(prompt, requested)
	case Reverse:
		return WrapReverseWithPhase(prompt, reState)
	case Engineering:
		return wrapEngineering(prompt, requested)
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

func wrapResearch(prompt string, requested Mode) string {
	return strings.Join([]string{
		"0xAF-Re workflow mode: research",
		"",
		"Purpose: survey public resources and produce a sourced report for the task.",
		"",
		"Rules:",
		"1. Treat this as authorized research over public information.",
		"2. Prefer primary sources: vendor documentation, official repositories,",
		"   GitHub code/issues/releases, arXiv abstracts, papers, standards bodies.",
		"3. Use network tools when the session allows them (curl, git clone, arXiv",
		"   API, GitHub API/search). If network is disabled, state that clearly and",
		"   work from local files and the knowledge base only.",
		"4. For every finding record the source (URL/repo/DOI), what it says, why it",
		"   matters, and your confidence.",
		"5. End with a report: 结论 (what is true / what to do), 资源清单 (sources",
		"   with links), 待确认 (gaps and unverified claims), 下一步.",
		"6. Never fabricate sources or links. Mark anything not verified as unverified.",
		"",
		"Original user task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func wrapWriteup(prompt string, requested Mode) string {
	return strings.Join([]string{
		"0xAF-Re workflow mode: writeup",
		"",
		"Purpose: turn existing information into a clean summary report.",
		"",
		"Rules:",
		"1. Base the report ONLY on evidence already present in this session: tool",
		"   outputs, code, notes, transcript, and knowledge entries.",
		"2. Structure: 背景/目标, 方法, 关键发现 (with evidence paths, offsets,",
		"   commands), 结论, 坑, 下一步.",
		"3. Never invent facts, offsets, hashes, or citations. Mark uncertainty",
		"   explicitly instead of guessing.",
		"4. Keep every command and artifact reproducible from the report.",
		"5. If information is missing, list it as a gap rather than papering over it.",
		"",
		"Original user task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func wrapCTF(prompt string, requested Mode) string {
	return strings.Join([]string{
		"0xAF-Re workflow mode: ctf",
		"",
		"Purpose: work one concrete challenge target end-to-end.",
		"",
		"Rules:",
		"1. Triage first: file type, strings, entropy, protections, imports/symbols,",
		"   packer hints — cheap facts before hypotheses.",
		"2. Identify the challenge class (crypto, pwn, reverse, web, forensics,",
		"   misc) and publish a short 3-7 step plan.",
		"3. Work the plan with local tools; verify every hypothesis with one small",
		"   command before moving on.",
		"4. When a solve path appears, extract the exact flag/token and verify it",
		"   against the challenge format.",
		"5. Preserve evidence: commands, offsets, decoded values, artifacts.",
		"6. Stay on the authorized challenge artifact; refuse unrelated targets.",
		"",
		"Original user task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func wrapReverse(prompt string, requested Mode) string {
	return strings.Join([]string{
		"0xAF-Re workflow mode: reverse",
		"",
		"Purpose: static and dynamic analysis toward the stated goal, ending with a",
		"core PoC that proves the recovered behavior.",
		"",
		"Rules:",
		"1. Start from the goal: what must be proven or recovered (flag, key,",
		"   protocol, algorithm, format).",
		"2. Static pass: file/arch/packer, symbols, imports, strings, disassembly,",
		"   decompilation, key routines.",
		"3. Dynamic pass: run the target in the lab, observe behavior, hook or debug",
		"   where available, and capture inputs/outputs.",
		"4. Write a minimal PoC that reproduces the recovered behavior end-to-end",
		"   (input -> expected output) and verify it.",
		"5. Preserve evidence and annotate confidence per finding: offsets,",
		"   addresses, commands, outputs.",
		"",
		"Original user task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func WrapReverseWithPhase(prompt string, state *REState) string {
	if state == nil {
		return wrapReverse(prompt, Reverse)
	}
	return strings.Join([]string{
		"0xAF-Re workflow mode: reverse",
		fmt.Sprintf("Sample type: %s | Current phase: %s", state.SampleType, state.Phase),
		"",
		phasePromptBlock(state),
		"",
		reStateBlock(state),
		"",
		"Original user task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func phasePromptBlock(state *REState) string {
	switch state.Phase {
	case PhaseTriage:
		return "PHASE: TRIAGE\nGoal: identify file type, architecture, packer, protections, and basic metadata.\nDo: file_info, strings, entropy_scan, binary_mitigations. Report a quick summary.\nThen: call update_re_state to advance to 'static' when triage is complete."
	case PhaseStatic:
		return "PHASE: STATIC ANALYSIS\nGoal: disassemble/decompile key routines, map imports/exports, identify algorithms.\nDo: focused disassembly, decompilation, symbol analysis, string cross-references.\nThen: record hypotheses with update_re_state, advance to 'dynamic' when ready."
	case PhaseDynamic:
		return "PHASE: DYNAMIC ANALYSIS\nGoal: observe runtime behavior, hook functions, capture I/O, verify static findings.\nDo: run in lab, set breakpoints, attach hooks (Frida/GDB), capture traffic.\nThen: record observations as evidence, advance to 'evidence'."
	case PhaseEvidence:
		return "PHASE: EVIDENCE PRODUCTION\nGoal: compile and verify all collected evidence into a structured evidence table.\nDo: organize findings by offset/address, verify each with a minimal command, rate confidence.\nThen: advance to 'interface' when the evidence table is solid."
	case PhaseInterface:
		return "PHASE: INTERFACE RECOVERY\nGoal: reconstruct the target's interface — data models, protocol, API surface.\nDo: build client stubs, request builders, data models from evidence.\nThen: advance to 'hypothesis' to validate and revise."
	case PhaseHypothesis:
		return "PHASE: HYPOTHESIS REVISION\nGoal: review all hypotheses against evidence, revise or confirm each.\nDo: for each hypothesis, check supporting/contradicting evidence, update confidence.\nThen: advance to 'writeup' when the analysis is converged."
	case PhaseWriteup:
		return "PHASE: WRITEUP\nGoal: produce the final report — background, method, findings, PoC, gaps, next steps.\nDo: write a structured report with all evidence, commands, and confidence annotations."
	default:
		return ""
	}
}

func reStateBlock(state *REState) string {
	var parts []string
	if len(state.Hypotheses) > 0 {
		parts = append(parts, "Active hypotheses:")
		for i, h := range state.Hypotheses {
			line := fmt.Sprintf("  [H%d] %s", i, h.Text)
			if h.Revised != "" {
				line += fmt.Sprintf(" → REVISED: %s", h.Revised)
			}
			parts = append(parts, line)
		}
	}
	if len(state.Evidence) > 0 {
		parts = append(parts, "Collected evidence:")
		for i, e := range state.Evidence {
			parts = append(parts, fmt.Sprintf("  [E%d] %s", i, e.Text))
		}
	}
	if len(parts) == 0 {
		return "No hypotheses or evidence recorded yet."
	}
	return strings.Join(parts, "\n")
}

func wrapEngineering(prompt string, requested Mode) string {
	return strings.Join([]string{
		"0xAF-Re workflow mode: engineering",
		"",
		"Purpose: reconstruct a target's interface into reusable engineering",
		"artifacts (data models, client stubs, request builders, tests).",
		"",
		"Rules:",
		"1. Map the interface first: entry points/endpoints, request and response",
		"   shapes, parameters, auth, error semantics.",
		"2. Recover the protocol or schema from evidence: traffic captures, docs,",
		"   binaries, code, and observed behavior.",
		"3. Produce engineering artifacts: data models, client stub, request",
		"   builders, worked examples, round-trip tests.",
		"4. Verify each artifact against real evidence: replay a captured request,",
		"   round-trip a parsed message, run the test.",
		"5. Keep the reconstruction faithful: mark assumptions and unknowns",
		"   explicitly instead of inventing behavior.",
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
