package tools

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

func listFilesTool() types.Tool {
	return types.Tool{
		Name:        "list_files",
		Description: "List files under the workspace, optionally recursively. Useful for CTF artifact triage.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":       map[string]any{"type": "string", "description": "Workspace-relative directory path.", "default": "."},
			"recursive":  map[string]any{"type": "boolean", "default": false},
			"maxEntries": map[string]any{"type": "number", "default": 200},
		}),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			root, err := util.ResolveInside(tc.Workspace, util.AsString(args["path"], "."))
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := security.ValidatePathRead(root, tc.Policy); err != nil {
				return types.ToolResult{}, err
			}
			recursive := util.AsBool(args["recursive"], false)
			maxEntries := util.AsInt(args["maxEntries"], 200)
			var entries []string
			walkTree(root, tc.Workspace, recursive, maxEntries, &entries)
			body := strings.Join(entries, "\n")
			if body == "" {
				body = "(empty)"
			}
			return textResult(body, map[string]any{"count": len(entries)}), nil
		},
	}
}

func readFileTool() types.Tool {
	return types.Tool{
		Name:        "read_file",
		Description: "Read a workspace file as UTF-8 text with truncation. For binary files use hexdump or strings.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":     map[string]any{"type": "string", "description": "Workspace-relative file path."},
			"maxBytes": map[string]any{"type": "number", "default": 65536},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := util.ResolveInside(tc.Workspace, util.AsString(args["path"]))
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := security.ValidatePathRead(target, tc.Policy); err != nil {
				return types.ToolResult{}, err
			}
			maxBytes := util.AsInt(args["maxBytes"], tc.Policy.MaxReadBytes)
			if maxBytes > tc.Policy.MaxReadBytes {
				maxBytes = tc.Policy.MaxReadBytes
			}
			info, err := os.Stat(target)
			if err != nil {
				return types.ToolResult{}, err
			}
			data, err := readPrefix(target, int(min64(info.Size(), int64(maxBytes))))
			if err != nil {
				return types.ToolResult{}, err
			}
			suffix := ""
			if info.Size() > int64(len(data)) {
				suffix = fmt.Sprintf("\n\n[truncated: %d bytes remain]", info.Size()-int64(len(data)))
			}
			return textResult(string(data)+suffix, map[string]any{"bytesRead": len(data), "size": info.Size()}), nil
		},
	}
}

func writeFileTool() types.Tool {
	return types.Tool{
		Name:        "write_file",
		Description: "Write a workspace file. Disabled unless the CLI is started with --write.",
		Risk:        types.RiskWrite,
		Parameters: objectSchema(map[string]any{
			"path":    map[string]any{"type": "string", "description": "Workspace-relative file path."},
			"content": map[string]any{"type": "string", "description": "Content to write."},
		}, "path", "content"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			if err := security.ValidateWriteAllowed(tc.Policy); err != nil {
				return types.ToolResult{}, err
			}
			target, err := util.ResolveInside(tc.Workspace, util.AsString(args["path"]))
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return types.ToolResult{}, err
			}
			content := util.AsString(args["content"])
			if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
				return types.ToolResult{}, err
			}
			return textResult(fmt.Sprintf("Wrote %d bytes to %s", len(content), relative(tc.Workspace, target)), nil), nil
		},
	}
}

func grepTool() types.Tool {
	return types.Tool{
		Name:        "grep",
		Description: "Search text files using ripgrep when available. Falls back to a simple recursive scan.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"pattern":    map[string]any{"type": "string", "description": "Regex or literal pattern."},
			"path":       map[string]any{"type": "string", "default": "."},
			"maxMatches": map[string]any{"type": "number", "default": 200},
		}, "pattern"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			searchRoot, err := util.ResolveInside(tc.Workspace, util.AsString(args["path"], "."))
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := security.ValidatePathRead(searchRoot, tc.Policy); err != nil {
				return types.ToolResult{}, err
			}
			pattern := util.AsString(args["pattern"])
			maxMatches := util.AsInt(args["maxMatches"], 200)
			rg, rgErr := Run([]string{
				"rg", "--line-number", "--hidden", "--glob", "!.git",
				"--max-count", strconv.Itoa(maxMatches), pattern, searchRoot,
			}, RunOptions{Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context()})
			if rgErr == nil {
				output := rg.Stdout
				if output == "" {
					output = rg.Stderr
				}
				if output == "" {
					output = "(no matches)"
				}
				spilled := SpillIfLarge(output, SpillOptions{Context: tc, Label: "grep-" + pattern})
				return textResult(spilled.Text, map[string]any{"engine": "rg", "exit": rg.Code, "artifact": spilled.Artifact}), nil
			}
			matches, err := goGrep(searchRoot, tc.Workspace, pattern, maxMatches)
			if err != nil {
				return types.ToolResult{}, err
			}
			body := strings.Join(matches, "\n")
			if body == "" {
				body = "(no matches)"
			}
			return textResult(body, map[string]any{"engine": "go", "count": len(matches)}), nil
		},
	}
}

