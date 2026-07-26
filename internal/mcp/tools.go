package mcp

// Wraps MCP server tools as native agent tools so the loop, the approval gate
// and the output budget treat them exactly like the built-in ones.

import (
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/overkazaf/re-agent/internal/tools"
	"github.com/overkazaf/re-agent/internal/types"
)

// maxToolName matches the OpenAI-compatible limit: [A-Za-z0-9_-]{1,64}.
const maxToolName = 64

type Connection struct {
	Name   string
	Client *Client
	Tools  []types.Tool
	Error  string
}

var slugRE = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

func slug(value string) string {
	return strings.Trim(slugRE.ReplaceAllString(value, "_"), "_")
}

func ToolName(server, tool string) string {
	full := "mcp__" + slug(server) + "__" + slug(tool)
	if len(full) <= maxToolName {
		return full
	}
	// Trim the server half first: the tool name is what the model reasons about.
	room := maxToolName - len("mcp____"+slug(tool))
	if room < 1 {
		room = 1
	}
	server = slug(server)
	if len(server) > room {
		server = server[:room]
	}
	name := "mcp__" + server + "__" + slug(tool)
	if len(name) > maxToolName {
		name = name[:maxToolName]
	}
	return name
}

// ConnectAll starts every configured server. A server that fails to start is
// reported, never fatal — an IDA plugin that is not running should not stop a
// session.
func ConnectAll(servers map[string]*types.MCPServerConfig) []Connection {
	names := make([]string, 0, len(servers))
	for name, config := range servers {
		if config == nil || config.Disabled {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]Connection, len(names))
	var wg sync.WaitGroup
	for index, name := range names {
		wg.Add(1)
		go func(index int, name string) {
			defer wg.Done()
			out[index] = connectOne(name, servers[name])
		}(index, name)
	}
	wg.Wait()
	return out
}

func connectOne(name string, config *types.MCPServerConfig) Connection {
	client, err := Connect(name, config)
	if err != nil {
		return Connection{Name: name, Error: err.Error()}
	}
	connection := Connection{Name: name, Client: client}
	for _, tool := range client.Available() {
		connection.Tools = append(connection.Tools, wrap(name, client, tool))
	}
	return connection
}

func wrap(server string, client *Client, tool ToolInfo) types.Tool {
	parameters := tool.InputSchema
	if parameters == nil {
		parameters = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	description := tool.Description
	if description == "" {
		description = tool.Name
	}
	return types.Tool{
		Name:        ToolName(server, tool.Name),
		Description: "[" + server + "] " + description,
		// MCP servers do not declare a tier; treat them as state-changing, which
		// is what the approval modes assume for anything that is not a read.
		Risk:       types.RiskWrite,
		Parameters: parameters,
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			result, err := client.CallTool(tool.Name, args, tc.Context())
			if err != nil {
				return types.ToolResult{}, err
			}
			spilled := tools.SpillIfLarge(types.TextFromBlocks(result.Content), tools.SpillOptions{
				Context: tc, Label: server + "-" + tool.Name,
			})
			content := []types.ContentBlock{types.TextBlock(spilled.Text)}
			for _, block := range result.Content {
				if block.Type == "image" {
					content = append(content, block)
				}
			}
			return types.ToolResult{
				Content: content,
				IsError: result.IsError,
				Details: map[string]any{"server": server, "tool": tool.Name, "artifact": spilled.Artifact},
			}, nil
		},
	}
}

// small string helpers shared with client.go, kept here so client.go stays
// focused on the transport.

func trimSpace(value string) string { return strings.TrimSpace(value) }

func splitLines(value string) []string { return strings.Split(value, "\n") }

func joinWithSpace(values []string) string { return strings.Join(values, " ") }
