// Task capabilities and the sandbox that enforces them.
//
// The base policy (policy.go, approval.go) is static and session-wide; it
// cannot express "this task may not touch the network" or "this task has no
// device". The sandbox adds exactly that layer: an activated set of
// capabilities, deny-by-default, derived from the accepted /goal declaration
// and adjustable by the operator mid-task. Every gated command leaves an
// ActionRecord — tool, capability, command hash, decision, origin — so the
// audit can later answer "what did the agent reach for, and who said yes".
//
// Layering: the sandbox is the task boundary (may this kind of action happen
// at all); the base policy stays the safety net (destructive patterns,
// sensitive paths, tier approvals) and still runs after the sandbox allows.
// Operator-typed `!shell` escapes never pass through here — the operator is
// the authority, not an agent action.
package security

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/types"
)

// Capability is one axis the sandbox can grant or deny.
type Capability string

const (
	// CapNetwork covers commands that talk to the network, and every remote
	// (SSH) execution by transport.
	CapNetwork Capability = "network"
	// CapDevice covers device-attached tooling (adb, fastboot, frida, hdc,
	// idevice*).
	CapDevice Capability = "device"
)

// AllCapabilities lists the grantable capabilities, for /cap and prompts.
func AllCapabilities() []Capability { return []Capability{CapNetwork, CapDevice} }

// Decision is what the sandbox concluded about one action.
type Decision string

const (
	// DecisionGranted: the capability held (or none was needed).
	DecisionGranted Decision = "granted"
	// DecisionDenied: the action needed a capability the task does not have.
	DecisionDenied Decision = "denied"
	// DecisionUnmanaged: no task is scoped, so the sandbox observed the
	// action without gating it — legacy behavior, still on the record.
	DecisionUnmanaged Decision = "unmanaged"
)

// ActionRecord is the Action State row: one agent-proposed command and what
// the sandbox did with it.
type ActionRecord struct {
	At         int64      `json:"at"`
	Tool       string     `json:"tool"`
	Capability Capability `json:"capability,omitempty"`
	Subject    string     `json:"subject"`
	SHA256     string     `json:"sha256"`
	Decision   Decision   `json:"decision"`
	Origin     string     `json:"origin,omitempty"`
	Note       string     `json:"note,omitempty"`
}

// actionLimit caps the in-memory action log; the tail is the audit surface.
const actionLimit = 256

// Sandbox is the task-scoped capability gate. The zero value is inactive:
// it records actions as unmanaged and denies nothing. Activate derives
// grants from a /goal declaration's constraints; Deactivate expires them.
type Sandbox struct {
	mu       sync.Mutex
	active   bool
	granted  map[Capability]string
	deviceID string
	actions  []ActionRecord
}

func NewSandbox() *Sandbox {
	return &Sandbox{granted: map[Capability]string{}}
}

// Activate scopes the sandbox to a task: capabilities come from the
// declaration's constraints, deny-by-default — "network: allow" grants the
// network capability, anything else (or absent) leaves it denied; a device
// id grants device access, "none" does not.
func (s *Sandbox) Activate(constraints map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = true
	s.granted = map[Capability]string{}
	s.deviceID = ""
	for key, value := range constraints {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "network":
			if IsTruthy(value) {
				s.granted[CapNetwork] = "declaration"
			}
		case "device":
			value = strings.TrimSpace(value)
			if value != "" && !strings.EqualFold(value, "none") && !strings.EqualFold(value, "off") {
				s.granted[CapDevice] = "declaration"
				s.deviceID = value
			}
		}
	}
}

// Deactivate expires every capability: the task is over, and nothing granted
// for it leaks into the next one.
func (s *Sandbox) Deactivate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = false
	s.granted = map[Capability]string{}
	s.deviceID = ""
}

// Active reports whether a task scope is in force.
func (s *Sandbox) Active() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