func runCommandTool() types.Tool {
	return types.Tool{
		Name:        "run_command",
		Description: "Run a local workspace command for CTF/reverse engineering. Network and destructive commands are blocked by default.",
		Risk:        types.RiskExecute,
		Parameters: objectSchema(map[string]any{
			"command":   map[string]any{"type": "string", "description": "Shell command to run in the workspace."},
			"timeoutMs": map[string]any{"type": "number", "default": 30000},
		}, "command"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			command := util.AsString(args["command"])
			// The tier gate already ran in the loop; this is the command-specific
			// pass, where a safety pattern turns into a prompt instead of a flat
			// refusal.
			concerns, err := security.CommandConcerns(command, tc.Policy)
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := security.RequestApproval(types.ApprovalRequest{
				Tool: "run_command", Tier: types.TierExec, Summary: command, Concerns: concerns,
			}, tc); err != nil {
				return types.ToolResult{}, err
			}
			timeoutMs := util.AsInt(args["timeoutMs"], tc.Policy.CommandTimeoutMs)
			if timeoutMs > tc.Policy.CommandTimeoutMs {
				timeoutMs = tc.Policy.CommandTimeoutMs
			}
			argv, err := ShellCommand(command)
			if err != nil {
				return types.ToolResult{}, err
			}
			result, err := Run(argv, RunOptions{
				Cwd: tc.Workspace, TimeoutMs: timeoutMs, Ctx: tc.Context(),
			})
			if err != nil {
				return types.ToolResult{}, err
			}
			// Unbounded here would be a context-eater: `objdump -d` on a real
			// binary is megabytes. Keep head+tail, park the rest in an artifact.
			spilled := SpillIfLarge(CommandText(command, result), SpillOptions{Context: tc, Label: command})
			return textResult(spilled.Text, map[string]any{
				"exit": result.Code, "chars": spilled.OriginalChars, "artifact": spilled.Artifact,
			}), nil
		},
	}
}

func fileInfoTool() types.Tool {
	return types.Tool{
		Name:        "file_info",
		Description: "Run file(1) on a workspace artifact.",
		Risk:        types.RiskRead,
		Parameters:  objectSchema(map[string]any{"path": map[string]any{"type": "string"}}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			result, err := Run([]string{"file", "-b", target}, RunOptions{
				Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context(),
			})
			if err != nil {
				return types.ToolResult{}, err
			}
			return types.ToolResult{
				Content: CommandOutput("file "+relative(tc.Workspace, target), result),
				Details: map[string]any{"exit": result.Code},
			}, nil
		},
	}
}

