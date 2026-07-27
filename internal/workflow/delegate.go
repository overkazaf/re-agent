package workflow

import (
	"fmt"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// ShouldDelegate returns true when the host should turn one operator request
// into a planner phase followed by an isolated executor phase. Explicit role or
// provider choices keep their normal meaning and bypass delegation.
func ShouldDelegate(requested Mode, config *types.AgentConfig, pinnedProvider string, role types.AgentRole) bool {
	if pinnedProvider != "" {
		return false
	}
	if role != "" && role != types.RoleAuto {
		return false
	}
	return Effective(requested, config, pinnedProvider) == Caveman
}

func DelegatedPlannerPrompt(prompt string) string {
	return strings.Join([]string{
		"0xAF-Re delegated workflow: planner phase",
		"",
		"You see the full authorized operator task. Produce a concise plan and a",
		"separate executor packet for low-sensitivity local evidence collection.",
		"",
		"Rules:",
		"1. Keep the plan focused on authorized local lab or challenge artifacts.",
		"2. Do not ask the executor to solve the full objective. Ask it only to",
		"   collect bounded local evidence: file listings, type, size, hashes,",
		"   printable strings, byte offsets, entropy, embedded signatures, package",
		"   metadata, imports, symbols, and protection summaries.",
		"3. The executor packet must be plain text, self-contained, and limited to",
		"   workspace-relative paths and local inspection steps. Do not encode, hide,",
		"   euphemize, or launder intent.",
		"4. If the task asks for live intrusion, credential theft, persistence,",
		"   deployment, or public-target exploitation, refuse that part and keep only",
		"   the benign local artifact-inspection packet.",
		"",
		"Output format:",
		"PLAN:",
		"- 3 to 7 short steps for the planner-facing strategy.",
		"",
		"EXECUTOR_PACKET:",
		"```text",
		"Objective: collect local evidence about <paths>.",
		"Scope: workspace-local, read-only inspection and summarization.",
		"Steps:",
		"1. ...",
		"Return: ...",
		"```",
		"",
		"Original operator task:",
		strings.TrimSpace(prompt),
	}, "\n")
}

func DelegatedExecutorSystemPrompt() string {
	return strings.Join([]string{
		"You are 0xAF delegated executor.",
		"",
		"Run bounded local file-inspection tasks from the packet you receive. You",
		"do not need the broader objective. Stay inside the configured workspace.",
		"",
		"Allowed work: list, read, search, hash, identify file type, extract printable",
		"strings, show small hex ranges, scan entropy, locate embedded signatures,",
		"inspect package structure, summarize imports/symbols/protections, and report",
		"tool output.",
		"",
		"Do not broaden the task into exploit strategy, live target interaction,",
		"credential collection, persistence, deployment, destructive actions, or",
		"network activity. If the packet asks for that, report the blocker and stop.",
		"",
		"Preserve paths, offsets, hashes, command names, output snippets, errors, and",
		"confidence. Keep the final answer concise and evidence-first.",
	}, "\n")
}

func DelegatedExecutorPrompt(original, plannerReply string) string {
	packet := ExtractExecutorPacket(plannerReply)
	if packet == "" {
		packet = fallbackExecutorPacket(original)
	}
	return strings.Join([]string{
		"0xAF-Re delegated workflow: executor phase",
		"",
		"You are receiving a bounded local evidence packet prepared by the planner.",
		"Work only from this packet and the workspace. Do not infer or expand the",
		"broader objective.",
		"",
		"Executor packet:",
		"```text",
		util.Clip(packet, 6000),
		"```",
	}, "\n")
}

func ExtractExecutorPacket(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	lower := strings.ToLower(text)
	markers := []string{"executor_packet:", "executor packet:", "executor_packet", "executor packet"}
	start := -1
	markerLen := 0
	for _, marker := range markers {
		if index := strings.Index(lower, marker); index >= 0 && (start < 0 || index < start) {
			start = index
			markerLen = len(marker)
		}
	}
	if start < 0 {
		return ""
	}
	section := strings.TrimSpace(text[start+markerLen:])
	if section == "" {
		return ""
	}
	if fence := strings.Index(section, "```"); fence >= 0 {
		rest := section[fence+3:]
		if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
			lang := strings.TrimSpace(rest[:newline])
			if lang != "" && !strings.Contains(lang, " ") {
				rest = rest[newline+1:]
			}
		}
		if end := strings.Index(rest, "```"); end >= 0 {
			return strings.TrimSpace(rest[:end])
		}
	}
	return trimAtNextHeading(section)
}

