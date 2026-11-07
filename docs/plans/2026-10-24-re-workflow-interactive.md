# Interactive RE Workflow Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn `/workflow reverse` from a passive prompt wrapper into a structured, phase-driven reverse engineering session with a sample type picker, visible phase progression, and a distinct hacker-aesthetic UI.

**Architecture:** Three new packages/files: `internal/workflow/phase.go` (phase model + RE state), `internal/workflow/picker.go` (sample type menu + canned prompts), `internal/ui/rehud.go` (hacker-mode HUD overlay). The existing `commands.go` `/workflow` handler gains an interactive entry flow; `live.go` / `dashboard.go` delegate to `rehud.go` when `Workflow == Reverse`. Prompt wrapping in `workflow.go` becomes phase-aware.

**Tech Stack:** Go 1.21+, raw ANSI via existing `ui.painters`, existing `Editor.ReadLine` for picker input.

---

## Task 1: RE Phase Model

Define the phase enum, RE session state struct, and phase transitions.

**Files:**
- Create: `internal/workflow/phase.go`
- Test: `internal/workflow/phase_test.go`

**Step 1: Write the failing test**

```go
// internal/workflow/phase_test.go
package workflow

import "testing"

func TestPhaseOrder(t *testing.T) {
	if len(Phases) != 7 {
		t.Fatalf("expected 7 phases, got %d", len(Phases))
	}
	if Phases[0] != PhaseTriage {
		t.Fatalf("first phase should be triage, got %s", Phases[0])
	}
	if Phases[6] != PhaseWriteup {
		t.Fatalf("last phase should be writeup, got %s", Phases[6])
	}
}

func TestPhaseNext(t *testing.T) {
	s := NewREState("apk")
	if s.Phase != PhaseTriage {
		t.Fatalf("initial phase = %s, want triage", s.Phase)
	}
	s.AdvancePhase()
	if s.Phase != PhaseStatic {
		t.Fatalf("after advance = %s, want static", s.Phase)
	}
}

func TestPhaseSkipTo(t *testing.T) {
	s := NewREState("so")
	if err := s.SkipTo(PhaseEvidence); err != nil {
		t.Fatal(err)
	}
	if s.Phase != PhaseEvidence {
		t.Fatalf("phase = %s, want evidence", s.Phase)
	}
}

func TestPhaseCannotRewind(t *testing.T) {
	s := NewREState("elf")
	s.AdvancePhase() // static
	s.AdvancePhase() // dynamic
	if err := s.SkipTo(PhaseTriage); err == nil {
		t.Fatal("rewind should fail")
	}
}

func TestHypothesisTracking(t *testing.T) {
	s := NewREState("apk")
	s.AddHypothesis("main activity decrypts assets with AES-CBC")
	s.AddEvidence("strings output shows javax.crypto.Cipher import")
	if len(s.Hypotheses) != 1 || len(s.Evidence) != 1 {
		t.Fatalf("tracking: hyp=%d evi=%d", len(s.Hypotheses), len(s.Evidence))
	}
	s.ReviseHypothesis(0, "AES-ECB, not CBC — IV is zeroed")
	if s.Hypotheses[0].Revised != "AES-ECB, not CBC — IV is zeroed" {
		t.Fatalf("revision not recorded")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd internal/workflow && go test -run TestPhase -v`
Expected: FAIL — `PhaseTriage` undefined

**Step 3: Write minimal implementation**

