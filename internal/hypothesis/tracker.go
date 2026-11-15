// Package hypothesis keeps the explicit assumption stack an analysis reasons
// with. Claims arrive from the model through the hypothesis_* tools, but the
// mutation rules live here, in the host: contradicting evidence halves
// confidence, and when a claim falls, everything that depends on it is
// cascade-marked for re-examination instead of quietly riding on a broken
// narrative.
package hypothesis

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

const (
	maxClaims     = 64
	maxClaimChars = 500
	// dropBelow is where a twice-contradicted claim stops being "current best
	// understanding" and becomes "needs re-examination" in its own right.
	dropBelow = 0.25
)

// Tracker is mutex-guarded state, mirroring plan.Tracker: the model mutates it
// only through the tools, the loop persists whole-stack snapshots, and restored
// sessions seed it back via Load.
type Tracker struct {
	mu         sync.Mutex
	next       int
	byID       map[string]*types.Hypothesis
	superseded bool
}

func New() *Tracker {
	return &Tracker{byID: map[string]*types.Hypothesis{}}
}

func (t *Tracker) Create(claim string, confidence float64, evidence []string, dependsOn []string) (types.Hypothesis, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	cleaned := cleanClaim(claim)
	if cleaned == "" {
		return types.Hypothesis{}, fmt.Errorf("hypothesis claim must not be empty")
	}
	if t.countLocked() >= maxClaims {
		return types.Hypothesis{}, fmt.Errorf("hypothesis stack is full (%d); reject or revise before adding more", maxClaims)
	}
	for _, dep := range dependsOn {
		if _, ok := t.byID[normalizeID(dep)]; !ok {
			return types.Hypothesis{}, fmt.Errorf("dependsOn references unknown hypothesis %s", dep)
		}
	}
	t.next++
	id := fmt.Sprintf("H-%03d", t.next)
	now := types.NowMs()
	hyp := &types.Hypothesis{
		ID:         id,
		Claim:      cleaned,
		Confidence: clamp(confidence),
		Supporting: dedupe(evidence),
		DependsOn:  normalizeIDs(dependsOn),
		Status:     types.HypActive,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	t.byID[id] = hyp
	t.backlink(hyp)
	return *hyp, nil
}

func (t *Tracker) Get(id string) (types.Hypothesis, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	hyp, err := t.locked(id)
	if err != nil {
		return types.Hypothesis{}, false
	}
	return *hyp, true
}

func (t *Tracker) List() []types.Hypothesis {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]types.Hypothesis, 0, len(t.byID))
	for _, hyp := range t.byID {
		out = append(out, *hyp)
	}
	sortHypotheses(out)
	return out
}

// --- locked helpers (callers hold t.mu) ---------------------------------------

func (t *Tracker) locked(id string) (*types.Hypothesis, error) {
	hyp, ok := t.byID[normalizeID(id)]
	if !ok {
		return nil, fmt.Errorf("unknown hypothesis %s", id)
	}
	return hyp, nil
}

func (t *Tracker) countLocked() int { return len(t.byID) }

func (t *Tracker) Support(id, evidenceID string) (types.Hypothesis, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	hyp, err := t.locked(id)
	if err != nil {
		return types.Hypothesis{}, err
	}
	if !contains(hyp.Supporting, evidenceID) {
		hyp.Supporting = append(hyp.Supporting, evidenceID)
		hyp.UpdatedAt = types.NowMs()
	}
	return *hyp, nil
}

// Challenge records contradicting evidence and halves confidence — the host's
// deterministic answer to narrative fixation: the model does not get to keep
// its confidence after evidence that contradicts it.
func (t *Tracker) Challenge(id, evidenceID, note string) (types.Hypothesis, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	hyp, err := t.locked(id)
	if err != nil {
		return types.Hypothesis{}, err
	}
	if contains(hyp.Contradicting, evidenceID) {
		// The same evidence argued twice must not keep degrading the claim.
		return *hyp, nil
	}
	hyp.Contradicting = append(hyp.Contradicting, evidenceID)
	hyp.Confidence = clamp(hyp.Confidence * 0.5)
	hyp.Note = strings.TrimSpace(util.Truncate(note, 200))
	hyp.UpdatedAt = types.NowMs()
	if hyp.Confidence < dropBelow && hyp.Status == types.HypActive {
		hyp.Status = types.HypReevaluate
		t.cascadeLocked(hyp.ID)
	}
	return *hyp, nil
}