// Grant hands a capability to the task mid-run (operator action); origin
// names who and note why. It refuses when no task scope is active: a grant
// outside a declaration is meaningless (Activate resets grants) and would
// silently mislead.
func (s *Sandbox) Grant(capability Capability, origin, note string) error {
	switch capability {
	case CapNetwork, CapDevice:
	default:
		return fmt.Errorf("unknown capability: %s", capability)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active {
		return fmt.Errorf("no task declaration is active — capabilities are task-scoped; accept one with /goal accept first")
	}
	s.granted[capability] = origin
	if capability == CapDevice && note != "" {
		s.deviceID = note
	}
	return nil
}

// Revoke withdraws a capability; origin names who withdrew it.
func (s *Sandbox) Revoke(capability Capability, origin string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.granted, capability)
	if capability == CapDevice {
		s.deviceID = ""
	}
}

// Granted returns a copy of the active grants (capability → origin).
func (s *Sandbox) Granted() map[Capability]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[Capability]string, len(s.granted))
	for capability, origin := range s.granted {
		out[capability] = origin
	}
	return out
}

// Device returns the approved device id, empty when none.
func (s *Sandbox) Device() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deviceID
}

// Actions returns the recorded actions, oldest first.
func (s *Sandbox) Actions() []ActionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]ActionRecord{}, s.actions...)
}

// Authorize is the gate: one agent command in, one decision out. It never
// prompts — a denial names the capability and the operator command that
// would grant it; the model is expected to ask, not to retry.
func (s *Sandbox) Authorize(tool, command string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := ActionRecord{
		At: types.NowMs(), Tool: tool, Subject: command, SHA256: CommandDigest(command),
	}
	if !s.active {
		record.Decision = DecisionUnmanaged
		s.append(record)
		return nil
	}
	capability, needed := requiredCapability(tool, command)
	if needed {
		if origin, granted := s.granted[capability]; granted {
			record.Capability, record.Decision, record.Origin = capability, DecisionGranted, origin
			s.append(record)
			return nil
		}
		record.Capability, record.Decision = capability, DecisionDenied
		s.append(record)
		return &DeniedError{Message: fmt.Sprintf(
			"capability %q is not granted to this task (deny-by-default); if the step genuinely needs it, ask the operator to run: /cap %s on",
			capability, capability)}
	}
	record.Decision, record.Origin = DecisionGranted, "in-scope"
	s.append(record)
	return nil
}

func (s *Sandbox) append(record ActionRecord) {
	if len(s.actions) >= actionLimit {
		copy(s.actions, s.actions[len(s.actions)-actionLimit+1:])
		s.actions = s.actions[:actionLimit-1]
	}
	s.actions = append(s.actions, record)
}

// devicePatterns match tooling that talks to an attached device; the sandbox
// wants those explicit because they mutate a second machine, not the sample.
var devicePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(^|[\s;&|])(adb|fastboot|frida|hdc|idevice[a-z-]*|devicectl)(($|[\s;&|])|[-.])`),
}

// requiredCapability maps a proposed action to the capability it needs. A
// remote execution needs the network by transport, whatever the inner
// command is; otherwise the command's own tokens decide.
func requiredCapability(tool, command string) (Capability, bool) {
	if tool == "remote_exec" || strings.HasPrefix(tool, "ssh ") {
		return CapNetwork, true
	}
	for _, pattern := range devicePatterns {
		if pattern.MatchString(command) {
			return CapDevice, true
		}
	}
	for _, pattern := range networkPatterns {
		if pattern.re.MatchString(command) {
			return CapNetwork, true
		}
	}
	return "", false
}

// CommandDigest is the stable short hash of a command for the action log.
func CommandDigest(command string) string {
	sum := sha256.Sum256([]byte(command))
	return hex.EncodeToString(sum[:])[:16]
}

// IsTruthy reads a constraint value the way an operator would write it.
func IsTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "allow", "on", "yes", "true", "granted":
		return true
	}
	return false
}