```go
// internal/workflow/phase.go
package workflow

import (
	"fmt"
	"time"
)

type Phase string

const (
	PhaseTriage     Phase = "triage"
	PhaseStatic     Phase = "static"
	PhaseDynamic    Phase = "dynamic"
	PhaseEvidence   Phase = "evidence"
	PhaseInterface  Phase = "interface"
	PhaseHypothesis Phase = "hypothesis"
	PhaseWriteup    Phase = "writeup"
)

var Phases = []Phase{
	PhaseTriage, PhaseStatic, PhaseDynamic,
	PhaseEvidence, PhaseInterface, PhaseHypothesis, PhaseWriteup,
}

func phaseIndex(p Phase) int {
	for i, v := range Phases {
		if v == p {
			return i
		}
	}
	return -1
}

type Hypothesis struct {
	Text    string
	Revised string
	At      time.Time
}

type Evidence struct {
	Text string
	At   time.Time
}

type REState struct {
	SampleType string
	Phase      Phase
	Hypotheses []Hypothesis
	Evidence   []Evidence
	StartedAt  time.Time
}

func NewREState(sampleType string) *REState {
	return &REState{
		SampleType: sampleType,
		Phase:      PhaseTriage,
		StartedAt:  time.Now(),
	}
}

func (s *REState) AdvancePhase() {
	idx := phaseIndex(s.Phase)
	if idx >= 0 && idx < len(Phases)-1 {
		s.Phase = Phases[idx+1]
	}
}

func (s *REState) SkipTo(target Phase) error {
	cur := phaseIndex(s.Phase)
	tgt := phaseIndex(target)
	if tgt < 0 {
		return fmt.Errorf("unknown phase: %s", target)
	}
	if tgt <= cur {
		return fmt.Errorf("cannot rewind from %s to %s", s.Phase, target)
	}
	s.Phase = target
	return nil
}

func (s *REState) AddHypothesis(text string) {
	s.Hypotheses = append(s.Hypotheses, Hypothesis{Text: text, At: time.Now()})
}

func (s *REState) AddEvidence(text string) {
	s.Evidence = append(s.Evidence, Evidence{Text: text, At: time.Now()})
}

func (s *REState) ReviseHypothesis(index int, revised string) {
	if index >= 0 && index < len(s.Hypotheses) {
		s.Hypotheses[index].Revised = revised
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd internal/workflow && go test -run TestPhase -v && go test -run TestHypothesis -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/workflow/phase.go internal/workflow/phase_test.go
git commit -m "feat(workflow): RE phase model with hypothesis/evidence tracking"
```

---

## Task 2: Sample Type Picker

When the user types `/workflow reverse`, show a numbered menu of sample types with canned starter prompts. The user picks a type, picks or skips a prompt, and the RE session begins.

**Files:**
- Create: `internal/workflow/picker.go`
- Test: `internal/workflow/picker_test.go`
- Modify: `internal/app/commands.go:197-207` (the `/workflow` case)
- Modify: `internal/app/app.go:31-57` (add `REState *workflow.REState` to `State`)

**Step 1: Write the failing test for picker data**

```go
// internal/workflow/picker_test.go
package workflow

import "testing"

func TestSampleTypes(t *testing.T) {
	types := SampleTypes()
	if len(types) < 5 {
		t.Fatalf("expected at least 5 sample types, got %d", len(types))
	}
	for _, st := range types {
		if len(st.Prompts) == 0 {
			t.Fatalf("sample type %q has no prompts", st.Label)
		}
	}
}

func TestSampleTypeByKey(t *testing.T) {
	st := SampleTypeByKey("apk")
	if st == nil {
		t.Fatal("apk type not found")
	}
	if st.Label != "APK" {
		t.Fatalf("label = %s, want APK", st.Label)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd internal/workflow && go test -run TestSample -v`
Expected: FAIL — `SampleTypes` undefined

**Step 3: Implement picker data**

```go
// internal/workflow/picker.go
package workflow

type SampleType struct {
	Key     string
	Label   string
	Desc    string
	Prompts []SamplePrompt
}

type SamplePrompt struct {
	Short string
	Full  string
}

func SampleTypes() []SampleType {
	return []SampleType{
		{Key: "apk", Label: "APK", Desc: "Android application package",
			Prompts: []SamplePrompt{
				{Short: "Triage APK structure", Full: "Identify package name, permissions, components, native libs, and signing info for this APK."},
				{Short: "Find hardcoded secrets", Full: "Search for hardcoded API keys, tokens, URLs, and credentials in the APK's dex and resource files."},
				{Short: "Trace native JNI calls", Full: "Map JNI bridge methods between Java/Kotlin and native .so libraries in this APK."},
				{Short: "Recover obfuscated logic", Full: "Deobfuscate and recover the core business logic from this APK's smali/dex."},
			}},
		{Key: "so", Label: "SO / ELF shared lib", Desc: "Linux/Android shared object",
			Prompts: []SamplePrompt{
				{Short: "Symbol & import survey", Full: "List exported/imported symbols, detect stripping level, and identify key routines."},
				{Short: "Find crypto primitives", Full: "Locate cryptographic constants, S-boxes, and cipher implementations in this binary."},
				{Short: "Reconstruct C structs", Full: "Recover C/C++ struct layouts from field access patterns in the decompiled code."},
			}},
		{Key: "dylib", Label: "dylib / Mach-O", Desc: "macOS/iOS dynamic library",
			Prompts: []SamplePrompt{
				{Short: "Objective-C class dump", Full: "Dump Objective-C class hierarchy, selectors, and protocol conformances."},
				{Short: "Swift metadata recovery", Full: "Recover Swift type metadata, protocol witness tables, and generic signatures."},
				{Short: "Entitlements & codesign", Full: "Extract and analyze code signing info, entitlements, and provisioning profile."},
			}},
		{Key: "elf", Label: "ELF binary", Desc: "Linux executable / core dump",
			Prompts: []SamplePrompt{
				{Short: "Binary hardening check", Full: "Check RELRO, stack canary, NX, PIE, FORTIFY, and RPATH/RUNPATH settings."},
				{Short: "Vulnerability surface", Full: "Identify dangerous function calls (gets, strcpy, system) and potential overflow points."},
				{Short: "Control flow recovery", Full: "Recover the main control flow graph and identify key decision points."},
			}},
		{Key: "pe", Label: "PE / DLL", Desc: "Windows executable or library",
			Prompts: []SamplePrompt{
				{Short: "Import table analysis", Full: "Analyze IAT/EAT, identify suspicious API imports (VirtualAlloc, CreateRemoteThread, etc)."},
				{Short: "Packer/protector detect", Full: "Detect packing, encryption, or obfuscation layers (UPX, VMProtect, Themida, etc)."},
				{Short: "Resource extraction", Full: "Extract embedded resources, version info, manifests, and suspicious payloads."},
			}},
		{Key: "firmware", Label: "Firmware blob", Desc: "Embedded / IoT firmware image",
			Prompts: []SamplePrompt{
				{Short: "Firmware survey", Full: "Identify base address, architecture, filesystem layout, and embedded OS."},
				{Short: "Extract filesystem", Full: "Carve and extract the filesystem image, then inventory key binaries and configs."},
				{Short: "Find hardcoded creds", Full: "Search for default passwords, private keys, certificates, and debug backdoors."},
			}},
		{Key: "pcap", Label: "PCAP / traffic", Desc: "Network capture file",
			Prompts: []SamplePrompt{
				{Short: "Protocol identification", Full: "Identify protocols, session flows, and extract notable payloads from this capture."},
				{Short: "C2 traffic analysis", Full: "Look for C2 beaconing patterns, DNS tunneling, or suspicious periodic connections."},
			}},
	}
}

func SampleTypeByKey(key string) *SampleType {
	for _, st := range SampleTypes() {
		if st.Key == key {
			return &st
		}
	}
	return nil
}
```

