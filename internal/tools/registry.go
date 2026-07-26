// Package tools is the local tool registry: file access, command execution,
// CTF/reverse helpers, and the host-side task list tool. Every tool goes
// through the same approval gate and output budget.
package tools

import "github.com/overkazaf/re-agent/internal/types"

// objectSchema builds a JSON Schema object, the shape every provider expects
// for a tool's parameters.
func objectSchema(properties map[string]any, required ...string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties":           properties,
		"required":             required,
	}
}

// CreateReverseTools returns the built-in registry, in the order the operator
// sees it in `/tools`.
func CreateReverseTools() []types.Tool {
	return []types.Tool{
		listFilesTool(),
		readFileTool(),
		writeFileTool(),
		grepTool(),
		runCommandTool(),
		fileInfoTool(),
		stringsTool(),
		hexdumpTool(),
		hashFileTool(),
		extractSymbolsTool(),
		ctfTriageTool(),
		ctfDecodeTool(),
		entropyScanTool(),
		binaryMitigationsTool(),
		findBytesTool(),
		carveArtifactsTool(),
		reverseToolkitTool(),
		apkInspectTool(),
		fridaHookTemplateTool(),
		listSkillsTool(),
		readSkillTool(),
		knowledgeSearchTool(),
		knowledgeReadTool(),
		updatePlanTool(),
	}
}

// Find looks a tool up by name.
func Find(list []types.Tool, name string) *types.Tool {
	for i := range list {
		if list[i].Name == name {
			return &list[i]
		}
	}
	return nil
}

func textResult(text string, details any) types.ToolResult {
	return types.ToolResult{Content: []types.ContentBlock{types.TextBlock(text)}, Details: details}
}

func errorResult(text string) types.ToolResult {
	return types.ToolResult{Content: []types.ContentBlock{types.TextBlock(text)}, IsError: true}
}
