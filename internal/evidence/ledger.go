// Package evidence keeps the ledger of referenceable tool outputs. Every tool
// result the loop records lands here as an ev_NNN record with its provenance,
// so hypotheses can cite evidence by id and a later auditor can check a claim
// against what the tools actually returned — not what the model remembers.
package evidence

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// excerptChars is how much of an output a record keeps. The full text stays in
// the transcript and in spilled artifacts; the excerpt only has to be enough
// to recognize the record by.
const excerptChars = 400

type Input struct {
	Source     string // tool name, or "operator"
	Kind       string // free-form tag: static / dynamic / derived
	Text       string // the raw output the record attests to
	IsError    bool
	ToolCallID string
}

// Ledger is mutex-guarded, mirroring plan.Tracker and hypothesis.Tracker: the
// loop owns one, persists each record as a session event, and seeds it back on
// resume via Load.
type Ledger struct {
	mu      sync.Mutex
	next    int
	records []types.EvidenceRecord
	byID    map[string]bool
}

func New() *Ledger {
	return &Ledger{byID: map[string]bool{}}
}

// Add records one piece of evidence. It never fails: a record with a clipped
// excerpt beats losing provenance because an output looked odd.
func (l *Ledger) Add(input Input) types.EvidenceRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.next++
	record := types.EvidenceRecord{
		ID:         fmt.Sprintf("ev_%03d", l.next),
		Source:     strings.TrimSpace(input.Source),
		Kind:       strings.TrimSpace(input.Kind),
		Excerpt:    util.Truncate(sanitize(input.Text), excerptChars),
		IsError:    input.IsError,
		ToolCallID: input.ToolCallID,
		Bytes:      len(input.Text),
		CreatedAt:  types.NowMs(),
	}
	l.records = append(l.records, record)
	l.byID[record.ID] = true
	return record
}

func (l *Ledger) Get(id string) (types.EvidenceRecord, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, record := range l.records {
		if record.ID == id {
			return record, true
		}
	}
	return types.EvidenceRecord{}, false
}

func (l *Ledger) List() []types.EvidenceRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]types.EvidenceRecord{}, l.records...)
}

// Digest renders the most recent records, one line each, for prompt injection.
// Older records stay in the session file; the digest notes what it dropped so
// a truncated view never looks complete.
func (l *Ledger) Digest(max int) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.records) == 0 || max <= 0 {
		return ""
	}
	start := 0
	var lines []string
	if len(l.records) > max {
		start = len(l.records) - max
		lines = append(lines, fmt.Sprintf("… %d earlier records not shown", start))
	}
	for _, record := range l.records[start:] {
		flag := ""
		if record.IsError {
			flag = " (error)"
		}
		kind := record.Kind
		if kind != "" {
			kind = " " + kind
		}
		lines = append(lines, fmt.Sprintf("%s [%s%s]%s %s",
			record.ID, record.Source, kind, flag, record.Excerpt))
	}
	return strings.Join(lines, "\n")
}

// Load seeds a restored session and continues numbering past the highest id.
func (l *Ledger) Load(records []types.EvidenceRecord) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.records = append([]types.EvidenceRecord{}, records...)
	l.byID = map[string]bool{}
	for _, record := range l.records {
		l.byID[record.ID] = true
		if n := parseIDNumber(record.ID); n > l.next {
			l.next = n
		}
	}
}

// Reset clears the ledger for a fresh session or task.
func (l *Ledger) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.records = nil
	l.byID = map[string]bool{}
	l.next = 0
}

func sanitize(text string) string {
	flat := ansiRE.ReplaceAllString(text, "")
	return controlRE.ReplaceAllString(flat, " ")
}

func parseIDNumber(id string) int {
	var n int
	if _, err := fmt.Sscanf(id, "ev_%d", &n); err != nil {
		return 0
	}
	return n
}

var (
	ansiRE    = regexp.MustCompile("\x1b\\[[0-9;]*m")
	controlRE = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
)
