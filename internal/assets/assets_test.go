package assets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultRolePromptFallbacksAreEmbedded(t *testing.T) {
	for _, role := range []string{"system", "roles/planner", "roles/executor", "roles/researcher"} {
		doc := DefaultPrompt(role)
		if doc.Source != "embedded" {
			t.Fatalf("expected embedded %s prompt, got %s", role, doc.Source)
		}
		if strings.TrimSpace(doc.Text) == "" {
			t.Fatalf("empty embedded prompt for %s", role)
		}
	}
}

func TestEmbeddedSkillsMatchDiskSkillsDirectory(t *testing.T) {
	emb := EmbeddedSkills()
	if len(emb) == 0 {
		t.Fatal("expected embedded skills to be non-empty")
	}
	if dir := SkillsDir(); dir != "" {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			if _, statErr := os.Stat(filepath.Join(dir, entry.Name(), "SKILL.md")); statErr == nil {
				if _, ok := emb[entry.Name()]; !ok {
					t.Fatalf("skill %q exists on disk but is missing from EmbeddedSkills()", entry.Name())
				}
			}
		}
	}
}

func TestReadSkillFileReadsCompanionScripts(t *testing.T) {
	files := ListSkillFiles("unicorn-emulator")
	if len(files) == 0 {
		t.Fatal("expected companion files for unicorn-emulator")
	}
	body, _, err := ReadSkillFile("unicorn-emulator", "scripts/arm64_emulator.py")
	if err != nil || !strings.Contains(body, "Unicorn") {
		t.Fatalf("failed to read companion script: err=%v len=%d", err, len(body))
	}
	if _, _, err := ReadSkillFile("unicorn-emulator", "../../go.mod"); err == nil {
		t.Fatal("expected path traversal outside skill directory to fail")
	}
}
