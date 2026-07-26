package knowledge

import (
	"strings"
	"testing"
)

func entries() []Entry {
	return []Entry{
		{ID: "android/frida-ssl", Title: "Frida SSL pinning", Tags: []string{"frida", "ssl"}, Summary: "bypass pinning"},
		{ID: "web/wasm-crypto", Title: "WASM crypto", Tags: []string{"wasm"}, Summary: "trace exports"},
	}
}

func TestParseAnswerHappyPath(t *testing.T) {
	reply := strings.Join([]string{
		"### 结论",
		"Hook the pinning check directly.",
		"### 步骤",
		"1. attach with frida",
		"2. replace checkServerTrusted",
		"### 坑",
		"- some apps pin in native code",
		"### 出处",
		"[android/frida-ssl]",
	}, "\n")
	answer := ParseAnswer(reply, entries())
	if !answer.Parsed {
		t.Fatal("a well-formed reply must parse")
	}
	if answer.Conclusion != "Hook the pinning check directly." {
		t.Fatalf("conclusion wrong: %q", answer.Conclusion)
	}
	if len(answer.Steps) != 2 || len(answer.Pitfalls) != 1 {
		t.Fatalf("sections wrong: %+v %+v", answer.Steps, answer.Pitfalls)
	}
	if len(answer.Citations) != 1 || answer.Citations[0].ID != "android/frida-ssl" {
		t.Fatalf("citation not resolved: %+v", answer.Citations)
	}
	if len(answer.InventedCitations) != 0 {
		t.Fatalf("unexpected invented citations: %+v", answer.InventedCitations)
	}
}

func TestParseAnswerFlagsInventedCitations(t *testing.T) {
	answer := ParseAnswer("### 结论\nx\n### 出处\n[android/frida-ssl] [made/up]", entries())
	if len(answer.Citations) != 1 || len(answer.InventedCitations) != 1 {
		t.Fatalf("invented citation not surfaced: %+v / %+v", answer.Citations, answer.InventedCitations)
	}
	rendered := FormatAnswer(answer)
	if !strings.Contains(rendered, "made/up") || !strings.Contains(rendered, "警告") {
		t.Fatalf("the warning must reach the operator:\n%s", rendered)
	}
}

func TestParseAnswerAcceptsEnglishAliasesAndBullets(t *testing.T) {
	reply := strings.Join([]string{
		"## Conclusion",
		"Do the thing.",
		"## Steps",
		"- first",
		"  continued",
		"## Pitfalls",
		"* watch out",
		"## Sources",
		"[web/wasm-crypto]",
	}, "\n")
	answer := ParseAnswer(reply, entries())
	if !answer.Parsed || len(answer.Steps) != 1 || !strings.Contains(answer.Steps[0], "continued") {
		t.Fatalf("alias/bullet parsing wrong: %+v", answer)
	}
	if len(answer.Citations) != 1 {
		t.Fatalf("citation missed: %+v", answer.Citations)
	}
}

func TestParseAnswerFallsBackToRaw(t *testing.T) {
	answer := ParseAnswer("just some prose with no markers", entries())
	if answer.Parsed {
		t.Fatal("prose with no markers must not claim to be parsed")
	}
	if !strings.Contains(FormatAnswer(answer), "just some prose") {
		t.Fatal("the raw reply must still be shown")
	}
}

func TestMarkdownLinksAreNotCitations(t *testing.T) {
	answer := ParseAnswer("### 出处\n[android/frida-ssl](https://example.com)", entries())
	if len(answer.Citations) != 0 || len(answer.InventedCitations) != 0 {
		t.Fatalf("a markdown link is not a citation: %+v / %+v", answer.Citations, answer.InventedCitations)
	}
}

func TestPackRespectsTheByteBudget(t *testing.T) {
	list := entries()
	packed := Pack(list, PackOptions{MaxBytes: 300, FullTextCount: 0})
	if len(packed.Text) > 300 {
		t.Fatalf("packed context overran the budget: %d bytes", len(packed.Text))
	}
	if len(packed.Used)+len(packed.Truncated) != len(list) {
		t.Fatalf("entries lost: used=%d truncated=%d", len(packed.Used), len(packed.Truncated))
	}
	for _, entry := range packed.Used {
		if !strings.Contains(packed.Text, "["+entry.ID+"]") {
			t.Fatalf("packed block missing its id: %s", entry.ID)
		}
	}
}

func TestPackKeepsGoingAfterASkip(t *testing.T) {
	list := []Entry{
		{ID: "big", Title: strings.Repeat("x", 400), Summary: strings.Repeat("y", 400)},
		{ID: "small", Title: "tiny", Summary: "short"},
	}
	packed := Pack(list, PackOptions{MaxBytes: 300, FullTextCount: 0})
	if len(packed.Used) != 1 || packed.Used[0].ID != "small" {
		t.Fatalf("one oversized entry must not cost the rest their metadata: %+v", packed.Used)
	}
}

func TestBuildPromptListsCitableIDs(t *testing.T) {
	packed := Pack(entries(), PackOptions{FullTextCount: 0})
	prompt := BuildPrompt("frida ssl", packed)
	if !strings.Contains(prompt, "[android/frida-ssl]") || !strings.Contains(prompt, "frida ssl") {
		t.Fatalf("prompt missing its parts:\n%s", prompt)
	}
}

func TestFormatDigestCarriesTheContract(t *testing.T) {
	digest := FormatDigest("frida ssl", entries())
	for _, want := range []string{"KNOWLEDGE QUERY DIGEST", "agent contract", "### 出处", "[android/frida-ssl]"} {
		if !strings.Contains(digest, want) {
			t.Fatalf("digest missing %q:\n%s", want, digest)
		}
	}
	empty := FormatDigest("nothing", nil)
	if !strings.Contains(empty, "hits: 0") {
		t.Fatalf("empty digest wrong:\n%s", empty)
	}
}

func TestSearchRanksTitleOverSummary(t *testing.T) {
	list := []Entry{
		{ID: "a", Title: "unrelated", Summary: "mentions frida once"},
		{ID: "b", Title: "frida hooking", Summary: "unrelated"},
	}
	scored := scoreEntry(list[1], terms("frida"))
	if scored <= scoreEntry(list[0], terms("frida")) {
		t.Fatal("a title match must outrank a summary match")
	}
}
