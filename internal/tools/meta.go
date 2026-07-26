package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/overkazaf/re-agent/internal/knowledge"
	"github.com/overkazaf/re-agent/internal/plan"
	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/skills"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

// --- frida hook scaffolds ----------------------------------------------------

func fridaHookTemplateTool() types.Tool {
	return types.Tool{
		Name:        "frida_hook_template",
		Description: "Generate a Frida hook scaffold for Android Java, Android native export/address, or iOS Objective-C targets. Writes only when outputPath is provided and --write is enabled.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"platform":     map[string]any{"type": "string", "enum": []string{"android_java", "android_native", "ios_objc"}, "default": "android_java"},
			"target":       map[string]any{"type": "string", "description": "Class name, module!export, module+offset, or ObjC class."},
			"method":       map[string]any{"type": "string", "description": "Method name for Java/ObjC targets."},
			"signature":    map[string]any{"type": "string", "description": "Optional comma-separated Java overload types."},
			"includeStack": map[string]any{"type": "boolean", "default": true},
			"outputPath":   map[string]any{"type": "string", "description": "Optional workspace-relative path to write the hook script."},
		}, "target"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			platform := util.AsString(args["platform"], "android_java")
			script, err := generateFridaHook(
				platform,
				util.AsString(args["target"]),
				util.AsString(args["method"]),
				util.AsString(args["signature"]),
				util.AsBool(args["includeStack"], true),
			)
			if err != nil {
				return types.ToolResult{}, err
			}
			outputPath := strings.TrimSpace(util.AsString(args["outputPath"]))
			if outputPath == "" {
				return textResult(script, nil), nil
			}
			if err := security.ValidateWriteAllowed(tc.Policy); err != nil {
				return types.ToolResult{}, err
			}
			target, err := util.ResolveInside(tc.Workspace, outputPath)
			if err != nil {
				return types.ToolResult{}, err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return types.ToolResult{}, err
			}
			if err := os.WriteFile(target, []byte(script), 0o644); err != nil {
				return types.ToolResult{}, err
			}
			return textResult(fmt.Sprintf("Wrote %s\n\n%s", relative(tc.Workspace, target), script), nil), nil
		},
	}
}