func stringsTool() types.Tool {
	return types.Tool{
		Name:        "strings",
		Description: "Extract printable strings from a binary artifact.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":      map[string]any{"type": "string"},
			"minLength": map[string]any{"type": "number", "default": 4},
			"maxBytes":  map[string]any{"type": "number", "default": 65536},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			minLength := util.AsInt(args["minLength"], 4)
			if minLength < 3 {
				minLength = 3
			}
			result, runErr := Run([]string{"strings", "-a", "-n", strconv.Itoa(minLength), target}, RunOptions{
				Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context(),
			})
			output := ""
			if runErr == nil {
				output = result.Stdout
				if output == "" {
					output = result.Stderr
				}
			} else {
				// No strings(1) here: the in-process extractor covers the same
				// ground for the sizes this tool is used on.
				data, readErr := readPrefix(target, tc.Policy.MaxReadBytes)
				if readErr != nil {
					return types.ToolResult{}, readErr
				}
				output = strings.Join(extractPrintableStrings(data, minLength), "\n")
			}
			if output == "" {
				output = "(no strings)"
			}
			maxChars := util.AsInt(args["maxBytes"], tc.Policy.MaxToolOutputChars)
			if maxChars > tc.Policy.MaxReadBytes {
				maxChars = tc.Policy.MaxReadBytes
			}
			spilled := SpillIfLarge(output, SpillOptions{
				Context: tc, Label: "strings-" + filepath.Base(target), MaxChars: maxChars,
			})
			return textResult(spilled.Text, map[string]any{"exit": result.Code, "artifact": spilled.Artifact}), nil
		},
	}
}

func hexdumpTool() types.Tool {
	return types.Tool{
		Name:        "hexdump",
		Description: "Show a hex dump from a workspace file.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":   map[string]any{"type": "string"},
			"offset": map[string]any{"type": "number", "default": 0},
			"length": map[string]any{"type": "number", "default": 512},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			offset := util.AsInt(args["offset"], 0)
			if offset < 0 {
				offset = 0
			}
			length := clampInt(util.AsInt(args["length"], 512), 1, 4096)
			options := RunOptions{Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context()}
			result, err := Run([]string{
				"xxd", "-g", "1", "-s", strconv.Itoa(offset), "-l", strconv.Itoa(length), target,
			}, options)
			if err != nil || result.Code != 0 {
				fallback, fallbackErr := Run([]string{
					"od", "-Ax", "-tx1", "-N", strconv.Itoa(length), "-j", strconv.Itoa(offset), target,
				}, options)
				if fallbackErr == nil && fallback.Code == 0 {
					result = fallback
				} else if err != nil {
					// Neither tool is installed: dump in process.
					data, readErr := readRange(target, int64(offset), length)
					if readErr != nil {
						return types.ToolResult{}, readErr
					}
					return textResult(hexdumpText(data, offset), map[string]any{"offset": offset, "length": length}), nil
				}
			}
			return types.ToolResult{
				Content: CommandOutput("hexdump "+relative(tc.Workspace, target), result),
				Details: map[string]any{"exit": result.Code, "offset": offset, "length": length},
			}, nil
		},
	}
}

func hashFileTool() types.Tool {
	return types.Tool{
		Name:        "hash_file",
		Description: "Calculate SHA-256 and size for a workspace file.",
		Risk:        types.RiskRead,
		Parameters:  objectSchema(map[string]any{"path": map[string]any{"type": "string"}}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			data, err := os.ReadFile(target)
			if err != nil {
				return types.ToolResult{}, err
			}
			sum := sha256.Sum256(data)
			digest := hex.EncodeToString(sum[:])
			return textResult(
				fmt.Sprintf("sha256  %s\nsize    %d", digest, len(data)),
				map[string]any{"sha256": digest, "size": len(data)},
			), nil
		},
	}
}

func extractSymbolsTool() types.Tool {
	return types.Tool{
		Name:        "extract_symbols",
		Description: "Try common symbol/import table tools: nm, readelf, objdump, and otool.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"path":     map[string]any{"type": "string"},
			"maxBytes": map[string]any{"type": "number", "default": 65536},
		}, "path"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			target, err := resolveReadable(args, tc)
			if err != nil {
				return types.ToolResult{}, err
			}
			rel := relative(tc.Workspace, target)
			attempts := [][]string{
				{"nm", "-an", target},
				{"readelf", "-Ws", target},
				{"objdump", "-t", target},
				{"otool", "-Iv", target},
			}
			labels := []string{"nm -an " + rel, "readelf -Ws " + rel, "objdump -t " + rel, "otool -Iv " + rel}
			var chunks []string
			for i, command := range attempts {
				result, err := Run(command, RunOptions{
					Cwd: tc.Workspace, TimeoutMs: tc.Policy.CommandTimeoutMs, Ctx: tc.Context(),
				})
				if err != nil {
					continue
				}
				if strings.TrimSpace(result.Stdout) != "" {
					chunks = append(chunks, fmt.Sprintf("$ %s\n%s", labels[i], result.Stdout))
				}
			}
			body := strings.Join(chunks, "\n\n")
			if body == "" {
				body = "No symbols/imports extracted by available tools."
			}
			maxChars := util.AsInt(args["maxBytes"], tc.Policy.MaxToolOutputChars)
			if maxChars > tc.Policy.MaxReadBytes {
				maxChars = tc.Policy.MaxReadBytes
			}
			spilled := SpillIfLarge(body, SpillOptions{
				Context: tc, Label: "symbols-" + filepath.Base(target), MaxChars: maxChars,
			})
			return textResult(spilled.Text, map[string]any{"artifact": spilled.Artifact}), nil
		},
	}
}

