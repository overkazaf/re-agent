// /goal — turn an objective into a checkable task declaration.
//
// The flow keeps the human in the one place the article puts them: task
// modeling. /goal <text> asks the model to structure the objective into a
// strict JSON draft; the host hashes and identifies the target file itself
// (the model never fills the hash); the operator reviews with /goal show and
// arms it with /goal accept. Only then does the declaration enter the system
// prompt and the writeup gate.
package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/goal"
	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/util"
)

// goalDraftSystemPrompt is the declaration contract: one JSON block, gates
// the host can actually check.
const goalDraftSystemPrompt = `You draft reverse-engineering task declarations. The operator gives you a raw objective; answer with ONE fenced json block and nothing else — no prose before or after. The host parses the block, hashes the target file, and turns the acceptance list into hard gates that block delivery.

Schema:
` + "```" + `json
{
  "target_file": "<file path inside the workspace, taken from the objective>",
  "target_scope": "<what is in scope; name what is explicitly out>",
  "primary": "<snake_case objective: recover_x | reproduce_x | extract_x | verify_x>",
  "intent": "<one line: what done means in checkable terms>",
  "deliverables": ["<artifact the operator receives>"],
  "constraints": {"network": "deny", "filesystem": "workspace-only", "device": "none"},
  "acceptance": [
    {"kind": "build_pass"},
    {"kind": "replay_pass", "op": ">=", "value": 0.95},
    {"kind": "differential_cases", "op": ">=", "value": 2}
  ]
}
` + "```" + `

Rules:
- acceptance kinds are exactly: build_pass, replay_pass, differential_cases, evidence_count, audit_finding; no duplicates; ops are >= (default), == or >.
- replay_pass is a 0..1 pass ratio over recorded replay cases; differential_cases is the number of distinct fixed inputs replayed; evidence_count is evidence records filed; audit_finding is audit records filed.
- Prefer fewer, sharper gates: 2-4 criteria fit most objectives. Every gate must be checkable from tool evidence, never from the model's own summary.
- If the objective is too vague to gate, still emit the JSON with the closest concrete reading; the operator reviews before accepting.`

// handleGoalCommand routes the /goal subcommands.
func handleGoalCommand(arg string, state *State) error {
	sub, _ := splitFirstWord(arg)
	switch sub {
	case "", "show":
		return showGoal(state)
	case "accept":
		return acceptGoal(state)
	case "clear":
		return clearGoal(state)
	default:
		return draftGoal(strings.TrimSpace(arg), state)
	}
}

func splitFirstWord(line string) (string, string) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return "", ""
	}
	parts := strings.SplitN(trimmed, " ", 2)
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.TrimSpace(parts[1])
}

// draftGoal runs the declaration turn and enriches it with host-side target
// intake: resolve the file inside the workspace, hash it, sniff format/arch.
// The model drafts the shape; the host states the facts.
func draftGoal(objective string, state *State) error {
	if objective == "" {
		return fmt.Errorf("usage: /goal <objective> (or /goal show | accept | clear)")
	}
	fmt.Println(ui.RenderNotice("drafting the task declaration…"))
	result, err := state.Loop.Run(objective, core.RunOptions{
		Isolated: true, FreshSession: true,
		SystemPrompt: goalDraftSystemPrompt,
		Tools:        []types.Tool{},
		Ctx:          context.Background(),
	})
	if err != nil {
		return err
	}
	reply := lastAssistantText(result.Messages)
	draft, err := goal.ParseDraft(reply)
	if err != nil {
		return fmt.Errorf("the draft could not be parsed: %w\nreply began with: %s", err, truncateFor(reply))
	}

	declaration := &goal.Declaration{
		RawGoal: objective,
		Target:  goal.Target{File: draft.TargetFile, Scope: draft.TargetScope},
		Objective: goal.Objective{
			Primary:      draft.Primary,
			Intent:       draft.Intent,
			Deliverables: draft.Deliverables,
			Constraints:  draft.Constraints,
			Acceptance:   draft.Acceptance,
		},
	}
	path, resolveErr := util.ResolveInside(state.ToolContext.Workspace, draft.TargetFile)
	if resolveErr != nil {
		fmt.Println(ui.RenderNotice(fmt.Sprintf(
			"target %q does not resolve inside the workspace — accepted declarations need a real file; draft kept for review", draft.TargetFile)))
	} else {
		declaration.Target.SHA256 = tools.FileSHA256(path)
		format, arch, sniffErr := goal.Sniff(path)
		if sniffErr == nil {
			declaration.Target.Format = format
			declaration.Target.Arch = arch
		}
	}

	state.GoalDraft = declaration
	fmt.Println(renderDeclaration(declaration, "draft — review, then /goal accept (or /goal <new objective> to redraft)"))
	return nil
}

