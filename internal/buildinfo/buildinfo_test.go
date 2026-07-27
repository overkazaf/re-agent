package buildinfo

import "testing"

func TestShortCommit(t *testing.T) {
	got := ShortCommit("af32e97f43d2f64cca381df8f43f937571e5c2bb")
	if got != "af32e97f43d2" {
		t.Fatalf("ShortCommit() = %q", got)
	}
}

func TestCommitFromModuleVersion(t *testing.T) {
	got := commitFromModuleVersion("v0.0.0-20260728030000-af32e97f43d2")
	if got != "af32e97f43d2" {
		t.Fatalf("commitFromModuleVersion() = %q", got)
	}
}

func TestCommitFromModuleVersionIgnoresDevel(t *testing.T) {
	if got := commitFromModuleVersion("(devel)"); got != "" {
		t.Fatalf("commitFromModuleVersion((devel)) = %q", got)
	}
}
