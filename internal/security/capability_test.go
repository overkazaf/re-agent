package security

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestInactiveSandboxRecordsWithoutGating(t *testing.T) {
	sandbox := NewSandbox()
	if sandbox.Active() {
		t.Fatal("fresh sandbox must be inactive")
	}
	if err := sandbox.Authorize("run_command", "curl https://exfil.test"); err != nil {
		t.Fatalf("inactive sandbox must not gate: %v", err)
	}
	actions := sandbox.Actions()
	if len(actions) != 1 || actions[0].Decision != DecisionUnmanaged {
		t.Fatalf("action should be recorded as unmanaged: %+v", actions)
	}
}

func TestActivateDeniesByDefault(t *testing.T) {
	sandbox := NewSandbox()
	sandbox.Activate(map[string]string{"filesystem": "workspace-only"}) // no network/device granted
	err := sandbox.Authorize("run_command", "curl https://example.test")
	if err == nil || !IsDenied(err) {
		t.Fatalf("network must be denied without a grant: %v", err)
	}
	if !strings.Contains(err.Error(), `/cap network on`) {
		t.Fatalf("denial should name the operator command: %v", err)
	}
	if err := sandbox.Authorize("run_command", "adb shell pm list packages"); err == nil || !IsDenied(err) {
		t.Fatalf("device must be denied without a grant: %v", err)
	}
	if err := sandbox.Authorize("run_command", "rabin2 -I ./chall"); err != nil {
		t.Fatalf("in-scope command must pass: %v", err)
	}
}

func TestActivateGrantsFromConstraints(t *testing.T) {
	sandbox := NewSandbox()
	sandbox.Activate(map[string]string{"network": "allow", "device": "test-pixel-8"})
	grants := sandbox.Granted()
	if grants[CapNetwork] != "declaration" || grants[CapDevice] != "declaration" {
		t.Fatalf("constraints should grant: %+v", grants)
	}
	if sandbox.Device() != "test-pixel-8" {
		t.Fatalf("device id not kept: %q", sandbox.Device())
	}
	if err := sandbox.Authorize("run_command", "frida-ps -U"); err != nil {
		t.Fatalf("granted device must pass: %v", err)
	}
	// network:"deny" must not grant even when present.
	sandbox.Activate(map[string]string{"network": "deny"})
	if _, granted := sandbox.Granted()[CapNetwork]; granted {
		t.Fatal("explicit deny must not grant")
	}
}

func TestRemoteExecutionNeedsNetwork(t *testing.T) {
	sandbox := NewSandbox()
	sandbox.Activate(map[string]string{"device": "pixel"})
	if err := sandbox.Authorize("remote_exec", "rabin2 -I ./chall"); err == nil || !IsDenied(err) {
		t.Fatalf("remote transport is network and must be denied: %v", err)
	}
	if err := sandbox.Authorize("ssh lab", "rabin2 -I ./chall"); err == nil || !IsDenied(err) {
		t.Fatalf("ssh label must be treated as network: %v", err)
	}
	sandbox.Grant(CapNetwork, "operator", "")
	if err := sandbox.Authorize("remote_exec", "rabin2 -I ./chall"); err != nil {
		t.Fatalf("granted network should allow remote: %v", err)
	}
}

func TestDeactivateExpiresCapabilities(t *testing.T) {
	sandbox := NewSandbox()
	sandbox.Activate(map[string]string{"network": "allow"})
	sandbox.Deactivate()
	if sandbox.Active() || len(sandbox.Granted()) != 0 {
		t.Fatal("deactivate must expire every capability")
	}
	// And it goes back to observing, not gating.
	if err := sandbox.Authorize("run_command", "curl https://example.test"); err != nil {
		t.Fatalf("inactive sandbox must not gate: %v", err)
	}
}

func TestActionRecordsCarryProvenance(t *testing.T) {
	sandbox := NewSandbox()
	sandbox.Activate(map[string]string{"network": "allow"})
	_ = sandbox.Authorize("run_command", "curl https://a.test")
	_ = sandbox.Authorize("run_command", "curl https://b.test")
	err := sandbox.Authorize("run_command", "adb devices")
	if err == nil {
		t.Fatal("device should be denied")
	}
	actions := sandbox.Actions()
	if len(actions) != 3 {
		t.Fatalf("expected 3 actions, got %d", len(actions))
	}
	granted, denied := actions[0], actions[2]
	if granted.Decision != DecisionGranted || granted.Capability != CapNetwork || granted.Origin != "declaration" {
		t.Fatalf("granted record wrong: %+v", granted)
	}
	if denied.Decision != DecisionDenied || denied.Capability != CapDevice {
		t.Fatalf("denied record wrong: %+v", denied)
	}
	if granted.SHA256 != CommandDigest("curl https://a.test") || len(granted.SHA256) != 16 {
		t.Fatalf("command digest wrong: %q", granted.SHA256)
	}
	if CommandDigest("x") == CommandDigest("y") {
		t.Fatal("digests must differ")
	}
}

func TestGrantAndRevokeByOperator(t *testing.T) {
	sandbox := NewSandbox()
	// Granting without a task scope must refuse: the grant could never take
	// effect and would silently mislead.
	if err := sandbox.Grant(CapNetwork, "operator", ""); err == nil || !strings.Contains(err.Error(), "/goal accept") {
		t.Fatalf("grant without an active declaration should refuse with guidance: %v", err)
	}
	sandbox.Activate(nil)
	if err := sandbox.Grant(Capability("root"), "operator", ""); err == nil {
		t.Fatal("unknown capability must be rejected")
	}
	if err := sandbox.Grant(CapDevice, "operator", "pixel-8"); err != nil {
		t.Fatal(err)
	}
	if sandbox.Device() != "pixel-8" {
		t.Fatalf("operator note should set device id: %q", sandbox.Device())
	}
	sandbox.Revoke(CapDevice, "operator")
	if sandbox.Device() != "" {
		t.Fatal("revoke should clear the device id")
	}
	if err := sandbox.Authorize("run_command", "adb devices"); err == nil || !IsDenied(err) {
		t.Fatalf("revoked capability must deny: %v", err)
	}
}

func TestSandboxSatisfiesToolContextGate(t *testing.T) {
	// The tools layer only knows types.SandboxGate; prove the concrete
	// sandbox satisfies it and that a nil gate skips enforcement.
	var gate types.SandboxGate = NewSandbox()
	if gate == nil {
		t.Fatal("sandbox must implement types.SandboxGate")
	}
	var nilGate types.SandboxGate
	if nilGate != nil {
		t.Fatal("zero gate must read as nil for the skip path")
	}
}