func generateFridaHook(platform, target, method, signature string, includeStack bool) (string, error) {
	switch platform {
	case "android_native":
		return androidNativeHook(target)
	case "ios_objc":
		return iosObjcHook(target, method)
	default:
		return androidJavaHook(target, method, signature, includeStack)
	}
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func androidJavaHook(className, method, signature string, includeStack bool) (string, error) {
	if className == "" || method == "" {
		return "", fmt.Errorf("android_java requires target=<class> and method=<method>")
	}
	overload := ""
	if signature != "" {
		var parts []string
		for _, part := range strings.Split(signature, ",") {
			parts = append(parts, jsonString(strings.TrimSpace(part)))
		}
		overload = fmt.Sprintf(".overload(%s)", strings.Join(parts, ", "))
	}
	overloads := fmt.Sprintf("Target[%s].overloads", jsonString(method))
	if overload != "" {
		overloads = fmt.Sprintf("[Target[%s]%s]", jsonString(method), overload)
	}
	stack := ""
	if includeStack {
		stack = strings.Join([]string{
			`      const Log = Java.use("android.util.Log");`,
			`      const Exception = Java.use("java.lang.Exception");`,
			`      console.log(Log.getStackTraceString(Exception.$new()));`,
		}, "\n")
	}
	lines := []string{
		"Java.perform(function () {",
		fmt.Sprintf("  const Target = Java.use(%s);", jsonString(className)),
		fmt.Sprintf("  const overloads = %s;", overloads),
		"  overloads.forEach(function (overload) {",
		"    overload.implementation = function () {",
		fmt.Sprintf(`      console.log("[+] %s.%s called");`, className, method),
		"      for (let i = 0; i < arguments.length; i++) console.log('  arg' + i + ':', arguments[i]);",
		stack,
		"      const ret = overload.apply(this, arguments);",
		"      console.log('  ret:', ret);",
		"      return ret;",
		"    };",
		"  });",
		"});",
	}
	return strings.Join(nonEmpty(lines), "\n"), nil
}

var (
	exportRE = regexp.MustCompile(`^([^!+]+)!([^!+]+)$`)
	offsetRE = regexp.MustCompile(`^([^!+]+)\+(.+)$`)
)

func androidNativeHook(target string) (string, error) {
	if target == "" {
		return "", fmt.Errorf("android_native requires target=lib.so!export or lib.so+0xoffset")
	}
	var addressExpr string
	switch {
	case exportRE.MatchString(target):
		match := exportRE.FindStringSubmatch(target)
		addressExpr = fmt.Sprintf("Module.findExportByName(%s, %s)", jsonString(match[1]), jsonString(match[2]))
	case offsetRE.MatchString(target):
		match := offsetRE.FindStringSubmatch(target)
		addressExpr = fmt.Sprintf("Module.findBaseAddress(%s).add(%s)", jsonString(match[1]), match[2])
	default:
		addressExpr = fmt.Sprintf("Module.findExportByName(null, %s)", jsonString(target))
	}
	return strings.Join([]string{
		fmt.Sprintf("const target = %s;", addressExpr),
		"if (target === null) throw new Error('target not found');",
		"Interceptor.attach(target, {",
		"  onEnter(args) {",
		fmt.Sprintf(`    console.log("[+] native %s enter");`, target),
		"    for (let i = 0; i < 6; i++) console.log('  arg' + i + ':', args[i]);",
		"  },",
		"  onLeave(retval) {",
		"    console.log('  ret:', retval);",
		"  }",
		"});",
	}, "\n"), nil
}

func iosObjcHook(className, method string) (string, error) {
	if className == "" || method == "" {
		return "", fmt.Errorf("ios_objc requires target=<ObjCClass> and method=<selector>")
	}
	return strings.Join([]string{
		fmt.Sprintf("const cls = ObjC.classes[%s];", jsonString(className)),
		"if (!cls) throw new Error('class not found');",
		fmt.Sprintf("const impl = cls[%s].implementation;", jsonString(method)),
		"Interceptor.attach(impl, {",
		"  onEnter(args) {",
		fmt.Sprintf(`    console.log("[+] %s %s");`, className, method),
		"    console.log('  self:', new ObjC.Object(args[0]));",
		"    console.log('  selector:', ObjC.selectorAsString(args[1]));",
		"  },",
		"  onLeave(retval) {",
		"    console.log('  ret:', retval);",
		"  }",
		"});",
	}, "\n"), nil
}

func nonEmpty(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// --- skills ------------------------------------------------------------------

func listSkillsTool() types.Tool {
	return types.Tool{
		Name:        "list_skills",
		Description: "List project-local built-in reverse engineering skills available to this agent.",
		Risk:        types.RiskRead,
		Parameters:  objectSchema(map[string]any{}),
		Execute: func(map[string]any, types.ToolContext) (types.ToolResult, error) {
			list := skills.Load()
			return textResult(skills.FormatList(list), map[string]any{"count": len(list)}), nil
		},
	}
}

func readSkillTool() types.Tool {
	return types.Tool{
		Name:        "read_skill",
		Description: "Read one project-local built-in skill by name or tag.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"name": map[string]any{"type": "string", "description": "Skill name or tag."},
		}, "name"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			name := util.AsString(args["name"])
			skill := skills.Find(skills.Load(), name)
			if skill == nil {
				return errorResult("Skill not found: " + name), nil
			}
			return textResult(util.Clip(skill.Body, tc.Policy.MaxReadBytes),
				map[string]any{"name": skill.Name, "path": skill.Path}), nil
		},
	}
}

// --- knowledge ---------------------------------------------------------------

func knowledgeSearchTool() types.Tool {
	return types.Tool{
		Name: "knowledge_search",
		Description: "Search the local reverse-engineering knowledge index and return an agent-ready digest. " +
			"After calling it, synthesize a structured answer with conclusion, steps, pitfalls, and cited entry ids instead of dumping raw hits.",
		Risk: types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"query": map[string]any{"type": "string", "description": "Search terms, e.g. frida ssl pinning, wasm crypto, unidbg jni."},
			"limit": map[string]any{"type": "number", "default": 8},
			"raw":   map[string]any{"type": "boolean", "default": false, "description": "Return the old raw hit list for debugging instead of the structured digest."},
		}, "query"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			query := util.AsString(args["query"])
			matches := knowledge.Search(query, util.AsInt(args["limit"], 8))
			raw := util.AsBool(args["raw"], false)
			mode := "digest"
			text := knowledge.FormatDigest(query, matches)
			if raw {
				mode = "raw"
				text = knowledge.FormatMatches(matches)
			}
			return textResult(util.Clip(text, tc.Policy.MaxReadBytes),
				map[string]any{"count": len(matches), "mode": mode}), nil
		},
	}
}