**Step 4: Run tests to verify they pass**

Run: `cd internal/workflow && go test -run TestSample -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/workflow/picker.go internal/workflow/picker_test.go
git commit -m "feat(workflow): sample type definitions with canned RE prompts"
```

---

## Task 3: Interactive Picker UI Rendering

Render the sample type picker as a hacker-styled numbered menu using the existing `ui.painters` system.

**Files:**
- Create: `internal/ui/repicker.go`
- Test: `internal/ui/repicker_test.go`

**Step 1: Write the failing test**

```go
// internal/ui/repicker_test.go
package ui

import "testing"

func TestRenderREPicker(t *testing.T) {
	items := []REPickerItem{
		{Key: "apk", Label: "APK", Desc: "Android application package"},
		{Key: "so", Label: "SO", Desc: "shared object"},
	}
	lines := RenderREPicker(items, 80)
	if len(lines) == 0 {
		t.Fatal("expected at least one line")
	}
	// Should contain the APK label somewhere in the plain text
	found := false
	for _, l := range lines {
		if containsPlain(l, "APK") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("APK label not found in picker output")
	}
}

func TestRenderREPromptMenu(t *testing.T) {
	prompts := []string{"Triage APK structure", "Find hardcoded secrets"}
	lines := RenderREPromptMenu("APK", prompts, 80)
	if len(lines) == 0 {
		t.Fatal("expected prompt menu lines")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd internal/ui && go test -run TestRenderRE -v`
Expected: FAIL — `RenderREPicker` undefined

**Step 3: Implement picker rendering**

