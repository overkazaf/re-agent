package hypothesis

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestCreateAssignsSequentialIDs(t *testing.T) {
	tr := New()
	first, err := tr.Create("sub_401280 is an AES-128-CBC decrypt function", 0.7, []string{"ev_001", "ev_002"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "H-001" {
		t.Fatalf("expected H-001, got %s", first.ID)
	}
	if first.Status != types.HypActive {
		t.Fatalf("expected active status, got %s", first.Status)
	}
	if len(first.Supporting) != 2 || first.Supporting[0] != "ev_001" {
		t.Fatalf("supporting evidence not recorded: %v", first.Supporting)
	}
	second, err := tr.Create("the key schedule lives in .rodata", 0.5, nil, []string{"H-001"})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != "H-002" {
		t.Fatalf("expected H-002, got %s", second.ID)
	}
	// The dependency edge is recorded on both ends.
	if len(second.DependsOn) != 1 || second.DependsOn[0] != "H-001" {
		t.Fatalf("dependsOn not recorded: %v", second.DependsOn)
	}
	updated, ok := tr.Get("H-001")
	if !ok {
		t.Fatal("H-001 vanished")
	}
	if len(updated.Derived) != 1 || updated.Derived[0] != "H-002" {
		t.Fatalf("derived edge not backlinked: %v", updated.Derived)
	}
}

func TestCreateClampsConfidenceAndRejectsEmptyClaim(t *testing.T) {
	tr := New()
	high, _ := tr.Create("overconfident claim", 1.7, nil, nil)
	if high.Confidence != 1.0 {
		t.Fatalf("expected confidence clamped to 1.0, got %v", high.Confidence)
	}
	low, _ := tr.Create("uncertain claim", -0.5, nil, nil)
	if low.Confidence != 0.0 {
		t.Fatalf("expected confidence clamped to 0.0, got %v", low.Confidence)
	}
	if _, err := tr.Create("   ", 0.5, nil, nil); err == nil {
		t.Fatal("expected an error for an empty claim")
	}
	if _, err := tr.Create("orphan dependency", 0.5, nil, []string{"H-099"}); err == nil {
		t.Fatal("expected an error for a dependsOn id that does not exist")
	}
}

func TestCreateSanitizesClaim(t *testing.T) {
	tr := New()
	dirty := "\x1b[31m sub_401280 is AES \x00\x1b[0m " + strings.Repeat("x", 2000)
	h, err := tr.Create(dirty, 0.5, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsRune(h.Claim, '\x1b') || strings.ContainsRune(h.Claim, '\x00') {
		t.Fatalf("control characters survived sanitization: %q", h.Claim)
	}
	if len([]rune(h.Claim)) > maxClaimChars {
		t.Fatalf("claim not clipped: %d runes", len([]rune(h.Claim)))
	}
}

func TestChallengeHalvesConfidenceAndCascades(t *testing.T) {
	tr := New()
	root, _ := tr.Create("sub_401280 is AES decrypt", 0.8, nil, nil)
	child, _ := tr.Create("the key is at .rodata:0x8000", 0.7, nil, []string{root.ID})

	after, err := tr.Challenge(root.ID, "ev_009", "runtime output is all zeros")
	if err != nil {
		t.Fatal(err)
	}
	if after.Confidence != 0.4 {
		t.Fatalf("expected confidence halved to 0.4, got %v", after.Confidence)
	}
	if after.Status != types.HypActive {
		t.Fatalf("0.4 still clears the bar, status should stay active, got %s", after.Status)
	}

	// The same evidence argued twice must not degrade the claim further.
	same, _ := tr.Challenge(root.ID, "ev_009", "same evidence again")
	if same.Confidence != 0.4 || len(same.Contradicting) != 1 {
		t.Fatalf("duplicate challenge not idempotent: %v %v", same.Confidence, same.Contradicting)
	}

	// A second, distinct contradiction drops it below the bar: the claim itself
	// needs re-examination, and so does everything derived from it.
	final, _ := tr.Challenge(root.ID, "ev_010", "sbox constant never appears in memory")
	if final.Status != types.HypReevaluate {
		t.Fatalf("expected reevaluate below %v, got %s (%v)", dropBelow, final.Status, final.Confidence)
	}
	childNow, ok := tr.Get(child.ID)
	if !ok || childNow.Status != types.HypReevaluate {
		t.Fatalf("derived hypothesis not cascade-marked: %+v", childNow)
	}
}

func TestSupportAppendsEvidenceWithoutDegrading(t *testing.T) {
	tr := New()
	h, _ := tr.Create("claim", 0.6, nil, nil)
	after, err := tr.Support(h.ID, "ev_003")
	if err != nil {
		t.Fatal(err)
	}
	if after.Confidence != 0.6 || len(after.Supporting) != 1 {
		t.Fatalf("support mutated the wrong fields: %+v", after)
	}
	if _, err := tr.Support(h.ID, "ev_003"); err != nil {
		t.Fatal(err)
	}
	again, _ := tr.Get(h.ID)
	if len(again.Supporting) != 1 {
		t.Fatalf("duplicate support not deduped: %v", again.Supporting)
	}
	if _, err := tr.Support("H-099", "ev_003"); err == nil {
		t.Fatal("expected an error for an unknown hypothesis id")
	}
}

func TestRejectCascadesTransitively(t *testing.T) {
	tr := New()
	root, _ := tr.Create("root claim", 0.9, nil, nil)
	mid, _ := tr.Create("mid claim", 0.8, nil, []string{root.ID})
	leaf, _ := tr.Create("leaf claim", 0.7, nil, []string{mid.ID})
	free, _ := tr.Create("independent claim", 0.9, nil, nil)

	rejected, err := tr.Reject(root.ID, "decoy path: returns 0x46414B45")
	if err != nil {
		t.Fatal(err)
	}
	if rejected.Status != types.HypRejected || rejected.Note == "" {
		t.Fatalf("reject not recorded: %+v", rejected)
	}
	for id, want := range map[string]types.HypothesisStatus{
		root.ID: types.HypRejected, mid.ID: types.HypReevaluate,
		leaf.ID: types.HypReevaluate, free.ID: types.HypActive,
	} {
		got, _ := tr.Get(id)
		if got.Status != want {
			t.Fatalf("%s: expected %s, got %s", id, want, got.Status)
		}
	}
	if _, err := tr.Reject("H-099", ""); err == nil {
		t.Fatal("expected an error for an unknown hypothesis id")
	}
}

func TestReviseMarksDependentsForReevaluation(t *testing.T) {
	tr := New()
	root, _ := tr.Create("the flag is checked in sub_401280", 0.8, nil, nil)
	child, _ := tr.Create("sub_401280 is pure", 0.6, nil, []string{root.ID})

	revised, err := tr.Revise(root.ID, "the flag is checked in sub_4014C0", "callgraph recheck")
	if err != nil {
		t.Fatal(err)
	}
	if revised.Status != types.HypRevised || revised.Claim != "the flag is checked in sub_4014C0" {
		t.Fatalf("revision not applied: %+v", revised)
	}
	childNow, _ := tr.Get(child.ID)
	if childNow.Status != types.HypReevaluate {
		t.Fatalf("dependent not re-marked after revision: %+v", childNow)
	}
	if _, err := tr.Revise(root.ID, "   ", ""); err == nil {
		t.Fatal("expected an error for an empty revised claim")
	}
}

func TestDigestRendersStackAndCaps(t *testing.T) {
	tr := New()
	root, _ := tr.Create("root claim", 0.8, []string{"ev_001"}, nil)
	tr.Create("child claim", 0.6, nil, []string{root.ID})
	tr.Reject(root.ID, "decoy")

	digest := Digest(tr.List(), 16)
	if !strings.Contains(digest, "H-001") || !strings.Contains(digest, "root claim") {
		t.Fatalf("digest should name ids and claims:\n%s", digest)
	}
	if !strings.Contains(digest, "rejected") {
		t.Fatalf("digest should carry status:\n%s", digest)
	}

	capped := Digest(tr.List(), 1)
	if !strings.Contains(capped, "1 earlier") {
		t.Fatalf("capped digest should note what it dropped:\n%s", capped)
	}
	if Digest(nil, 16) != "" {
		t.Fatal("empty stack should render nothing")
	}
}

func TestLoadRestoresAndContinuesNumbering(t *testing.T) {
	tr := New()
	saved, _ := tr.Create("one", 0.5, nil, nil)
	five, _ := tr.Create("two", 0.5, nil, nil)
	five.ID = "H-005"

	fresh := New()
	fresh.Load([]types.Hypothesis{saved, five})
	next, err := fresh.Create("three", 0.5, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if next.ID != "H-006" {
		t.Fatalf("numbering did not continue past the loaded stack: %s", next.ID)
	}
	if len(fresh.List()) != 3 {
		t.Fatalf("expected 3 hypotheses after load, got %d", len(fresh.List()))
	}

	fresh.Reset()
	if len(fresh.List()) != 0 {
		t.Fatal("reset left hypotheses behind")
	}
	afterReset, _ := fresh.Create("four", 0.5, nil, nil)
	if afterReset.ID != "H-001" {
		t.Fatalf("numbering did not restart after reset: %s", afterReset.ID)
	}
}