// --- helpers -----------------------------------------------------------------

func resolveReadable(args map[string]any, tc types.ToolContext) (string, error) {
	target, err := util.ResolveInside(tc.Workspace, util.AsString(args["path"]))
	if err != nil {
		return "", err
	}
	if err := security.ValidatePathRead(target, tc.Policy); err != nil {
		return "", err
	}
	return target, nil
}

func relative(workspace, target string) string {
	rel, err := filepath.Rel(workspace, target)
	if err != nil {
		return target
	}
	return rel
}

func readPrefix(file string, length int) ([]byte, error) {
	if length <= 0 {
		return nil, nil
	}
	return readRange(file, 0, length)
}

func readRange(file string, offset int64, length int) ([]byte, error) {
	handle, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	if offset > 0 {
		if _, err := handle.Seek(offset, io.SeekStart); err != nil {
			return nil, err
		}
	}
	buffer := make([]byte, length)
	read, err := io.ReadFull(handle, buffer)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, err
	}
	return buffer[:read], nil
}

func hexdumpText(data []byte, offset int) string {
	var out strings.Builder
	for i := 0; i < len(data); i += 16 {
		end := i + 16
		if end > len(data) {
			end = len(data)
		}
		chunk := data[i:end]
		fmt.Fprintf(&out, "%08x: ", offset+i)
		for j := 0; j < 16; j++ {
			if j < len(chunk) {
				fmt.Fprintf(&out, "%02x ", chunk[j])
			} else {
				out.WriteString("   ")
			}
		}
		fmt.Fprintf(&out, " %s\n", asciiPreview(chunk))
	}
	return out.String()
}

func walkTree(dir, workspace string, recursive bool, max int, out *[]string) {
	if len(*out) >= max {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if len(*out) >= max {
			return
		}
		if entry.Name() == ".git" || entry.Name() == "node_modules" {
			continue
		}
		full := filepath.Join(dir, entry.Name())
		marker := "-"
		if entry.IsDir() {
			marker = "d"
		}
		*out = append(*out, fmt.Sprintf("%s %s", marker, relative(workspace, full)))
		if recursive && entry.IsDir() {
			walkTree(full, workspace, recursive, max, out)
		}
	}
}

func goGrep(root, workspace, pattern string, maxMatches int) ([]string, error) {
	regex, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		return nil, err
	}
	var out []string
	var visit func(target string) error
	visit = func(target string) error {
		if len(out) >= maxMatches {
			return nil
		}
		info, err := os.Stat(target)
		if err != nil {
			return nil
		}
		if info.IsDir() {
			entries, err := os.ReadDir(target)
			if err != nil {
				return nil
			}
			for _, entry := range entries {
				if entry.Name() == ".git" || entry.Name() == "node_modules" {
					continue
				}
				if err := visit(filepath.Join(target, entry.Name())); err != nil {
					return err
				}
			}
			return nil
		}
		if info.Size() > 1024*1024 {
			return nil
		}
		data, err := os.ReadFile(target)
		if err != nil {
			return nil
		}
		for index, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
			if len(out) >= maxMatches {
				return nil
			}
			if regex.MatchString(line) {
				out = append(out, fmt.Sprintf("%s:%d:%s", relative(workspace, target), index+1, line))
			}
		}
		return nil
	}
	if err := visit(root); err != nil {
		return nil, err
	}
	return out, nil
}

func clampInt(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
