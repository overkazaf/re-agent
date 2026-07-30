package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestParseNumberAcceptsHexAndDecimal(t *testing.T) {
	for _, testCase := range []struct {
		text string
		want int
	}{
		{"0", 0}, {"512", 512}, {"0x10", 16}, {"0X20", 32}, {"0xdeadbeef", 0xdeadbeef},
	} {
		got, err := parseNumber(testCase.text)
		if err != nil || got != testCase.want {
			t.Fatalf("parseNumber(%q) = %d, %v; want %d", testCase.text, got, err, testCase.want)
		}
	}
	for _, bad := range []string{"zz", "0xzz", "", "12ab"} {
		if _, err := parseNumber(bad); err == nil {
			t.Fatalf("parseNumber(%q) should have failed", bad)
		}
	}
}

// hexState builds a state whose workspace holds one known file.
func hexState(t *testing.T) (*State, string) {
	t.Helper()
	workspace := t.TempDir()
	sample := filepath.Join(workspace, "sample.bin")
	if err := os.WriteFile(sample, []byte(strings.Repeat("A", 1024)), 0o644); err != nil {
		t.Fatal(err)
	}
	return &State{ToolContext: &types.ToolContext{
		Workspace: workspace,
		Policy:    &types.ExecutionPolicy{MaxReadBytes: 128 * 1024, CommandTimeoutMs: 5000},
	}}, "sample.bin"
}

func TestHexCommandRejectsBadArguments(t *testing.T) {
	for _, testCase := range []struct{ arg, want string }{
		{"", "usage"},
		{"sample.bin zz", "bad offset"},
		{"sample.bin -1", "bad offset"},
		{"sample.bin 0x10 0", "bad length"},
		{"sample.bin 0x10 nope", "bad length"},
	} {
		_, err := parseHexCommand(testCase.arg)
		if err == nil {
			t.Fatalf("/hex %q should have been rejected", testCase.arg)
		}
		if !strings.Contains(err.Error(), testCase.want) {
			t.Fatalf("/hex %q: got %v, want something about %q", testCase.arg, err, testCase.want)
		}
	}
}

func TestHexCommandArgs(t *testing.T) {
	bare, err := parseHexCommand("sample.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := bare["offset"]; ok {
		t.Fatalf("a bare path should not pin an offset, got %v", bare)
	}

	// An offset with no length must not fall back to a window starting at zero.
	windowed, err := parseHexCommand("sample.bin 0x10")
	if err != nil {
		t.Fatal(err)
	}
	if windowed["offset"] != 16 || windowed["length"] != defaultHexLength {
		t.Fatalf("bare offset should imply the default window, got %v", windowed)
	}

	full, err := parseHexCommand("sample.bin 0x20 48")
	if err != nil {
		t.Fatal(err)
	}
	if full["offset"] != 32 || full["length"] != 48 {
		t.Fatalf("explicit offset and length should both land, got %v", full)
	}
}

func TestRadare2CommandGuards(t *testing.T) {
	state, sample := hexState(t)
	for _, testCase := range []struct{ arg, want string }{
		{"", "usage"},
		{"a b", "usage"},
		{"../../etc/passwd", "escapes workspace"},
		{sample + " -w", "write mode"},
	} {
		err := handleRadare2Command(testCase.arg, state)
		if err == nil {
			t.Fatalf("/r2 %q should have been rejected", testCase.arg)
		}
		if !strings.Contains(err.Error(), testCase.want) {
			t.Fatalf("/r2 %q: got %v, want something about %q", testCase.arg, err, testCase.want)
		}
	}
}

// -w is a policy question, so it must be answered the same way whether or not
// radare2 is installed on the machine running the test.
func TestRadare2WriteGateIsIndependentOfInstall(t *testing.T) {
	state, sample := hexState(t)
	err := handleRadare2Command(sample+" -w", state)
	if err == nil || !strings.Contains(err.Error(), "write mode") {
		t.Fatalf("write gate should fire before the binary lookup, got %v", err)
	}

	state.ToolContext.Policy.AllowWrites = true
	err = handleRadare2Command(sample+" -w", state)
	if err != nil && strings.Contains(err.Error(), "write mode") {
		t.Fatal("write gate should pass once the policy allows writes")
	}
}
