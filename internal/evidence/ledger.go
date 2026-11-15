// Package evidence keeps the ledger of referenceable tool outputs — the
// provenance layer the hypothesis stack cites and the adversarial auditor
// re-reads. Every tool result the loop records lands here as an ev_NNN record
// with its source, view, and excerpt.
//
// The ledger has two persistence streams that meet again on resume: records
// append to evidence-ledger.jsonl next to the session when the ledger was
// opened via Open (the durable, append-only archive — Reset never rewrites
// it), and the loop mirrors each record into the session event stream so a
// resumed run rebuilds the live view without replaying the transcript.
//
// Kind is the record class the reverse-workflow phase gates count
// (tool_observation, runtime_trace, verification_result, audit_finding, …).
// View separates static reads from dynamic runs so the arbitrator can pair a
// claim against the other view.
package evidence

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

type Kind string

const (
	KindToolObservation Kind = "tool_observation"
	KindArtifact        Kind = "artifact"
	KindRuntimeTrace    Kind = "runtime_trace"
	KindModelClaim      Kind = "model_claim"
	KindOperatorInput   Kind = "operator_input"
	KindExternalRef     Kind = "external_reference"
	KindVerification    Kind = "verification_result"
	KindAuditFinding    Kind = "audit_finding"
)

// Views pair static claims with dynamic observations.
const (
	ViewStatic  = "static"
	ViewDynamic = "dynamic"
)

// EvidenceRecord is the shared record type; the alias keeps older call sites
// that predate the move into types.
type EvidenceRecord = types.EvidenceRecord

// excerptChars is how much of an output a record keeps. The full text stays in
// the transcript and in spilled artifacts; the excerpt only has to be enough
// to recognize the record by.
const excerptChars = 400

type Input struct {
	Source     string // tool name, or "operator" / "arbitrator" / "audit"
	Kind       string // record class; defaults to tool_observation
	View       string // static | dynamic | ""
	Text       string // the raw output the record attests to
	IsError    bool
	ToolCallID string
	Artifact   string
	SHA256     string
}

type HypothesisStatus string

const (
	HypothesisOpen      HypothesisStatus = "open"
	HypothesisSupported HypothesisStatus = "supported"
	HypothesisWeakened  HypothesisStatus = "weakened"
	HypothesisRejected  HypothesisStatus = "rejected"
	HypothesisRetired   HypothesisStatus = "retired"
	HypothesisVerified  HypothesisStatus = "verified"
)

func ValidHypothesisStatus(value string) bool {
	switch HypothesisStatus(value) {
	case HypothesisOpen, HypothesisSupported, HypothesisWeakened,
		HypothesisRejected, HypothesisRetired, HypothesisVerified:
		return true
	}
	return false
}

type HypothesisRevision struct {
	Status     HypothesisStatus `json:"status"`
	Note       string           `json:"note,omitempty"`
	EvidenceID string           `json:"evidenceId,omitempty"`
	Relation   string           `json:"relation,omitempty"`
	At         int64            `json:"at"`
}

type HypothesisRecord struct {
	ID          string               `json:"id"`
	Text        string               `json:"text"`
	Status      HypothesisStatus     `json:"status"`
	Supports    []string             `json:"supports,omitempty"`
	Contradicts []string             `json:"contradicts,omitempty"`
	Revisions   []HypothesisRevision `json:"revisions"`
	CreatedAt   int64                `json:"createdAt"`
	UpdatedAt   int64                `json:"updatedAt"`
}

// fileEvent is the JSONL envelope of the durable archive.
type fileEvent struct {
	Type string          `json:"type"`
	At   int64           `json:"at"`
	Data json.RawMessage `json:"data"`
}

// Ledger is mutex-guarded, mirroring plan.Tracker and hypothesis.Tracker: the
// loop owns one, every record also lands in evidence-ledger.jsonl when a file
// is attached, and restored sessions seed it back via Load.
type Ledger struct {
	mu      sync.Mutex
	file    string
	next    int
	records []types.EvidenceRecord
	byID    map[string]bool

	hypotheses      map[string]HypothesisRecord
	hypothesisOrder []string
	nextHypothesis  int
}

func New() *Ledger {
	return &Ledger{byID: map[string]bool{}, hypotheses: map[string]HypothesisRecord{}}
}