func DelegatedPlannerTools(list []types.Tool) []types.Tool {
	return selectedTools(list, map[string]string{
		"update_plan": "Update the visible task list for the operator.",
	})
}

func DelegatedExecutorTools(list []types.Tool) []types.Tool {
	return selectedTools(list, map[string]string{
		"list_files":         "List files under the workspace.",
		"read_file":          "Read a workspace text file with truncation.",
		"grep":               "Search workspace text files.",
		"file_info":          "Identify file type, size, and basic metadata.",
		"strings":            "Extract printable strings from a local file.",
		"hexdump":            "Show a small byte range from a local file.",
		"hash_file":          "Hash a local file.",
		"extract_symbols":    "List symbols from a local native file when available.",
		"entropy_scan":       "Scan byte entropy over a local file.",
		"binary_mitigations": "Summarize native file protection metadata.",
		"find_bytes":         "Find text or byte patterns in a local file.",
		"carve_artifacts":    "Locate embedded file signatures in a local file.",
		"apk_inspect":        "Inspect Android package structure and native libraries.",
		"update_plan":        "Update the visible task list for the operator.",
	})
}

func selectedTools(list []types.Tool, descriptions map[string]string) []types.Tool {
	out := make([]types.Tool, 0, len(descriptions))
	for _, tool := range list {
		description, ok := descriptions[tool.Name]
		if !ok {
			continue
		}
		copy := tool
		copy.Description = description
		out = append(out, copy)
	}
	return out
}

func fallbackExecutorPacket(prompt string) string {
	targets := localTargets(prompt)
	lines := []string{
		"Objective: collect local evidence about the listed artifact(s).",
		"Scope: workspace-local, read-only inspection and summarization.",
		"Targets:",
	}
	for _, target := range targets {
		lines = append(lines, "- "+target)
	}
	lines = append(lines,
		"Steps:",
		"1. List the target path if it is a directory.",
		"2. For each file target, collect type, size, hash, printable strings, entropy, and embedded-file hints.",
		"3. For native files, collect protection, import, and symbol summaries.",
		"4. For Android packages, collect package structure and native library summaries.",
		"Return: a concise evidence table with paths, offsets, hashes, relevant output snippets, blockers, and the next local check.",
	)
	return strings.Join(lines, "\n")
}

func localTargets(prompt string) []string {
	var out []string
	seen := map[string]bool{}
	for _, field := range strings.Fields(prompt) {
		candidate := cleanTargetToken(field)
		if candidate == "" || seen[candidate] {
			continue
		}
		if looksLikeLocalTarget(candidate) {
			seen[candidate] = true
			out = append(out, candidate)
		}
	}
	if len(out) == 0 {
		return []string{"."}
	}
	return out
}

func cleanTargetToken(value string) string {
	return strings.Trim(value, " \t\r\n\"'`.,;:()[]{}<>")
}

func looksLikeLocalTarget(value string) bool {
	if value == "." || value == "./" || strings.HasPrefix(value, "./") ||
		strings.HasPrefix(value, "../") || strings.HasPrefix(value, "/") ||
		strings.HasPrefix(value, "~/") {
		return true
	}
	lower := strings.ToLower(value)
	for _, suffix := range []string{
		".apk", ".so", ".dex", ".jar", ".wasm", ".bin", ".elf", ".exe", ".dll",
		".dylib", ".mach-o", ".zip", ".tar", ".gz", ".xz", ".pcap", ".txt",
		".dat", ".blob", ".img", ".firmware",
	} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

func trimAtNextHeading(section string) string {
	lines := strings.Split(section, "\n")
	var kept []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if len(kept) > 0 && strings.HasSuffix(trimmed, ":") {
			head := strings.TrimSuffix(trimmed, ":")
			if head == strings.ToUpper(head) && len(head) <= 40 {
				break
			}
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

func DelegatedStatus(planner, executor string) string {
	return fmt.Sprintf("delegated planner=%s executor=%s", planner, executor)
}