```go
// internal/ui/repicker.go
package ui

import (
	"fmt"
	"strings"
)

type REPickerItem struct {
	Key   string
	Label string
	Desc  string
}

func RenderREPicker(items []REPickerItem, width int) []string {
	p := paint()
	if width < 40 {
		width = 40
	}

	inner := width - 4
	var lines []string

	// Top border
	lines = append(lines, p.Accent("╭─")+p.Accent("[ ")+p.Bold(p.Accent("TARGET SELECT"))+p.Accent(" ]")+p.Accent(strings.Repeat("─", max(0, inner-18))+"╮"))

	lines = append(lines, boxLine("", inner, p))

	for i, item := range items {
		num := fmt.Sprintf(" [%d]", i+1)
		label := item.Label
		desc := p.Muted(" — " + item.Desc)
		line := p.Bold(p.Accent(num)) + " " + p.Bold(label) + desc
		lines = append(lines, boxLinePainted(line, plainLen(num)+1+len(item.Label)+3+len(item.Desc), inner, p))
	}

	lines = append(lines, boxLine("", inner, p))
	hint := p.Muted("  enter number or type name, [s] skip")
	lines = append(lines, boxLinePainted(hint, 39, inner, p))
	lines = append(lines, p.Accent("╰"+strings.Repeat("─", inner+2)+"╯"))

	return lines
}

func RenderREPromptMenu(sampleLabel string, prompts []string, width int) []string {
	p := paint()
	if width < 40 {
		width = 40
	}

	inner := width - 4
	var lines []string

	header := fmt.Sprintf("SUGGESTED PROMPTS — %s", sampleLabel)
	lines = append(lines, p.Accent("╭─")+p.Accent("[ ")+p.Bold(p.Accent(header))+p.Accent(" ]")+p.Accent(strings.Repeat("─", max(0, inner-len(header)-4))+"╮"))
	lines = append(lines, boxLine("", inner, p))

	for i, prompt := range prompts {
		num := fmt.Sprintf(" [%d]", i+1)
		line := p.Bold(p.Accent(num)) + " " + prompt
		lines = append(lines, boxLinePainted(line, plainLen(num)+1+len(prompt), inner, p))
	}

	lines = append(lines, boxLine("", inner, p))
	hint := p.Muted("  enter number to start, [s] skip, [c] custom prompt")
	lines = append(lines, boxLinePainted(hint, 52, inner, p))
	lines = append(lines, p.Accent("╰"+strings.Repeat("─", inner+2)+"╯"))

	return lines
}

func boxLine(text string, inner int, p painters) string {
	pad := inner - DisplayWidth(text)
	if pad < 0 {
		pad = 0
	}
	return p.Accent("│") + " " + text + strings.Repeat(" ", pad) + " " + p.Accent("│")
}

func boxLinePainted(painted string, plainWidth int, inner int, p painters) string {
	pad := inner - plainWidth
	if pad < 0 {
		pad = 0
	}
	return p.Accent("│") + " " + painted + strings.Repeat(" ", pad) + " " + p.Accent("│")
}

func plainLen(s string) int {
	return DisplayWidth(s)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func containsPlain(painted, target string) bool {
	return strings.Contains(stripAnsi(painted), target)
}
```

Note: `stripAnsi` may already exist in the ui package; if not, add a minimal version for test use. `paint()` returns the current theme's painters.

**Step 4: Run tests to verify they pass**

Run: `cd internal/ui && go test -run TestRenderRE -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/ui/repicker.go internal/ui/repicker_test.go
git commit -m "feat(ui): hacker-styled sample type and prompt picker rendering"
```

---

## Task 4: Wire Picker into `/workflow reverse`

When the user types `/workflow reverse`, run the interactive picker flow in the REPL before entering the workflow.

**Files:**
- Modify: `internal/app/commands.go:197-207` (expand `/workflow` case)
- Modify: `internal/app/app.go:31-57` (add `REState` field to State)
- Create: `internal/app/re_picker.go` (interactive flow using Editor)

**Step 1: Add REState to State struct**

In `internal/app/app.go`, add to `State`:

```go
REState  *workflow.REState
```

**Step 2: Create the interactive picker logic**

```go
// internal/app/re_picker.go
package app

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/ui"
	"github.com/overkazaf/re-agent/internal/workflow"
)

func runREPicker(state *State) (prompt string, ok bool) {
	types := workflow.SampleTypes()
	items := make([]ui.REPickerItem, len(types))
	for i, st := range types {
		items[i] = ui.REPickerItem{Key: st.Key, Label: st.Label, Desc: st.Desc}
	}

	w, _, _ := termSize()
	if w < 40 {
		w = 80
	}

	// Render sample type picker
	for _, line := range ui.RenderREPicker(items, w) {
		fmt.Println(line)
	}

	raw, err := state.editor.ReadLine(ui.REPromptLabel("target"))
	if err != nil {
		return "", false
	}
	choice := strings.TrimSpace(raw)
	if choice == "s" || choice == "S" {
		// User skipped — enter reverse mode without a canned prompt
		state.REState = workflow.NewREState("generic")
		return "", true
	}

	var selected *workflow.SampleType
	if n, err := strconv.Atoi(choice); err == nil && n >= 1 && n <= len(types) {
		selected = &types[n-1]
	} else {
		selected = workflow.SampleTypeByKey(strings.ToLower(choice))
	}
	if selected == nil {
		fmt.Println(ui.RenderError("unknown sample type: " + choice))
		return "", false
	}

	state.REState = workflow.NewREState(selected.Key)

	// Render prompt suggestions
	shorts := make([]string, len(selected.Prompts))
	for i, p := range selected.Prompts {
		shorts[i] = p.Short
	}
	for _, line := range ui.RenderREPromptMenu(selected.Label, shorts, w) {
		fmt.Println(line)
	}

	raw, err = state.editor.ReadLine(ui.REPromptLabel("prompt"))
	if err != nil {
		return "", true
	}
	pick := strings.TrimSpace(raw)
	if pick == "s" || pick == "S" {
		return "", true
	}
	if pick == "c" || pick == "C" {
		raw, err = state.editor.ReadLine(ui.REPromptLabel("custom"))
		if err != nil {
			return "", true
		}
		return strings.TrimSpace(raw), true
	}
	if n, err := strconv.Atoi(pick); err == nil && n >= 1 && n <= len(selected.Prompts) {
		return selected.Prompts[n-1].Full, true
	}

	return pick, true
}
```

