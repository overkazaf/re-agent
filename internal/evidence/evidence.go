package evidence

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
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

type EvidenceRecord struct {
	ID             string   `json:"id"`
	Kind           Kind     `json:"kind"`
	Source         string   `json:"source"`
	ToolCallID     string   `json:"toolCallId,omitempty"`
	Artifact       string   `json:"artifact,omitempty"`
	SHA256         string   `json:"sha256,omitempty"`
	Summary        string   `json:"summary"`
	Supports       []string `json:"supports,omitempty"`
	Contradicts    []string `json:"contradicts,omitempty"`
	UntrustedInput bool     `json:"untrustedInput,omitempty"`
	CreatedAt      int64    `json:"createdAt"`
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

type event struct {
	Type string          `json:"type"`
	At   int64           `json:"at"`
	Data json.RawMessage `json:"data"`
}

type Ledger struct {
	file string
	mu   sync.Mutex

	evidence        map[string]EvidenceRecord
	hypotheses      map[string]HypothesisRecord
	evidenceOrder   []string
	hypothesisOrder []string
	nextEvidence    int
	nextHypothesis  int
}

func Open(sessionDir string) (*Ledger, error) {
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		return nil, err
	}
	ledger := &Ledger{
		file:     filepath.Join(sessionDir, "evidence-ledger.jsonl"),
		evidence: map[string]EvidenceRecord{}, hypothesisOrder: make([]string, 0),
		hypotheses: map[string]HypothesisRecord{}, evidenceOrder: make([]string, 0),
	}
	if err := ledger.load(); err != nil {
		return nil, err
	}
	return ledger, nil
}

func (l *Ledger) load() error {
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
		var evt event
		if err := json.Unmarshal([]byte(line), &evt); err != nil {
			return fmt.Errorf("read evidence ledger %s: %w", l.file, err)
		}
		switch evt.Type {
		case "evidence":
			var record EvidenceRecord
			if err := json.Unmarshal(evt.Data, &record); err != nil {
				return err
			}
			l.indexEvidence(record)
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

func (l *Ledger) append(evtType string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	line, err := json.Marshal(event{Type: evtType, At: time.Now().UnixMilli(), Data: encoded})
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

func (l *Ledger) indexEvidence(record EvidenceRecord) {
	if _, exists := l.evidence[record.ID]; !exists {
		l.evidenceOrder = append(l.evidenceOrder, record.ID)
	}
	l.evidence[record.ID] = record
}

func (l *Ledger) indexHypothesis(record HypothesisRecord) {
	if _, exists := l.hypotheses[record.ID]; !exists {
		l.hypothesisOrder = append(l.hypothesisOrder, record.ID)
	}
	l.hypotheses[record.ID] = record
}

func (l *Ledger) AddEvidence(record EvidenceRecord) (EvidenceRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	record.ID = fmt.Sprintf("E-%04d", l.nextEvidence+1)
	record.CreatedAt = time.Now().UnixMilli()
	if record.Kind == "" {
		record.Kind = KindToolObservation
	}
	if err := l.append("evidence", record); err != nil {
		return EvidenceRecord{}, err
	}
	l.indexEvidence(record)
	l.nextEvidence++
	return record, nil
}

func (l *Ledger) AddHypothesis(text string) (HypothesisRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now().UnixMilli()
	record := HypothesisRecord{
		ID: fmt.Sprintf("H-%04d", l.nextHypothesis+1), Text: text,
		Status: HypothesisOpen, CreatedAt: now, UpdatedAt: now,
		Revisions: []HypothesisRevision{{Status: HypothesisOpen, At: now}},
	}
	if err := l.append("hypothesis", record); err != nil {
		return HypothesisRecord{}, err
	}
	l.indexHypothesis(record)
	l.nextHypothesis++
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
		if _, ok := l.evidence[evidenceID]; !ok {
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
	record.UpdatedAt = time.Now().UnixMilli()
	record.Revisions = append(record.Revisions, HypothesisRevision{
		Status: status, Note: note, EvidenceID: evidenceID, Relation: relation, At: record.UpdatedAt,
	})
	if err := l.append("hypothesis", record); err != nil {
		return HypothesisRecord{}, err
	}
	l.indexHypothesis(record)
	return record, nil
}

func (l *Ledger) Evidence() []EvidenceRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]EvidenceRecord, 0, len(l.evidenceOrder))
	for _, id := range l.evidenceOrder {
		out = append(out, l.evidence[id])
	}
	return out
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

func (l *Ledger) Count(kind any) int {
	count := 0
	for _, record := range l.Evidence() {
		if value, ok := kind.(Kind); ok && record.Kind == value {
			count++
		}
	}
	return count
}

func (l *Ledger) HasHypothesisStatus(statuses ...any) bool {
	wanted := map[HypothesisStatus]bool{}
	for _, status := range statuses {
		if value, ok := status.(HypothesisStatus); ok {
			wanted[value] = true
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

func (l *Ledger) File() string { return l.file }

func SortRecords(records []EvidenceRecord) []EvidenceRecord {
	out := append([]EvidenceRecord{}, records...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
