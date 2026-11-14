package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

type VerificationCase struct {
	Name         string
	Command      string
	Input        string
	ExpectedFile string
	Expected     string
}

type VerificationResult struct {
	Artifact string       `json:"artifact"`
	SHA256   string       `json:"sha256"`
	Build    bool         `json:"build"`
	Passed   int          `json:"passed"`
	Failed   int          `json:"failed"`
	Total    int          `json:"total"`
	Details  []CaseResult `json:"cases"`
}

type CaseResult struct {
	Name     string `json:"name"`
	Passed   bool   `json:"passed"`
	Expected string `json:"expected,omitempty"`
	Actual   string `json:"actual,omitempty"`
	Error    string `json:"error,omitempty"`
}

func VerifyArtifactTool() types.Tool {
	return types.Tool{
		Name:        "verify_artifact",
		Description: "Build and replay a local artifact with fixed inputs, then compare stdout with expected output. Records pass/fail counts and artifact hash.",
		Risk:        types.RiskExecute,
		Parameters: objectSchema(map[string]any{
			"artifact":     map[string]any{"type": "string", "description": "Workspace-relative artifact path."},
			"buildCommand": map[string]any{"type": "string", "description": "Optional build/check command run before replay."},
			"cases": map[string]any{
				"type":        "array",
				"description": "Replay cases. Each case has name, command, optional input, and expected or expectedFile.",
				"items":       map[string]any{"type": "object"},
			},
		}, "artifact", "cases"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			artifactValue, _ := args["artifact"].(string)
			artifact, err := util.ResolveInside(tc.Workspace, artifactValue)
			if err != nil {
				return types.ToolResult{}, err
			}
			result := VerificationResult{Artifact: relative(tc.Workspace, artifact), SHA256: FileSHA256(artifact), Build: true}

			if buildCommand, _ := args["buildCommand"].(string); strings.TrimSpace(buildCommand) != "" {
				build, err := RunShellForVerification(buildCommand, tc)
				if err != nil {
					result.Build = false
					return verificationResult(result, build, err)
				}
			}

			rawCases, _ := args["cases"].([]any)
			for _, rawCase := range rawCases {
				values, _ := rawCase.(map[string]any)
				test := parseVerificationCase(values)
				if test.ExpectedFile != "" {
					expectedPath, err := util.ResolveInside(tc.Workspace, test.ExpectedFile)
					if err != nil {
						result.Details = append(result.Details, CaseResult{Name: test.Name, Error: err.Error()})
						continue
					}
					expectedData, err := os.ReadFile(expectedPath)
					if err != nil {
						result.Details = append(result.Details, CaseResult{Name: test.Name, Error: err.Error()})
						continue
					}
					test.Expected = string(expectedData)
				}
				actual, err := RunShellForVerification(test.Command, tc)
				if err != nil {
					result.Details = append(result.Details, CaseResult{Name: test.Name, Expected: test.Expected, Error: err.Error()})
					continue
				}
				passed := strings.TrimSpace(actual) == strings.TrimSpace(test.Expected)
				result.Details = append(result.Details, CaseResult{
					Name: test.Name, Passed: passed, Expected: test.Expected, Actual: actual,
				})
			}
			for _, detail := range result.Details {
				result.Total++
				if detail.Passed {
					result.Passed++
				} else {
					result.Failed++
				}
			}
			body, _ := json.MarshalIndent(result, "", "  ")
			status := "PASS"
			if !result.Build || result.Failed > 0 {
				status = "FAIL"
			}
			return textResult(fmt.Sprintf("verification: %s\n%s", status, body), map[string]any{
				"verification": result, "artifact": artifact, "sha256": result.SHA256,
				"passed": result.Passed, "failed": result.Failed,
			}), nil
		},
	}
}

func RunShellForVerification(command string, tc types.ToolContext) (string, error) {
	argv, err := ShellCommand(command)
	if err != nil {
		return "", err
	}
	result, err := Run(argv, RunOptions{Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context()})
	if err != nil {
		return strings.TrimSpace(result.Stdout + "\n" + result.Stderr), err
	}
	if result.Code != 0 {
		return strings.TrimSpace(result.Stdout + "\n" + result.Stderr), fmt.Errorf("command exited %d", result.Code)
	}
	return strings.TrimSpace(result.Stdout), nil
}

func parseVerificationCase(values map[string]any) VerificationCase {
	name, _ := values["name"].(string)
	command, _ := values["command"].(string)
	expected, _ := values["expected"].(string)
	input, _ := values["input"].(string)
	expectedFile, _ := values["expectedFile"].(string)
	return VerificationCase{Name: name, Command: command, Input: input, Expected: expected, ExpectedFile: expectedFile}
}

func verificationResult(result VerificationResult, output string, err error) (types.ToolResult, error) {
	result.Failed = 1
	result.Total = 1
	detail := CaseResult{Name: "build", Error: err.Error(), Actual: output}
	result.Details = append(result.Details, detail)
	body, _ := json.MarshalIndent(result, "", "  ")
	return textResult("verification: FAIL\n"+string(body), map[string]any{"verification": result, "build": false}), nil
}