**Step 3: Update `/workflow` command handler**

In `commands.go`, replace the `/workflow` case (lines ~197-207):

```go
case "/workflow":
	if arg == "" {
		fmt.Println(ui.RenderNotice(workflow.Status(state.Workflow, state.Config, state.Provider)))
		return nil
	}
	if !workflow.IsMode(arg) {
		return fmt.Errorf("usage: /workflow %s", workflow.List())
	}
	state.Workflow = workflow.Mode(arg)
	if state.Workflow == workflow.Reverse {
		prompt, ok := runREPicker(state)
		if !ok {
			state.Workflow = workflow.Off
			return nil
		}
		fmt.Println(ui.RenderNotice(workflow.Status(state.Workflow, state.Config, state.Provider)))
		if prompt != "" {
			// Queue the chosen prompt as the next user turn
			state.Queue.Push(prompt)
		}
		return nil
	}
	if state.Workflow != workflow.Reverse {
		state.REState = nil
	}
	fmt.Println(ui.RenderNotice(workflow.Status(state.Workflow, state.Config, state.Provider)))
	return nil
```

**Step 4: Test manually**

Run: `go build ./... && go run . --config config.yaml` then type `/workflow reverse`
Expected: see the hacker-styled target picker, choose APK, see prompt suggestions

**Step 5: Commit**

```bash
git add internal/app/re_picker.go internal/app/commands.go internal/app/app.go
git commit -m "feat(workflow): interactive sample picker on /workflow reverse"
```

---

## Task 5: Phase-Aware Prompt Wrapping

Make `wrapReverse` use the current RE phase to inject phase-specific instructions.

**Files:**
- Modify: `internal/workflow/workflow.go:252-274` (rewrite `wrapReverse`)
- Modify: `internal/workflow/workflow.go:112-132` (`WrapPrompt` signature: add `*REState`)
- Modify: `internal/app/workflow_run.go` (pass REState)
- Test: `internal/workflow/workflow_test.go` (add phase-aware wrap test)

**Step 1: Write the failing test**

```go
// Add to internal/workflow/workflow_test.go
func TestWrapReversePhaseAware(t *testing.T) {
	s := NewREState("apk")
	wrapped := WrapReverseWithPhase("analyze this APK", s)
	if !strings.Contains(wrapped, "triage") {
		t.Fatal("triage phase not mentioned in initial wrap")
	}
	s.AdvancePhase()
	wrapped = WrapReverseWithPhase("look at imports", s)
	if !strings.Contains(wrapped, "static") {
		t.Fatal("static phase not mentioned after advance")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd internal/workflow && go test -run TestWrapReversePhase -v`
Expected: FAIL — `WrapReverseWithPhase` undefined

**Step 3: Implement phase-aware wrapping**

Add to `workflow.go`:

```go
func WrapReverseWithPhase(prompt string, state *REState) string {
	if state == nil {
		return wrapReverse(prompt, Reverse)
	}
	phaseInstructions := phasePromptBlock(state)
	stateBlock := reStateBlock(state)
	return strings.Join([]string{
		"0xAF-Re workflow mode: reverse",
		fmt.Sprintf("Sample type: %s | Current phase: %s", state.SampleType, state.Phase),
		"",
		phaseInstructions,
		"",
		stateBlock,
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
```

Update `WrapPrompt` to accept optional REState and route to `WrapReverseWithPhase` when in Reverse mode.

**Step 4: Run tests**

Run: `cd internal/workflow && go test -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/workflow/workflow.go internal/workflow/workflow_test.go internal/app/workflow_run.go
git commit -m "feat(workflow): phase-aware prompt wrapping for reverse mode"
```

---

## Task 6: `update_re_state` Tool

Add a tool the LLM calls to advance phases, record hypotheses, and log evidence.

**Files:**
- Create: `internal/tools/restate.go`
- Test: `internal/tools/restate_test.go`
- Modify: `internal/app/app.go` (register tool)

**Step 1: Write the failing test**