// acceptGoal arms the declaration: system prompt, session event, and the
// writeup acceptance gate.
func acceptGoal(state *State) error {
	if state.GoalDraft == nil {
		if state.Loop.Goal() != nil {
			fmt.Println(ui.RenderNotice("a declaration is already active — /goal show, or /goal clear first"))
			return nil
		}
		return fmt.Errorf("no draft to accept — start one with /goal <objective>")
	}
	declaration := state.GoalDraft
	declaration.Accepted = true
	declaration.CreatedAt = time.Now().UnixMilli()
	state.GoalDraft = nil
	state.Loop.SetGoal(declaration)
	attachAcceptanceGate(state)
	// The declaration's constraints become the task's capability scope:
	// network and device access are deny-by-default unless the contract
	// grants them.
	if state.Sandbox != nil {
		state.Sandbox.Activate(declaration.Objective.Constraints)
	}
	fmt.Println(renderDeclaration(declaration, "accepted — the contract now rides every prompt; writeup checks the acceptance list"))
	fmt.Println(renderSandbox(state.Sandbox))
	return nil
}

func clearGoal(state *State) error {
	if state.Loop.Goal() == nil && state.GoalDraft == nil {
		fmt.Println(ui.RenderNotice("no goal declaration active"))
		return nil
	}
	state.GoalDraft = nil
	state.Loop.SetGoal(nil)
	if state.REState != nil {
		state.REState.Acceptance = nil
	}
	// Capabilities are task-scoped: clearing the task expires them.
	if state.Sandbox != nil {
		state.Sandbox.Deactivate()
	}
	fmt.Println(ui.RenderNotice("goal declaration cleared"))
	return nil
}

func showGoal(state *State) error {
	if declaration := state.Loop.Goal(); declaration != nil {
		fmt.Println(renderDeclaration(declaration, "active"))
		report := state.Loop.GoalReport()
		if len(report.Statuses) > 0 {
			fmt.Println("acceptance:")
			for _, status := range report.Statuses {
				fmt.Println("  " + status.Describe())
			}
			if report.AllPass() {
				fmt.Println(ui.RenderNotice("all acceptance criteria hold"))
			}
		}
		return nil
	}
	if state.GoalDraft != nil {
		fmt.Println(renderDeclaration(state.GoalDraft, "draft — not armed; /goal accept to activate"))
		return nil
	}
	fmt.Println(ui.RenderNotice("no goal declaration yet — /goal <objective> drafts one from your words"))
	return nil
}

// attachAcceptanceGate wires the writeup gate to the active declaration, so
// advancing into writeup re-checks the acceptance list against the ledger.
// Called on /goal accept and when a reverse workflow starts under an active
// declaration.
func attachAcceptanceGate(state *State) {
	if state.REState == nil {
		return
	}
	state.REState.Acceptance = func() []string {
		declaration := state.Loop.Goal()
		if declaration == nil || !declaration.Accepted {
			return nil
		}
		return state.Loop.GoalReport().Pending()
	}
}

func renderDeclaration(declaration *goal.Declaration, status string) string {
	var lines []string
	lines = append(lines, ui.RenderNotice("goal declaration — "+status))
	lines = append(lines, "  objective: "+declaration.Objective.Primary)
	if declaration.Objective.Intent != "" {
		lines = append(lines, "  done means: "+declaration.Objective.Intent)
	}
	target := "  target: " + declaration.Target.File
	if declaration.Target.SHA256 != "" {
		target += " (sha256 " + declaration.Target.SHA256[:min(12, len(declaration.Target.SHA256))] + "…"
		bits := []string{}
		if declaration.Target.Format != "" {
			bits = append(bits, declaration.Target.Format)
		}
		if declaration.Target.Arch != "" {
			bits = append(bits, declaration.Target.Arch)
		}
		if len(bits) > 0 {
			target += ", " + strings.Join(bits, "/")
		}
		target += ")"
	}
	lines = append(lines, target)
	if declaration.Target.Scope != "" {
		lines = append(lines, "  scope: "+declaration.Target.Scope)
	}
	if len(declaration.Objective.Deliverables) > 0 {
		lines = append(lines, "  deliverables: "+strings.Join(declaration.Objective.Deliverables, ", "))
	}
	for key, value := range declaration.Objective.Constraints {
		lines = append(lines, fmt.Sprintf("  constraint %s: %s", key, value))
	}
	if len(declaration.Objective.Acceptance) > 0 {
		lines = append(lines, "  acceptance:")
		for _, criterion := range declaration.Objective.Acceptance {
			lines = append(lines, "    - "+criterion.Describe())
		}
	}
	return strings.Join(lines, "\n")
}

func truncateFor(text string) string {
	flat := strings.ReplaceAll(strings.TrimSpace(text), "\n", " ")
	if len(flat) > 200 {
		flat = flat[:200] + "…"
	}
	if flat == "" {
		flat = "<empty reply>"
	}
	return flat
}