func knowledgeReadTool() types.Tool {
	return types.Tool{
		Name:        "knowledge_read",
		Description: "Read one entry from the local reverse-engineering knowledge index by id.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"id":       map[string]any{"type": "string", "description": "Knowledge entry id from knowledge_search."},
			"maxBytes": map[string]any{"type": "number", "default": 24000},
		}, "id"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			id := util.AsString(args["id"])
			entry := knowledge.ReadEntry(id)
			if entry == nil {
				return errorResult("Knowledge entry not found: " + id), nil
			}
			maxBytes := util.AsInt(args["maxBytes"], 24_000)
			if maxBytes > tc.Policy.MaxReadBytes {
				maxBytes = tc.Policy.MaxReadBytes
			}
			text := knowledge.ReadText(*entry, maxBytes)
			return textResult(fmt.Sprintf("# %s\n\nsource: %s\n\n%s", entry.Title, entry.Path, text),
				map[string]any{"id": entry.ID, "path": entry.Path}), nil
		},
	}
}

// --- task list ---------------------------------------------------------------

var planMarkers = map[types.PlanStepStatus]string{
	types.StepPending:    "[ ]",
	types.StepInProgress: "[~]",
	types.StepCompleted:  "[x]",
}

func updatePlanTool() types.Tool {
	return types.Tool{
		Name: "update_plan",
		Description: "Publish or update the task list the operator sees. Call it once up front for any multi-step task, " +
			"then again whenever a step changes status. Always send the whole list, not a delta.",
		Risk: types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"plan": map[string]any{
				"type":        "array",
				"description": "The complete ordered step list.",
				"items": objectSchema(map[string]any{
					"step":   map[string]any{"type": "string", "description": "Short imperative description of the step."},
					"status": map[string]any{"type": "string", "enum": []string{"pending", "in_progress", "completed"}, "description": "Keep at most one step in_progress."},
				}, "step", "status"),
			},
			"explanation": map[string]any{"type": "string", "description": "Optional one-line reason for this update."},
		}, "plan"),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			steps := coercePlanSteps(args["plan"])
			if len(steps) == 0 {
				return errorResult("update_plan requires at least one step with non-empty text."), nil
			}
			explanation := strings.TrimSpace(util.AsString(args["explanation"]))
			if tc.OnPlan != nil {
				tc.OnPlan(steps, types.PlanUpdateMeta{Source: "update_plan", Note: explanation})
			}
			done, total := plan.Counts(&types.PlanSnapshot{Steps: steps, Source: "update_plan", Note: explanation, UpdatedAt: types.NowMs()})
			rows := make([]string, 0, len(steps))
			for _, step := range steps {
				rows = append(rows, fmt.Sprintf("%s %s", planMarkers[step.Status], step.Text))
			}
			return textResult(fmt.Sprintf("Plan updated: %d/%d done\n%s", done, total, strings.Join(rows, "\n")),
				map[string]any{"total": total, "done": done}), nil
		},
	}
}

// The model owns this payload, so every field is untrusted: drop stepless
// entries and fall back to "pending" for anything that is not a known status.
func coercePlanSteps(value any) []types.PlanStep {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	var out []types.PlanStep
	for _, entry := range items {
		// Models routinely flatten a task list to bare strings; accept that
		// rather than reject the whole plan over a schema detail.
		if text, ok := entry.(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				out = append(out, types.PlanStep{Text: trimmed, Status: types.StepPending})
			}
			continue
		}
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		text := strings.TrimSpace(util.AsString(record["step"]))
		if text == "" {
			continue
		}
		status := types.StepPending
		if candidate := util.AsString(record["status"]); types.IsPlanStatus(candidate) {
			status = types.PlanStepStatus(candidate)
		}
		out = append(out, types.PlanStep{Text: text, Status: status})
	}
	return out
}