```go
// internal/tools/restate_test.go
package tools

import (
	"testing"

	"github.com/overkazaf/re-agent/internal/workflow"
)

func TestREStateToolAdvance(t *testing.T) {
	state := workflow.NewREState("apk")
	result := handleREStateUpdate(state, map[string]any{
		"action": "advance",
	})
	if state.Phase != workflow.PhaseStatic {
		t.Fatalf("phase = %s, want static", state.Phase)
	}
	if result.Error != "" {
		t.Fatal(result.Error)
	}
}

func TestREStateToolHypothesis(t *testing.T) {
	state := workflow.NewREState("so")
	result := handleREStateUpdate(state, map[string]any{
		"action":     "hypothesis",
		"text":       "uses XOR encryption with rotating key",
	})
	if len(state.Hypotheses) != 1 {
		t.Fatal("hypothesis not added")
	}
	if result.Error != "" {
		t.Fatal(result.Error)
	}
}

func TestREStateToolEvidence(t *testing.T) {
	state := workflow.NewREState("elf")
	result := handleREStateUpdate(state, map[string]any{
		"action": "evidence",
		"text":   "offset 0x4080: XOR loop with key at 0x4000",
	})
	if len(state.Evidence) != 1 {
		t.Fatal("evidence not added")
	}
	if result.Error != "" {
		t.Fatal(result.Error)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd internal/tools && go test -run TestREState -v`
Expected: FAIL — `handleREStateUpdate` undefined

**Step 3: Implement the tool**

```go
// internal/tools/restate.go
package tools

import (
	"encoding/json"
	"fmt"

	"github.com/overkazaf/re-agent/internal/workflow"
)

type REStateResult struct {
	Phase      string `json:"phase"`
	Message    string `json:"message"`
	Error      string `json:"error,omitempty"`
}

func handleREStateUpdate(state *workflow.REState, params map[string]any) REStateResult {
	if state == nil {
		return REStateResult{Error: "no active RE session — enter /workflow reverse first"}
	}
	action, _ := params["action"].(string)
	switch action {
	case "advance":
		old := state.Phase
		state.AdvancePhase()
		return REStateResult{
			Phase:   string(state.Phase),
			Message: fmt.Sprintf("advanced from %s to %s", old, state.Phase),
		}
	case "skip_to":
		target, _ := params["phase"].(string)
		if err := state.SkipTo(workflow.Phase(target)); err != nil {
			return REStateResult{Phase: string(state.Phase), Error: err.Error()}
		}
		return REStateResult{Phase: string(state.Phase), Message: "skipped to " + target}
	case "hypothesis":
		text, _ := params["text"].(string)
		if text == "" {
			return REStateResult{Phase: string(state.Phase), Error: "text is required"}
		}
		state.AddHypothesis(text)
		return REStateResult{Phase: string(state.Phase), Message: fmt.Sprintf("hypothesis added: [H%d]", len(state.Hypotheses)-1)}
	case "revise":
		idx := intParam(params, "index")
		text, _ := params["text"].(string)
		state.ReviseHypothesis(idx, text)
		return REStateResult{Phase: string(state.Phase), Message: fmt.Sprintf("hypothesis [H%d] revised", idx)}
	case "evidence":
		text, _ := params["text"].(string)
		if text == "" {
			return REStateResult{Phase: string(state.Phase), Error: "text is required"}
		}
		state.AddEvidence(text)
		return REStateResult{Phase: string(state.Phase), Message: fmt.Sprintf("evidence added: [E%d]", len(state.Evidence)-1)}
	case "status":
		return REStateResult{Phase: string(state.Phase), Message: stateStatusLine(state)}
	default:
		return REStateResult{Phase: string(state.Phase), Error: "unknown action: " + action + " (use advance, skip_to, hypothesis, revise, evidence, status)"}
	}
}

func intParam(params map[string]any, key string) int {
	switch v := params[key].(type) {
	case float64:
		return int(v)
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	default:
		return 0
	}
}

func stateStatusLine(state *workflow.REState) string {
	return fmt.Sprintf("phase=%s hypotheses=%d evidence=%d sample=%s",
		state.Phase, len(state.Hypotheses), len(state.Evidence), state.SampleType)
}
```

Tool registration (in `app.go` or the tool registry) should map `update_re_state` to a handler that calls `handleREStateUpdate(state.REState, params)`.

**Step 4: Run tests**

Run: `cd internal/tools && go test -run TestREState -v`
Expected: PASS

**Step 5: Commit**

```bash
git add internal/tools/restate.go internal/tools/restate_test.go
git commit -m "feat(tools): update_re_state tool for phase/hypothesis/evidence management"
```

---

## Task 7: Hacker-Mode HUD Overlay

