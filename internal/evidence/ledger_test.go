package evidence

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestAddAssignsSequentialIDsAndClipsExcerpt(t *testing.T) {
	l := New()
	first := l.Add(Input{Source: "radare2", Text: "aaa\nCannot analyze", IsError: false, ToolCallID: "call-1"})
	if first.ID != "ev_001" {
		t.Fatalf("expected ev_001, got %s", first.ID)
	}
	if first.Source != "radare2" || first.ToolCallID != "call-1" {
		t.Fatalf("provenance not recorded: %+v", first)
	}
	if first.Bytes != len("aaa\nCannot analyze") {
		t.Fatalf("byte count wrong: %d", first.Bytes)
	}
	second := l.Add(Input{Source: "frida", Kind: "dynamic", Text: strings.Repeat("A", 1000), IsError: true})
	if second.ID != "ev_002" {
		t.Fatalf("expected ev_002, got %s", second.ID)
	}
	if !second.IsError {
		t.Fatal("error flag lost")
	}
	if len([]rune(second.Excerpt)) > excerptChars {
		t.Fatalf("excerpt not clipped: %d runes", len([]rune(second.Excerpt)))
	}
	if second.Kind != "dynamic" {
		t.Fatalf("kind not recorded: %s", second.Kind)
	}
}

func TestAddSanitizesExcerpt(t *testing.T) {
	l := New()
	rec := l.Add(Input{Source: "run_command", Text: "ok \x1b[31mred\x1b[0m \x00 end"})
	if strings.ContainsRune(rec.Excerpt, '\x1b') || strings.ContainsRune(rec.Excerpt, '\x00') {
		t.Fatalf("control characters survived: %q", rec.Excerpt)
	}
}

func TestGetAndListRoundtrip(t *testing.T) {
	l := New()
	l.Add(Input{Source: "strings", Text: "one"})
	l.Add(Input{Source: "strings", Text: "two"})
	if _, ok := l.Get("ev_002"); !ok {
		t.Fatal("ev_002 not found")
	}
	if _, ok := l.Get("ev_003"); ok {
		t.Fatal("ev_003 should not exist")
	}
	if got := l.List(); len(got) != 2 || got[0].Excerpt != "one" || got[1].Excerpt != "two" {
		t.Fatalf("list not in creation order: %+v", got)
	}
}

func TestDigestCapsAtMostRecent(t *testing.T) {
	l := New()
	for i := 0; i < 6; i++ {
		l.Add(Input{Source: "tool", Text: strings.Repeat("x", i+1)})
	}
	digest := l.Digest(4)
	if got := strings.Count(digest, "ev_"); got != 4 {
		t.Fatalf("expected 4 digest lines, got %d:\n%s", got, digest)
	}
	if !strings.Contains(digest, "ev_006") || strings.Contains(digest, "ev_002") {
		t.Fatalf("digest should keep the most recent records:\n%s", digest)
	}
	if !strings.Contains(digest, "2 earlier") {
		t.Fatalf("digest should note what it dropped:\n%s", digest)
	}
	// An empty ledger renders nothing.
	if l2 := New(); l2.Digest(4) != "" {
		t.Fatal("empty ledger should render an empty digest")
	}
}

func TestLoadContinuesNumbering(t *testing.T) {
	l := New()
	l.Load([]types.EvidenceRecord{
		{ID: "ev_005", Source: "a", Excerpt: "old"},
		{ID: "ev_007", Source: "b", Excerpt: "newer"},
	})
	next := l.Add(Input{Source: "c", Text: "fresh"})
	if next.ID != "ev_008" {
		t.Fatalf("numbering did not continue past loaded records: %s", next.ID)
	}
	if len(l.List()) != 3 {
		t.Fatalf("expected 3 records after load, got %d", len(l.List()))
	}
	l.Reset()
	if len(l.List()) != 0 {
		t.Fatal("reset left records behind")
	}
	if after := l.Add(Input{Source: "d", Text: "x"}); after.ID != "ev_001" {
		t.Fatalf("numbering did not restart after reset: %s", after.ID)
	}
}