// Revise replaces the claim text. Dependents were derived from the *old*
// claim, so they are marked for re-examination.
func (t *Tracker) Revise(id, claim, note string) (types.Hypothesis, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	hyp, err := t.locked(id)
	if err != nil {
		return types.Hypothesis{}, err
	}
	cleaned := cleanClaim(claim)
	if cleaned == "" {
		return types.Hypothesis{}, fmt.Errorf("revised claim must not be empty")
	}
	hyp.Claim = cleaned
	hyp.Status = types.HypRevised
	hyp.Note = strings.TrimSpace(util.Truncate(note, 200))
	hyp.UpdatedAt = types.NowMs()
	t.cascadeLocked(hyp.ID)
	return *hyp, nil
}

func (t *Tracker) Reject(id, note string) (types.Hypothesis, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	hyp, err := t.locked(id)
	if err != nil {
		return types.Hypothesis{}, err
	}
	hyp.Status = types.HypRejected
	hyp.Note = strings.TrimSpace(util.Truncate(note, 200))
	hyp.UpdatedAt = types.NowMs()
	t.cascadeLocked(hyp.ID)
	return *hyp, nil
}

// Load seeds a restored session; ids are trusted here because they were
// assigned by this tracker earlier in the session's life.
func (t *Tracker) Load(hypotheses []types.Hypothesis) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.byID = map[string]*types.Hypothesis{}
	t.next = 0
	for i := range hypotheses {
		hyp := hypotheses[i]
		t.byID[hyp.ID] = &hyp
		if n := parseIDNumber(hyp.ID); n > t.next {
			t.next = n
		}
	}
}

// Reset clears the stack for a fresh session or task.
func (t *Tracker) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.byID = map[string]*types.Hypothesis{}
	t.next = 0
}

// cascadeLocked marks every active hypothesis transitively derived from id as
// reevaluate — one message to the planner: the ground moved under you.
func (t *Tracker) cascadeLocked(id string) {
	queue := []string{id}
	seen := map[string]bool{id: true}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		parent, ok := t.byID[current]
		if !ok {
			continue
		}
		for _, childID := range parent.Derived {
			if seen[childID] {
				continue
			}
			seen[childID] = true
			if child, ok := t.byID[childID]; ok && child.Status == types.HypActive {
				child.Status = types.HypReevaluate
				child.UpdatedAt = types.NowMs()
			}
			queue = append(queue, childID)
		}
	}
}

func (t *Tracker) backlink(hyp *types.Hypothesis) {
	for _, parentID := range hyp.DependsOn {
		if parent, ok := t.byID[parentID]; ok {
			if !contains(parent.Derived, hyp.ID) {
				parent.Derived = append(parent.Derived, hyp.ID)
			}
		}
	}
}

// --- helpers -------------------------------------------------------------------

func cleanClaim(claim string) string {
	flat := stripANSI(claim)
	flat = controlRE.ReplaceAllString(flat, " ")
	flat = strings.TrimSpace(collapseSpaces(flat))
	return util.Truncate(flat, maxClaimChars)
}

func clamp(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func dedupe(values []string) []string {
	var out []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || contains(out, value) {
			continue
		}
		out = append(out, value)
	}
	return out
}

func normalizeIDs(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := normalizeID(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func normalizeID(id string) string { return strings.ToUpper(strings.TrimSpace(id)) }

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func parseIDNumber(id string) int {
	var n int
	if _, err := fmt.Sscanf(id, "H-%d", &n); err != nil {
		return 0
	}
	return n
}

// sortHypotheses orders by id for stable rendering and persistence.
func sortHypotheses(hypotheses []types.Hypothesis) {
	for i := 1; i < len(hypotheses); i++ {
		for j := i; j > 0 && parseIDNumber(hypotheses[j].ID) < parseIDNumber(hypotheses[j-1].ID); j-- {
			hypotheses[j], hypotheses[j-1] = hypotheses[j-1], hypotheses[j]
		}
	}
}

var (
	ansiRE       = regexp.MustCompile("\x1b\\[[0-9;]*m")
	controlRE    = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
	spacesRegexp = regexp.MustCompile(`\s+`)
)

func stripANSI(value string) string      { return ansiRE.ReplaceAllString(value, "") }
func collapseSpaces(value string) string { return spacesRegexp.ReplaceAllString(value, " ") }
