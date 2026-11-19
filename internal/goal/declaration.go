// Package goal turns a natural-language objective into a scoped task
// declaration the host can check: what sample, what deliverables, what
// constraints, and — the part that matters — which acceptance criteria must
// pass before anything is called done. The model drafts the declaration in a
// strict JSON contract; the host fills in the target's hash and format,
// evaluates the criteria against the evidence ledger, and blocks the writeup
// phase until they hold.
//
// The declaration is deliberately separate from the REState phase list:
// phases say where the analysis is, the declaration says what "done" means.
// Nothing here trusts the model to grade itself — every criterion reads
// records the loop already filed.
package goal

import (
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/overkazaf/re-agent/internal/evidence"
	"github.com/overkazaf/re-agent/internal/types"
)

// CriterionKind names what a criterion checks. The first three mirror the
// article's example gates (build_pass, replay_pass >= 0.95,
// differential_cases_recorded); the rest read the ledger directly.
const (
	KindBuildPass         = "build_pass"
	KindReplayPass        = "replay_pass"
	KindDifferentialCases = "differential_cases"
	KindEvidenceCount     = "evidence_count"
	KindAuditFinding      = "audit_finding"
)

// ValidCriterionKind reports whether kind is one the evaluator can check.
func ValidCriterionKind(kind string) bool {
	switch kind {
	case KindBuildPass, KindReplayPass, KindDifferentialCases,
		KindEvidenceCount, KindAuditFinding:
		return true
	}
	return false
}

// CriterionKinds lists the checkable kinds, for prompts and help text.
func CriterionKinds() []string {
	return []string{KindBuildPass, KindReplayPass, KindDifferentialCases, KindEvidenceCount, KindAuditFinding}
}

// Criterion is one acceptance gate. Value's meaning depends on Kind:
// replay_pass is a 0..1 ratio; the counts are integers; build_pass ignores it.
type Criterion struct {
	Kind  string  `json:"kind"`
	Op    string  `json:"op,omitempty"` // >= (default) | == | >
	Value float64 `json:"value,omitempty"`
	Note  string  `json:"note,omitempty"` // why this gate exists, shown in reports
}

// Describe renders the criterion for prompts and reports.
func (c Criterion) Describe() string {
	text := c.Kind
	switch {
	case c.Op != "" && c.Value != 0:
		text += fmt.Sprintf(" %s %s", c.Op, formatNumber(c.Value))
	case c.Value != 0:
		text += fmt.Sprintf(" >= %s", formatNumber(c.Value))
	}
	if c.Note != "" {
		text += " — " + c.Note
	}
	return text
}

func formatNumber(value float64) string {
	if value == float64(int(value)) {
		return fmt.Sprintf("%d", int(value))
	}
	return fmt.Sprintf("%.2f", value)
}

// Target is the Target State: which sample, which version, proven by hash.
// It is filled by the host (never the model) so a declaration cannot claim a
// file it did not hash.
type Target struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256,omitempty"`
	Format string `json:"format,omitempty"`
	Arch   string `json:"arch,omitempty"`
	Scope  string `json:"scope,omitempty"`
}

// Objective is the Objective State: what this run must prove and produce,
// kept apart from the target so the same sample can back different goals
// without the agent quietly trading "reproduce behavior" for "find a
// key-looking constant".
type Objective struct {
	Primary      string            `json:"primary"`
	Intent       string            `json:"intent,omitempty"`
	Deliverables []string          `json:"deliverables,omitempty"`
	Constraints  map[string]string `json:"constraints,omitempty"`
	Acceptance   []Criterion       `json:"acceptance"`
}

// Declaration is the whole task contract. Accepted flips only by operator
// action (/goal accept), not by the model.
type Declaration struct {
	RawGoal   string    `json:"rawGoal"`
	Target    Target    `json:"target"`
	Objective Objective `json:"objective"`
	Accepted  bool      `json:"accepted"`
	CreatedAt int64     `json:"createdAt,omitempty"`
}

// Draft is the JSON contract the model answers a /goal request with. It
// carries no hash: the host resolves and hashes target_file itself.
type Draft struct {
	TargetFile   string            `json:"target_file"`
	TargetScope  string            `json:"target_scope,omitempty"`
	Primary      string            `json:"primary"`
	Intent       string            `json:"intent,omitempty"`
	Deliverables []string          `json:"deliverables,omitempty"`
	Constraints  map[string]string `json:"constraints,omitempty"`
	Acceptance   []Criterion       `json:"acceptance"`
}