// Open attaches the durable JSONL archive in sessionDir and replays it.
func Open(sessionDir string) (*Ledger, error) {
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		return nil, err
	}
	ledger := New()
	ledger.file = filepath.Join(sessionDir, "evidence-ledger.jsonl")
	if err := ledger.loadFile(); err != nil {
		return nil, err
	}
	return ledger, nil
}

func (l *Ledger) loadFile() error {
	data, err := os.ReadFile(l.file)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var evt fileEvent
		if err := json.Unmarshal([]byte(line), &evt); err != nil {
			return fmt.Errorf("read evidence ledger %s: %w", l.file, err)
		}
		switch evt.Type {
		case "evidence":
			var record types.EvidenceRecord
			if err := json.Unmarshal(evt.Data, &record); err != nil {
				return err
			}
			l.indexRecord(record)
		case "hypothesis":
			var record HypothesisRecord
			if err := json.Unmarshal(evt.Data, &record); err != nil {
				return err
			}
			l.indexHypothesis(record)
		}
	}
	return nil
}

// appendFile writes one event to the durable archive; no-op without a file.
func (l *Ledger) appendFile(evtType string, payload any) error {
	if l.file == "" {
		return nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	line, err := json.Marshal(fileEvent{Type: evtType, At: time.Now().UnixMilli(), Data: encoded})
	if err != nil {
		return err
	}
	handle, err := os.OpenFile(l.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer handle.Close()
	_, err = handle.Write(append(line, '\n'))
	return err
}

func (l *Ledger) indexRecord(record types.EvidenceRecord) {
	if !l.byID[record.ID] {
		l.records = append(l.records, record)
		l.byID[record.ID] = true
		if n := parseIDNumber(record.ID); n > l.next {
			l.next = n
		}
	}
}

func (l *Ledger) indexHypothesis(record HypothesisRecord) {
	if _, exists := l.hypotheses[record.ID]; !exists {
		l.hypothesisOrder = append(l.hypothesisOrder, record.ID)
	}
	l.hypotheses[record.ID] = record
}

// Add records one piece of evidence. It never fails: a record with a clipped
// excerpt beats losing provenance because an output looked odd.
func (l *Ledger) Add(input Input) types.EvidenceRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.next++
	kind := strings.TrimSpace(input.Kind)
	if kind == "" {
		kind = string(KindToolObservation)
	}
	record := types.EvidenceRecord{
		ID:         fmt.Sprintf("ev_%03d", l.next),
		Source:     strings.TrimSpace(input.Source),
		Kind:       kind,
		View:       strings.TrimSpace(input.View),
		Excerpt:    util.Truncate(sanitize(input.Text), excerptChars),
		IsError:    input.IsError,
		ToolCallID: input.ToolCallID,
		Artifact:   input.Artifact,
		SHA256:     input.SHA256,
		Bytes:      len(input.Text),
		CreatedAt:  types.NowMs(),
	}
	l.records = append(l.records, record)
	l.byID[record.ID] = true
	// The archive is a provenance layer; never fail a run over persistence.
	_ = l.appendFile("evidence", record)
	return record
}

// AddEvidence records a host- or model-authored record (audit findings,
// artifacts with hashes, marked claims) and returns it with its minted id.
func (l *Ledger) AddEvidence(record types.EvidenceRecord) (types.EvidenceRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.next++
	record.ID = fmt.Sprintf("ev_%03d", l.next)
	if strings.TrimSpace(record.Kind) == "" {
		record.Kind = string(KindToolObservation)
	}
	if record.CreatedAt == 0 {
		record.CreatedAt = types.NowMs()
	}
	if err := l.appendFile("evidence", record); err != nil {
		return types.EvidenceRecord{}, err
	}
	l.records = append(l.records, record)
	l.byID[record.ID] = true
	return record, nil
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

// Evidence is the List alias the manager tool and the HUD read.
func (l *Ledger) Evidence() []types.EvidenceRecord { return l.List() }

// Count reports how many records carry the given kind. The phase gates pass
// plain strings; hosts may pass a Kind.
func (l *Ledger) Count(kind any) int {
	wanted := ""
	switch value := kind.(type) {
	case Kind:
		wanted = string(value)
	case string:
		wanted = value
	default:
		return 0
	}
	count := 0
	for _, record := range l.List() {
		if record.Kind == wanted {
			count++
		}
	}
	return count
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
		if record.View != "" {
			kind += "/" + record.View
		}
		lines = append(lines, fmt.Sprintf("%s [%s%s]%s %s",
			record.ID, record.Source, kind, flag, record.Excerpt))
	}
	return strings.Join(lines, "\n")
}

// Load seeds a restored session: records the session events carried merge with
// whatever the durable archive already replayed, keyed by id, and numbering
// continues past the highest id so resumed runs never mint duplicates.
func (l *Ledger) Load(records []types.EvidenceRecord) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, record := range records {
		l.indexRecord(record)
	}
}

