package app

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/overkazaf/re-agent/internal/assets"
	skillpkg "github.com/overkazaf/re-agent/internal/skills"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/ui"
)

var editablePromptTargets = []string{"system", "planner", "executor", "researcher"}

var runtimeRolePrompts = []types.AgentRole{
	types.RolePlanner,
	types.RoleExecutor,
	types.RoleResearcher,
}

func buildRuntimeSystemPrompt(skillList []skillpkg.Skill) string {
	return assets.SystemPrompt() + skillpkg.SystemPrompt(skillList)
}

func loadRuntimeRolePrompts() map[types.AgentRole]string {
	out := map[types.AgentRole]string{}
	for _, role := range runtimeRolePrompts {
		out[role] = assets.RolePrompt(string(role)).Text
	}
	return out
}

func reloadRuntimePrompts(state *State) {
	state.Loop.SetPrompts(buildRuntimeSystemPrompt(state.Skills), loadRuntimeRolePrompts())
}

func handlePromptCommand(arg string, state *State) error {
	action, rest := splitFirstToken(arg)
	switch action {
	case "", "list":
		fmt.Println(formatPromptList())
		return nil
	case "show":
		target, err := parsePromptTarget(rest)
		if err != nil {
			return err
		}
		doc := promptDoc(target)
		fmt.Print(doc.Text)
		if !strings.HasSuffix(doc.Text, "\n") {
			fmt.Println()
		}
		return nil
	case "path":
		target, err := parsePromptTarget(rest)
		if err != nil {
			return err
		}
		doc := promptDoc(target)
		fmt.Println(ui.RenderNotice(fmt.Sprintf(
			"%s source=%s active=%s editable=%s",
			target, doc.Source, doc.Path, assets.EditablePromptPath(promptAssetName(target)))))
		return nil
	case "edit":
		target, err := parsePromptTarget(rest)
		if err != nil {
			return err
		}
		path, err := assets.EnsureEditablePrompt(promptAssetName(target))
		if err != nil {
			return err
		}
		if err := openEditor(path); err != nil {
			return err
		}
		reloadRuntimePrompts(state)
		fmt.Println(ui.RenderNotice("prompt reloaded: " + target))
		return nil
	case "set":
		targetText, body := splitFirstToken(rest)
		target, err := parsePromptTarget(targetText)
		if err != nil {
			return err
		}
		body = strings.TrimSpace(body)
		if body == "" {
			return fmt.Errorf("usage: /prompt set <system|planner|executor|researcher> <text>")
		}
		path := assets.EditablePromptPath(promptAssetName(target))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(body+"\n"), 0o600); err != nil {
			return err
		}
		reloadRuntimePrompts(state)
		fmt.Println(ui.RenderNotice("prompt saved and reloaded: " + target))
		return nil
	case "reset":
		target, err := parsePromptTarget(rest)
		if err != nil {
			return err
		}
		path, err := assets.EnsureEditablePrompt(promptAssetName(target))
		if err != nil {
			return err
		}
		seed := embeddedOrFallbackPrompt(target)
		if err := os.WriteFile(path, []byte(strings.TrimRight(seed, "\n")+"\n"), 0o600); err != nil {
			return err
		}
		reloadRuntimePrompts(state)
		fmt.Println(ui.RenderNotice("prompt reset and reloaded: " + target))
		return nil
	case "reload":
		reloadRuntimePrompts(state)
		fmt.Println(ui.RenderNotice("prompts reloaded"))
		return nil
	default:
		return fmt.Errorf("usage: /prompt [list|show|path|edit|set|reset|reload] [system|planner|executor|researcher]")
	}
}

func formatPromptList() string {
	lines := []string{"prompts:"}
	for _, target := range editablePromptTargets {
		doc := promptDoc(target)
		lines = append(lines, fmt.Sprintf(
			"  %-10s %-8s %6d  %s",
			target, doc.Source, len(doc.Text), doc.Path))
	}
	lines = append(lines, "", "edit with: /prompt edit <system|planner|executor|researcher>")
	return strings.Join(lines, "\n")
}

func parsePromptTarget(value string) (string, error) {
	target, _ := splitFirstToken(value)
	switch strings.TrimSpace(target) {
	case "system":
		return "system", nil
	case "planner", "plan":
		return "planner", nil
	case "executor", "exec":
		return "executor", nil
	case "researcher", "research":
		return "researcher", nil
	}
	return "", fmt.Errorf("usage: /prompt <show|path|edit|set|reset> system|planner|executor|researcher")
}

func promptDoc(target string) assets.PromptDoc {
	if target == "system" {
		return assets.Prompt("system")
	}
	return assets.RolePrompt(target)
}

func promptAssetName(target string) string {
	if target == "system" {
		return "system"
	}
	return "roles/" + target
}

func embeddedOrFallbackPrompt(target string) string {
	return assets.DefaultPrompt(promptAssetName(target)).Text
}

func openEditor(path string) error {
	editor := strings.TrimSpace(os.Getenv("VISUAL"))
	if editor == "" {
		editor = strings.TrimSpace(os.Getenv("EDITOR"))
	}
	if editor == "" {
		editor = "vi"
	}
	parts := strings.Fields(editor)
	if len(parts) == 0 {
		return fmt.Errorf("empty EDITOR")
	}
	cmd := exec.Command(parts[0], append(parts[1:], path)...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