// ParseDraft pulls the first fenced ```json block (or, failing that, the
// first bare top-level object) out of a model reply and validates it. Kind
// names and ops are checked here so a hallucinated gate fails at draft time,
// not at writeup time.
func ParseDraft(raw string) (Draft, error) {
	var draft Draft
	body := extractJSON(raw)
	if body == "" {
		return draft, fmt.Errorf("no JSON declaration found in the draft reply")
	}
	if err := json.Unmarshal([]byte(body), &draft); err != nil {
		return draft, fmt.Errorf("declaration is not valid JSON: %w", err)
	}
	draft.Primary = strings.TrimSpace(draft.Primary)
	if draft.Primary == "" {
		return draft, fmt.Errorf(`declaration is missing "primary"`)
	}
	draft.TargetFile = strings.TrimSpace(draft.TargetFile)
	if draft.TargetFile == "" {
		return draft, fmt.Errorf(`declaration is missing "target_file"`)
	}
	seen := map[string]bool{}
	for i, criterion := range draft.Acceptance {
		if !ValidCriterionKind(criterion.Kind) {
			return draft, fmt.Errorf("acceptance[%d]: unknown kind %q (valid: %s)",
				i, criterion.Kind, strings.Join(CriterionKinds(), ", "))
		}
		if seen[criterion.Kind] {
			return draft, fmt.Errorf("acceptance[%d]: duplicate kind %q", i, criterion.Kind)
		}
		seen[criterion.Kind] = true
		switch criterion.Op {
		case "", ">=", "==", ">":
		default:
			return draft, fmt.Errorf("acceptance[%d]: op %q must be >=, == or >", i, criterion.Op)
		}
		if criterion.Kind == KindReplayPass && (criterion.Value < 0 || criterion.Value > 1) {
			return draft, fmt.Errorf("acceptance[%d]: replay_pass value must be a 0..1 ratio", i)
		}
	}
	return draft, nil
}

// extractJSON returns the first fenced json block, else the outermost {...}
// span of the reply.
func extractJSON(raw string) string {
	parts := strings.Split(raw, "```")
	for i := 1; i < len(parts); i += 2 {
		block := strings.TrimSpace(parts[i])
		block = strings.TrimSpace(strings.TrimPrefix(block, "json"))
		if strings.HasPrefix(block, "{") {
			return block
		}
	}
	start := strings.Index(raw, "{")
	if start < 0 {
		return ""
	}
	end := strings.LastIndex(raw, "}")
	if end <= start {
		return ""
	}
	return strings.TrimSpace(raw[start : end+1])
}

// CriterionStatus is one gate's verdict against the ledger, with the evidence
// line that justified it.
type CriterionStatus struct {
	Criterion Criterion
	Pass      bool
	Detail    string
}

// Describe renders status + criterion, e.g.
//
//	fail replay_pass >= 0.95 — best run 3/4 (0.75), ev_006
func (s CriterionStatus) Describe() string {
	state := "pass"
	if !s.Pass {
		state = "fail"
	}
	text := state + " " + s.Criterion.Describe()
	if s.Detail != "" {
		text += " (" + s.Detail + ")"
	}
	return text
}

// Report is the acceptance state of a declaration against the evidence.
type Report struct {
	Statuses []CriterionStatus
}

// AllPass reports whether every criterion holds.
func (r Report) AllPass() bool {
	for _, status := range r.Statuses {
		if !status.Pass {
			return false
		}
	}
	return true
}

// Pending lists the unmet criteria, for the writeup gate.
func (r Report) Pending() []string {
	var pending []string
	for _, status := range r.Statuses {
		if !status.Pass {
			pending = append(pending, status.Criterion.Describe())
		}
	}
	return pending
}

// Evaluate checks every criterion against the ledger records. Verification
// numbers come only from verification_result records carrying stats — the
// same records the audit phase gate already trusts.
func Evaluate(declaration *Declaration, records []types.EvidenceRecord) Report {
	var report Report
	if declaration == nil {
		return report
	}
	var runs []types.VerificationStats
	auditFindings, evidenceCount := 0, 0
	for _, record := range records {
		evidenceCount++
		if record.Kind == string(evidence.KindVerification) && record.Verification != nil {
			runs = append(runs, *record.Verification)
		}
		if record.Kind == string(evidence.KindAuditFinding) {
			auditFindings++
		}
	}
	for _, criterion := range declaration.Objective.Acceptance {
		report.Statuses = append(report.Statuses, checkCriterion(criterion, runs, auditFindings, evidenceCount))
	}
	return report
}