When `Workflow == Reverse`, the live dashboard shows a distinct hacker-styled overlay: phase progress bar, hypothesis/evidence counts, and sample type badge.

**Files:**
- Create: `internal/ui/rehud.go`
- Test: `internal/ui/rehud_test.go`
- Modify: `internal/ui/dashboard.go:30-32` (delegate to RE HUD when workflow is reverse)
- Modify: `internal/ui/hud.go:115-140` (add REState fields to HudModel)

**Step 1: Write the failing test**

```go
// internal/ui/rehud_test.go
package ui

import "testing"

func TestRenderREOverlay(t *testing.T) {
	model := REHudModel{
		SampleType:  "APK",
		Phase:       "static",
		PhaseIndex:  1,
		PhaseCount:  7,
		Hypotheses:  2,
		Evidence:    5,
	}
	lines := RenderREOverlay(model, 80)
	if len(lines) < 3 {
		t.Fatalf("expected at least 3 lines, got %d", len(lines))
	}
}

func TestPhaseProgressBar(t *testing.T) {
	bar := phaseProgressBar(2, 7, 40)
	if len(bar) == 0 {
		t.Fatal("empty progress bar")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd internal/ui && go test -run TestRenderREOverlay -v`
Expected: FAIL

**Step 3: Implement RE HUD overlay**

```go
// internal/ui/rehud.go
package ui

import (
	"fmt"
	"strings"
)

type REHudModel struct {
	SampleType string
	Phase      string
	PhaseIndex int
	PhaseCount int
	Hypotheses int
	Evidence   int
}

func RenderREOverlay(model REHudModel, width int) []string {
	p := paint()
	inner := width - 4
	if inner < 20 {
		inner = 20
	}

	var lines []string

	// Phase progress header
	badge := p.Reverse(" " + model.SampleType + " ")
	phaseLabel := p.Bold(p.Accent(strings.ToUpper(model.Phase)))
	bar := phaseProgressBar(model.PhaseIndex, model.PhaseCount, min(inner-30, 20))
	headerLine := fmt.Sprintf("  %s  %s  %s", badge, phaseLabel, bar)
	lines = append(lines, headerLine)

	// Stats line
	hyp := fmt.Sprintf("H:%d", model.Hypotheses)
	evi := fmt.Sprintf("E:%d", model.Evidence)
	step := fmt.Sprintf("[%d/%d]", model.PhaseIndex+1, model.PhaseCount)
	statsLine := fmt.Sprintf("  %s  %s  %s",
		p.Accent(hyp), p.OK(evi), p.Muted(step))
	lines = append(lines, statsLine)

	// Phase names strip
	phases := []string{"TRI", "STA", "DYN", "EVI", "IFC", "HYP", "WRI"}
	var strip []string
	for i, name := range phases {
		if i < model.PhaseIndex {
			strip = append(strip, p.Muted(name))
		} else if i == model.PhaseIndex {
			strip = append(strip, p.Bold(p.Accent("▸"+name)))
		} else {
			strip = append(strip, p.Faint(name))
		}
	}
	lines = append(lines, "  "+strings.Join(strip, p.Faint(" → ")))

	return lines
}

func phaseProgressBar(current, total, width int) string {
	if width < 4 {
		width = 4
	}
	p := paint()
	filled := 0
	if total > 0 {
		filled = (current * width) / total
	}
	if filled > width {
		filled = width
	}
	return p.Accent(strings.Repeat("▰", filled)) + p.Faint(strings.Repeat("▱", width-filled))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

**Step 4: Wire into dashboard**

In `dashboard.go`, at the top of `RenderDashboard`, before the normal flow section, check if an RE overlay model is present in `HudModel` and prepend the overlay lines.

Add to `HudModel` in `hud.go`:
```go
RE *REHudModel
```

In `dashboardBuild`, if `model.RE != nil`, insert `RenderREOverlay(*model.RE, width)` as the first section after the top border.

**Step 5: Run tests**

Run: `cd internal/ui && go test -run TestRenderRE -v`
Expected: PASS

**Step 6: Commit**

```bash
git add internal/ui/rehud.go internal/ui/rehud_test.go internal/ui/dashboard.go internal/ui/hud.go
git commit -m "feat(ui): hacker-mode HUD overlay for RE workflow"
```

---

## Task 8: Phase-Aware Prompt Label

Change the REPL prompt from `role/provider ❯` to a phase-tagged hacker prompt when in reverse workflow mode.

**Files:**
- Modify: `internal/ui/ui.go` (add `REPromptLabel` function)
- Modify: `internal/app/repl.go:64` (use RE prompt when active)

**Step 1: Add `REPromptLabel` function**

```go
// In internal/ui/ui.go
func REPromptLabel(context string) string {
	p := paint()
	return p.Accent("0xAF") + p.Muted(":") + p.Bold(p.Accent(context)) + p.Accent(" ▸ ")
}

