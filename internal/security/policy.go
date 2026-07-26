// Package security decides whether a call runs: the command safety patterns
// (policy.go) and the tier/mode approval gate (approval.go).
package security

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
)

var networkTokens = []string{
	"curl", "wget", "nc", "ncat", "netcat", "nmap", "ssh", "scp", "sftp",
	"rsync", "socat", "openssl s_client", "dig", "whois",
}

// networkPatterns is built once: CommandConcerns runs twice per run_command,
// and compiling fourteen expressions each time is pure waste. Each matches the
// token as a whole word, so `concat_files.sh` does not read as `cat`.
var networkPatterns = func() []namedPattern {
	out := make([]namedPattern, 0, len(networkTokens))
	for _, token := range networkTokens {
		out = append(out, namedPattern{
			label: token,
			re:    regexp.MustCompile(`(?i)(^|[\s;&|])` + regexp.QuoteMeta(token) + `($|[\s;&|])`),
		})
	}
	return out
}()

type namedPattern struct {
	label string
	re    *regexp.Regexp
}

var destructivePatterns = []namedPattern{
	{`/\brm\s+-[^\n;]*r[^\n;]*f\b/i`, regexp.MustCompile(`(?i)\brm\s+-[^\n;]*r[^\n;]*f\b`)},
	{`/\bdd\s+if=/i`, regexp.MustCompile(`(?i)\bdd\s+if=`)},
	{`/\bmkfs\b/i`, regexp.MustCompile(`(?i)\bmkfs\b`)},
	{`/\bdiskutil\s+erase/i`, regexp.MustCompile(`(?i)\bdiskutil\s+erase`)},
	{`/\bshutdown\b/i`, regexp.MustCompile(`(?i)\bshutdown\b`)},
	{`/\breboot\b/i`, regexp.MustCompile(`(?i)\breboot\b`)},
	{`/\blaunchctl\b/i`, regexp.MustCompile(`(?i)\blaunchctl\b`)},
	{`/\bsudo\b/i`, regexp.MustCompile(`(?i)\bsudo\b`)},
	{`/>\s*\/dev\/(?:sd|disk|rdisk)/i`, regexp.MustCompile(`(?i)>\s*/dev/(?:sd|disk|rdisk)`)},
}

var sensitivePatterns = []namedPattern{
	{`/\.ssh\b/i`, regexp.MustCompile(`(?i)\.ssh\b`)},
	{`/\.aws\b/i`, regexp.MustCompile(`(?i)\.aws\b`)},
	{`/\.gnupg\b/i`, regexp.MustCompile(`(?i)\.gnupg\b`)},
	{`/keychain/i`, regexp.MustCompile(`(?i)keychain`)},
	{`/id_rsa/i`, regexp.MustCompile(`(?i)id_rsa`)},
	{`/id_ed25519/i`, regexp.MustCompile(`(?i)id_ed25519`)},
	{`/password/i`, regexp.MustCompile(`(?i)password`)},
	{`/secret/i`, regexp.MustCompile(`(?i)secret`)},
	{`/token/i`, regexp.MustCompile(`(?i)token`)},
}

// CommandConcerns lists everything about a command that deserves a second look,
// in operator-readable form. Empty means unremarkable. Callers decide what to
// do with the list: ask the operator when there is one to ask, refuse otherwise.
func CommandConcerns(command string, policy *types.ExecutionPolicy) ([]string, error) {
	compact := strings.TrimSpace(command)
	if compact == "" {
		return nil, errors.New("command is empty")
	}
	var concerns []string
	for _, pattern := range destructivePatterns {
		if pattern.re.MatchString(compact) {
			concerns = append(concerns, "destructive pattern "+pattern.label)
		}
	}
	if !policy.AllowNetwork {
		for _, pattern := range networkPatterns {
			if pattern.re.MatchString(compact) {
				concerns = append(concerns, fmt.Sprintf("network command '%s' (--allow-network to stop asking)", pattern.label))
			}
		}
	}
	if !policy.AllowSensitive {
		for _, pattern := range sensitivePatterns {
			if pattern.re.MatchString(compact) {
				concerns = append(concerns, fmt.Sprintf("sensitive/secret-like token %s (--allow-sensitive to stop asking)", pattern.label))
			}
		}
	}
	return concerns, nil
}

// ValidateCommand is the hard refusal, for callers with no approval path.
func ValidateCommand(command string, policy *types.ExecutionPolicy) error {
	concerns, err := CommandConcerns(command, policy)
	if err != nil {
		return err
	}
	if len(concerns) > 0 {
		return fmt.Errorf("blocked by policy: %s", strings.Join(concerns, "; "))
	}
	return nil
}

func ValidatePathRead(pathValue string, policy *types.ExecutionPolicy) error {
	if policy.AllowSensitive {
		return nil
	}
	for _, pattern := range sensitivePatterns {
		if pattern.re.MatchString(pathValue) {
			return fmt.Errorf("sensitive path blocked by policy: %s", pathValue)
		}
	}
	return nil
}

func ValidateWriteAllowed(policy *types.ExecutionPolicy) error {
	if !policy.AllowWrites {
		return errors.New("writes are disabled; start with --write to permit write_file")
	}
	return nil
}