func checkCriterion(criterion Criterion, runs []types.VerificationStats, auditFindings, evidenceCount int) CriterionStatus {
	status := CriterionStatus{Criterion: criterion}
	switch criterion.Kind {
	case KindBuildPass:
		for _, run := range runs {
			if run.Build {
				status.Pass = true
				status.Detail = "build ok, " + run.ID
				return status
			}
		}
		status.Detail = "no successful build recorded"
	case KindReplayPass:
		best, ratio := bestReplay(runs)
		if best == nil {
			status.Detail = "no replay runs recorded"
			return status
		}
		status.Detail = fmt.Sprintf("best run %d/%d (%s), %s", best.Passed, best.Total, formatNumber(ratio), best.ID)
		status.Pass = compare(ratio, criterion)
	case KindDifferentialCases:
		widest := 0
		widestID := ""
		for _, run := range runs {
			if run.Total > widest {
				widest = run.Total
				widestID = run.ID
			}
		}
		if widest == 0 {
			status.Detail = "no verification runs recorded"
			return status
		}
		status.Detail = fmt.Sprintf("widest run has %d cases, %s", widest, widestID)
		status.Pass = compare(float64(widest), criterion)
	case KindEvidenceCount:
		status.Detail = fmt.Sprintf("%d records", evidenceCount)
		status.Pass = compare(float64(evidenceCount), criterion)
	case KindAuditFinding:
		status.Detail = fmt.Sprintf("%d audit findings", auditFindings)
		status.Pass = compare(float64(auditFindings), criterion)
	}
	return status
}

func bestReplay(runs []types.VerificationStats) (*types.VerificationStats, float64) {
	bestRatio := -1.0
	var best *types.VerificationStats
	for i, run := range runs {
		if run.Total <= 0 {
			continue
		}
		ratio := float64(run.Passed) / float64(run.Total)
		if ratio > bestRatio {
			bestRatio = ratio
			best = &runs[i]
		}
	}
	return best, bestRatio
}

func compare(actual float64, criterion Criterion) bool {
	op := criterion.Op
	if op == "" {
		op = ">="
	}
	switch op {
	case ">=":
		return actual >= criterion.Value
	case ">":
		return actual > criterion.Value
	case "==":
		return actual == criterion.Value
	}
	return false
}

// Sniff identifies a sample's format and architecture from its leading
// bytes. It is a triage label, not a parser: enough to pin "which sample,
// which arch" in the declaration, with the hash carrying the real identity.
func Sniff(path string) (format, arch string, err error) {
	header := make([]byte, 64)
	handle, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	n, err := handle.Read(header)
	handle.Close()
	if err != nil && n == 0 {
		return "", "", err
	}
	header = header[:n]
	switch {
	case len(header) >= 4 && string(header[:4]) == "\x7fELF":
		format = "ELF"
		if f, elfErr := elf.Open(path); elfErr == nil {
			defer f.Close()
			bits := ""
			switch f.Class {
			case elf.ELFCLASS32:
				bits = "-32bit"
			case elf.ELFCLASS64:
				bits = "-64bit"
			}
			arch = strings.TrimPrefix(f.Machine.String(), "EM_") + bits
		}
	case len(header) >= 2 && string(header[:2]) == "MZ":
		format = "PE"
		if f, peErr := pe.Open(path); peErr == nil {
			defer f.Close()
			switch f.Machine {
			case 0x14c:
				arch = "x86"
			case 0x8664:
				arch = "x86_64"
			case 0xaa64:
				arch = "arm64"
			case 0x1c0, 0x1c4:
				arch = "arm"
			}
		}
	case len(header) >= 4 && (string(header[:4]) == "\xcf\xfa\xed\xfe" || string(header[:4]) == "\xce\xfa\xed\xfe" || string(header[:4]) == "\xfe\xed\xfa\xcf" || string(header[:4]) == "\xfe\xed\xfa\xce" || string(header[:4]) == "\xca\xfe\xba\xbe"):
		if fat, fatErr := macho.OpenFat(path); fatErr == nil {
			defer fat.Close()
			format = "Mach-O"
			var cpus []string
			for _, a := range fat.Arches {
				cpus = append(cpus, a.Cpu.String())
			}
			arch = strings.Join(cpus, "+")
		} else if mf, mErr := macho.Open(path); mErr == nil {
			defer mf.Close()
			format = "Mach-O"
			arch = mf.Cpu.String()
		} else {
			format = "data"
		}
	case len(header) >= 4 && string(header[:4]) == "\x00asm":
		format = "WASM"
		arch = "wasm32"
	case len(header) >= 4 && string(header[:4]) == "dex\n":
		format = "DEX"
		arch = "dalvik"
	case len(header) >= 4 && string(header[:4]) == "PK\x03\x04":
		format = "ZIP/APK"
	default:
		format = "data"
	}
	return format, arch, nil
}