func REPhasePromptLabel(phase, sampleType string) string {
	p := paint()
	return p.Accent("0xAF") + p.Muted("[") + p.Warn(sampleType) + p.Muted("|") + p.Bold(p.Accent(phase)) + p.Muted("]") + p.Accent(" ▸ ")
}
```

**Step 2: Update REPL to use phase prompt**

In `repl.go`, change line 64:

```go
var prompt string
if state.Workflow == workflow.Reverse && state.REState != nil {
	prompt = ui.REPhasePromptLabel(string(state.REState.Phase), state.REState.SampleType)
} else {
	prompt = ui.PromptLabel(state.Config, state.Role, state.Provider)
}
```

**Step 3: Test manually**

Run: `go build ./... && go run .` → `/workflow reverse` → pick APK
Expected: prompt changes to `0xAF[apk|triage] ▸`

**Step 4: Commit**

```bash
git add internal/ui/ui.go internal/app/repl.go
git commit -m "feat(ui): phase-aware hacker prompt label for RE workflow"
```

---

## Task 9: `/phase` Command

Add a `/phase` slash command to manually view/advance/skip phases.

**Files:**
- Modify: `internal/app/commands.go` (add `/phase` case)

**Step 1: Implement**

```go
case "/phase":
	if state.REState == nil {
		return fmt.Errorf("no active RE session — enter /workflow reverse first")
	}
	if arg == "" {
		// Show current phase + hypothesis/evidence summary
		fmt.Println(ui.RenderNotice(fmt.Sprintf(
			"phase=%s [%d/%d] hypotheses=%d evidence=%d sample=%s",
			state.REState.Phase, workflow.PhaseIndex(state.REState.Phase)+1, len(workflow.Phases),
			len(state.REState.Hypotheses), len(state.REState.Evidence), state.REState.SampleType,
		)))
		for i, h := range state.REState.Hypotheses {
			status := "active"
			if h.Revised != "" {
				status = "revised → " + h.Revised
			}
			fmt.Printf("  [H%d] %s (%s)\n", i, h.Text, status)
		}
		return nil
	}
	switch arg {
	case "next":
		state.REState.AdvancePhase()
		fmt.Println(ui.RenderNotice("phase → " + string(state.REState.Phase)))
	default:
		if err := state.REState.SkipTo(workflow.Phase(arg)); err != nil {
			return err
		}
		fmt.Println(ui.RenderNotice("phase → " + string(state.REState.Phase)))
	}
	return nil
```

Also add `PhaseIndex` as a public function in `phase.go`:
```go
func PhaseIndex(p Phase) int { return phaseIndex(p) }
```

**Step 2: Add `/phase` to slash command palette**

Register in the completion/palette data (wherever `/workflow`, `/theme` etc. are listed).

**Step 3: Test manually**

`/workflow reverse` → pick target → `/phase` → `/phase next` → `/phase evidence`

**Step 4: Commit**

```bash
git add internal/app/commands.go internal/workflow/phase.go
git commit -m "feat(cmd): /phase command for RE workflow phase control"
```

---

## Task 10: Integration Test & Polish

End-to-end check that the full flow works: enter reverse, pick sample, see hacker UI, advance phases, see prompt change.

**Files:**
- Test: `internal/app/re_picker_test.go` (unit test for picker logic)
- Manual: full flow test

**Step 1: Write unit test for picker data flow**

```go
// internal/app/re_picker_test.go
package app

import (
	"testing"

	"github.com/overkazaf/re-agent/internal/workflow"
)

func TestREPickerSampleTypeCount(t *testing.T) {
	types := workflow.SampleTypes()
	if len(types) < 5 {
		t.Fatalf("need at least 5 sample types for picker, got %d", len(types))
	}
}
```

**Step 2: Run all tests**

Run: `go test ./...`
Expected: all PASS

**Step 3: Manual integration test**

1. `go run . --config config.yaml`
2. Type `/workflow reverse` — see target picker with hacker border
3. Enter `1` (APK) — see prompt menu
4. Enter `1` — see the canned prompt queued, prompt changes to `0xAF[apk|triage] ▸`
5. Type `/phase` — see phase status
6. Type `/phase next` — see `phase → static`, prompt updates
7. Type `/workflow off` — prompt reverts to normal

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(workflow): complete interactive RE workflow with phases, picker, and hacker UI"
```

---

Plan complete and saved to `docs/plans/2026-10-24-re-workflow-interactive.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?
