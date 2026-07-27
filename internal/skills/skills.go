// Package skills loads the project-local reverse engineering workflows from
// skills/<name>/SKILL.md (falling back to the copies embedded in the binary).
package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/overkazaf/re-agent/internal/assets"
	"github.com/overkazaf/re-agent/internal/util"
)

type Skill struct {
	Name        string
	Description string
	Path        string
	Body        string
	Tags        []string
}

// Load reads every skill directory. Missing or unreadable skills are skipped
// rather than fatal.
func Load() []Skill {
	return loadFrom(assets.SkillsDir(), assets.EmbeddedSkills())
}

func loadFrom(dir string, embedded map[string]string) []Skill {
	byName := map[string]Skill{}
	for name, body := range embedded {
		skill := parse(name, "embedded:skills/"+name+"/SKILL.md", body)
		byName[strings.ToLower(skill.Name)] = skill
	}
	if dir != "" {
		entries, err := os.ReadDir(dir)
		if err == nil {
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				skillPath := filepath.Join(dir, entry.Name(), "SKILL.md")
				data, err := os.ReadFile(skillPath)
				if err != nil {
					continue
				}
				skill := parse(entry.Name(), skillPath, string(data))
				byName[strings.ToLower(skill.Name)] = skill
			}
		}
	}
	out := make([]Skill, 0, len(byName))
	for _, skill := range byName {
		out = append(out, skill)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	return out
}

func parse(dirName, path, body string) Skill {
	metadata := parseFrontmatter(body)
	name := metadata["name"]
	if name == "" {
		name = dirName
	}
	description := metadata["description"]
	if description == "" {
		description = firstHeading(body)
	}
	if description == "" {
		description = "Built-in reverse engineering workflow."
	}
	tagSource := metadata["tags"]
	if tagSource == "" {
		tagSource = dirName
	}
	return Skill{Name: name, Description: description, Path: path, Body: body, Tags: splitTags(tagSource)}
}

func Find(list []Skill, name string) *Skill {
	needle := strings.ToLower(name)
	for i := range list {
		if strings.ToLower(list[i].Name) == needle {
			return &list[i]
		}
		for _, tag := range list[i].Tags {
			if strings.ToLower(tag) == needle {
				return &list[i]
			}
		}
	}
	return nil
}

func FormatList(list []Skill) string {
	if len(list) == 0 {
		return "No built-in skills found."
	}
	rows := make([]string, 0, len(list))
	for _, skill := range list {
		rows = append(rows, fmt.Sprintf("%-18s %s", skill.Name, skill.Description))
	}
	return strings.Join(rows, "\n")
}

// SystemPrompt is the catalog appended to the agent's system prompt.
func SystemPrompt(list []Skill) string {
	if len(list) == 0 {
		return ""
	}
	catalog := make([]string, 0, len(list))
	for _, skill := range list {
		tags := ""
		if len(skill.Tags) > 0 {
			tags = " Tags: " + strings.Join(skill.Tags, ", ")
		}
		catalog = append(catalog, fmt.Sprintf("- %s: %s%s", skill.Name, skill.Description, tags))
	}
	return strings.Join([]string{
		"",
		"## Built-in 0xAF-Re Skills",
		"",
		"The host has project-local reverse engineering skills. Use them when a task matches their scope.",
		"Ask for `read_skill` when you need full instructions; use `list_skills` to inspect the catalog.",
		"Operators can run `/skills` to list them or `/skill <name> <task>` to force one workflow for a turn.",
		"",
		strings.Join(catalog, "\n"),
	}, "\n")
}

// TurnPrompt forces one skill's workflow for a single turn.
func TurnPrompt(skill Skill, task string) string {
	return strings.Join([]string{
		"Use built-in skill: " + skill.Name,
		"",
		util.Clip(skill.Body, turnPromptSkillLimit),
		"",
		"Task:",
		strings.TrimSpace(task),
	}, "\n")
}

const turnPromptSkillLimit = 32_000

var (
	frontmatterRE = regexp.MustCompile(`^([A-Za-z0-9_-]+):\s*(.*)$`)
	headingRE     = regexp.MustCompile(`(?m)^#\s+(.+)$`)
	tagSplitRE    = regexp.MustCompile(`[,\s]+`)
)

func parseFrontmatter(body string) map[string]string {
	out := map[string]string{}
	if !strings.HasPrefix(body, "---\n") {
		return out
	}
	end := strings.Index(body[4:], "\n---")
	if end < 0 {
		return out
	}
	for _, line := range util.Lines(body[4 : 4+end]) {
		match := frontmatterRE.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		out[match[1]] = strings.TrimSpace(strings.Trim(match[2], `"'`))
	}
	return out
}

func firstHeading(body string) string {
	match := headingRE.FindStringSubmatch(body)
	if match == nil {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func splitTags(value string) []string {
	var out []string
	for _, tag := range tagSplitRE.Split(value, -1) {
		if trimmed := strings.TrimSpace(tag); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