// Reset clears the live ledger for a fresh session or task. The durable
// archive on disk is never rewritten — evidence is append-only.
func (l *Ledger) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.records = nil
	l.byID = map[string]bool{}
	l.next = 0
}

// File is the durable archive path, empty for an in-memory ledger.
func (l *Ledger) File() string { return l.file }

func (l *Ledger) AddHypothesis(text string) (HypothesisRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextHypothesis++
	now := types.NowMs()
	record := HypothesisRecord{
		ID: fmt.Sprintf("H-%04d", l.nextHypothesis), Text: text,
		Status: HypothesisOpen, CreatedAt: now, UpdatedAt: now,
		Revisions: []HypothesisRevision{{Status: HypothesisOpen, At: now}},
	}
	if err := l.appendFile("hypothesis", record); err != nil {
		return HypothesisRecord{}, err
	}
	l.indexHypothesis(record)
	return record, nil
}

func (l *Ledger) UpdateHypothesis(id string, status HypothesisStatus, note, evidenceID, relation string) (HypothesisRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	record, ok := l.hypotheses[id]
	if !ok {
		return HypothesisRecord{}, fmt.Errorf("unknown hypothesis: %s", id)
	}
	if !ValidHypothesisStatus(string(status)) {
		return HypothesisRecord{}, fmt.Errorf("invalid hypothesis status: %s", status)
	}
	if evidenceID != "" {
		if !l.byID[evidenceID] {
			return HypothesisRecord{}, fmt.Errorf("unknown evidence: %s", evidenceID)
		}
		switch relation {
		case "supports":
			record.Supports = appendUnique(record.Supports, evidenceID)
		case "contradicts":
			record.Contradicts = appendUnique(record.Contradicts, evidenceID)
		case "":
			break
		default:
			return HypothesisRecord{}, fmt.Errorf("invalid evidence relation: %s", relation)
		}
	}
	record.Status = status
	record.UpdatedAt = types.NowMs()
	record.Revisions = append(record.Revisions, HypothesisRevision{
		Status: status, Note: note, EvidenceID: evidenceID, Relation: relation, At: record.UpdatedAt,
	})
	if err := l.appendFile("hypothesis", record); err != nil {
		return HypothesisRecord{}, err
	}
	l.indexHypothesis(record)
	return record, nil
}

func (l *Ledger) Hypotheses() []HypothesisRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]HypothesisRecord, 0, len(l.hypothesisOrder))
	for _, id := range l.hypothesisOrder {
		out = append(out, l.hypotheses[id])
	}
	return out
}

// HasHypothesisStatus reports whether any ledger hypothesis holds one of the
// given statuses. The phase gates pass plain strings.
func (l *Ledger) HasHypothesisStatus(statuses ...any) bool {
	wanted := map[HypothesisStatus]bool{}
	for _, status := range statuses {
		if value, ok := status.(HypothesisStatus); ok {
			wanted[value] = true
		} else if value, ok := status.(string); ok {
			wanted[HypothesisStatus(value)] = true
		}
	}
	for _, record := range l.Hypotheses() {
		if wanted[record.Status] {
			return true
		}
	}
	return false
}

func (l *Ledger) OpenHypotheses() []HypothesisRecord {
	var out []HypothesisRecord
	for _, record := range l.Hypotheses() {
		if record.Status == HypothesisOpen {
			out = append(out, record)
		}
	}
	return out
}

func SortRecords(records []types.EvidenceRecord) []types.EvidenceRecord {
	out := append([]types.EvidenceRecord{}, records...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
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

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

var (
	ansiRE    = regexp.MustCompile("\x1b\\[[0-9;]*m")
	controlRE = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
)
