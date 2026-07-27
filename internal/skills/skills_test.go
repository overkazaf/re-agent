package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadFromMergesEmbeddedAndDiskSkills(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "old-local", `---
name: old-local
description: local only
---
# Old Local
`)

	list := loadFrom(dir, map[string]string{
		"jadx": `---
name: jadx
description: embedded jadx
---
# JADX
`,
		"radare2-reverse": `---
name: radare2-reverse
description: embedded radare2
---
# Radare2
`,
	})

	if Find(list, "old-local") == nil {
		t.Fatalf("local skill was not loaded: %s", FormatList(list))
	}
	if Find(list, "jadx") == nil || Find(list, "radare2-reverse") == nil {
		t.Fatalf("embedded skills were hidden by a partial local skills dir: %s", FormatList(list))
	}
}

func TestLoadFromLetsDiskOverrideEmbeddedSkill(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "jadx", `---
name: jadx
description: disk jadx
---
# Disk JADX
`)

	list := loadFrom(dir, map[string]string{
		"jadx": `---
name: jadx
description: embedded jadx
---
# Embedded JADX
`,
	})

	skill := Find(list, "jadx")
	if skill == nil {
		t.Fatalf("jadx skill was not loaded")
	}
	if !strings.Contains(skill.Description, "disk jadx") {
		t.Fatalf("expected disk skill to override embedded skill, got: %q", skill.Description)
	}
	if strings.HasPrefix(skill.Path, "embedded:") {
		t.Fatalf("expected disk path, got %s", skill.Path)
	}
}

func writeSkill(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
