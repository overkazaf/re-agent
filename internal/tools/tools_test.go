package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/types"
)

func testContext(t *testing.T) types.ToolContext {
	t.Helper()
	dir := t.TempDir()
	return types.ToolContext{
		Workspace: dir, SessionDir: dir,
		Policy: &types.ExecutionPolicy{
			CommandTimeoutMs: 5000, MaxReadBytes: 64 * 1024, MaxToolOutputChars: 4000,
			ApprovalMode: types.ApprovalYolo, Approvals: map[string]string{},
		},
	}
}

func run(t *testing.T, name string, args map[string]any, tc types.ToolContext) types.ToolResult {
	t.Helper()
	tool := Find(CreateReverseTools(), name)
	if tool == nil {
		t.Fatalf("tool %s is not registered", name)
	}
	result, err := tool.Execute(args, tc)
	if err != nil {
		t.Fatalf("%s failed: %v", name, err)
	}
	return result
}

func text(result types.ToolResult) string { return types.TextFromBlocks(result.Content) }

func TestRegistryIsComplete(t *testing.T) {
	want := []string{
		"list_files", "read_file", "write_file", "grep", "run_command", "file_info",
		"strings", "hexdump", "hash_file", "extract_symbols", "ctf_triage", "ctf_decode",
		"entropy_scan", "binary_mitigations", "find_bytes", "carve_artifacts", "reverse_toolkit",
		"apk_inspect", "frida_hook_template", "list_skills", "read_skill", "knowledge_search",
		"knowledge_read", "update_plan",
	}
	registry := CreateReverseTools()
	if len(registry) != len(want) {
		t.Fatalf("expected %d tools, got %d", len(want), len(registry))
	}
	for _, name := range want {
		if Find(registry, name) == nil {
			t.Fatalf("tool %s is missing", name)
		}
	}
}

func TestReverseToolkitInventoryMentionsCommonTools(t *testing.T) {
	tc := testContext(t)
	body := text(run(t, "reverse_toolkit", map[string]any{"tool": "inventory"}, tc))
	for _, want := range []string{"radare2", "jadx", "angr", "unicorn", "unidbg", "ghidra", "burp", "mitmproxy"} {
		if !strings.Contains(body, want) {
			t.Fatalf("inventory missing %q:\n%s", want, body)
		}
	}
}

func TestReverseToolkitTemplates(t *testing.T) {
	tc := testContext(t)
	unicorn := text(run(t, "reverse_toolkit", map[string]any{
		"tool": "unicorn", "action": "template", "path": "shellcode.bin", "arch": "arm64",
	}, tc))
	if !strings.Contains(unicorn, "Uc(UC_ARCH_ARM64") || !strings.Contains(unicorn, "shellcode.bin") {
		t.Fatalf("unicorn template wrong:\n%s", unicorn)
	}
	unidbg := text(run(t, "reverse_toolkit", map[string]any{
		"tool": "unidbg", "action": "template", "path": "libfoo.so", "symbol": "0x1234",
	}, tc))
	if !strings.Contains(unidbg, "AndroidEmulatorBuilder") || !strings.Contains(unidbg, "libfoo.so") {
		t.Fatalf("unidbg template wrong:\n%s", unidbg)
	}
	angr := text(run(t, "reverse_toolkit", map[string]any{
		"tool": "angr", "action": "template", "path": "chall", "address": "0x401234", "symbol": "0x402000",
	}, tc))
	if !strings.Contains(angr, "angr.Project") || !strings.Contains(angr, "claripy.BVS") ||
		!strings.Contains(angr, `"0x401234"`) || !strings.Contains(angr, `"0x402000"`) {
		t.Fatalf("angr template wrong:\n%s", angr)
	}
	frida := text(run(t, "reverse_toolkit", map[string]any{
		"tool": "frida", "action": "template", "path": "android_ssl_pinning",
	}, tc))
	if !strings.Contains(frida, "CertificatePinner") || !strings.Contains(frida, "TrustManagerImpl") {
		t.Fatalf("frida template via reverse_toolkit wrong:\n%s", frida)
	}
	mitm := text(run(t, "reverse_toolkit", map[string]any{
		"tool": "mitmproxy", "action": "template", "path": "api.example.test",
	}, tc))
	if !strings.Contains(mitm, "from mitmproxy import http") || !strings.Contains(mitm, `"api.example.test"`) {
		t.Fatalf("mitmproxy template wrong:\n%s", mitm)
	}
	burp := text(run(t, "reverse_toolkit", map[string]any{
		"tool": "burp", "action": "template", "path": "mobile",
	}, tc))
	if !strings.Contains(burp, "BURP SUITE MOBILE/API CAPTURE CHECKLIST") ||
		!strings.Contains(burp, "127.0.0.1:8080") {
		t.Fatalf("burp mobile template wrong:\n%s", burp)
	}
	burpExport := text(run(t, "reverse_toolkit", map[string]any{
		"tool": "burp", "action": "export",
	}, tc))
	if !strings.Contains(burpExport, "ET.parse") || !strings.Contains(burpExport, "base64.b64decode") {
		t.Fatalf("burp export parser template wrong:\n%s", burpExport)
	}
}

func TestReverseToolkitRejectsUnknownTool(t *testing.T) {
	tc := testContext(t)
	result := run(t, "reverse_toolkit", map[string]any{"tool": "made-up-re-tool"}, tc)
	if !result.IsError || !strings.Contains(text(result), "unsupported reverse toolkit tool") {
		t.Fatalf("unknown tool should be a tool error:\n%s", text(result))
	}
}

func TestReadFileRefusesToEscapeTheWorkspace(t *testing.T) {
	tc := testContext(t)
	tool := Find(CreateReverseTools(), "read_file")
	if _, err := tool.Execute(map[string]any{"path": "../../etc/passwd"}, tc); err == nil {
		t.Fatal("a path outside the workspace must be refused")
	}
}

func TestWriteFileNeedsTheWriteFlag(t *testing.T) {
	tc := testContext(t)
	tool := Find(CreateReverseTools(), "write_file")
	if _, err := tool.Execute(map[string]any{"path": "notes.md", "content": "x"}, tc); err == nil {
		t.Fatal("writes must be disabled without --write")
	}
	tc.Policy.AllowWrites = true
	if _, err := tool.Execute(map[string]any{"path": "notes/solve.md", "content": "flag"}, tc); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(tc.Workspace, "notes", "solve.md"))
	if err != nil || string(data) != "flag" {
		t.Fatalf("file not written: %v %q", err, data)
	}
}

func TestCTFDecodeAutoFindsTheFlag(t *testing.T) {
	tc := testContext(t)
	result := run(t, "ctf_decode", map[string]any{"input": "ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9"}, tc)
	if !strings.Contains(text(result), "flag{demo_reverse_lab_flag}") {
		t.Fatalf("auto decode missed the flag:\n%s", text(result))
	}
}

func TestCTFDecodeModes(t *testing.T) {
	tc := testContext(t)
	if body := text(run(t, "ctf_decode", map[string]any{"input": "666c61677b78787d", "mode": "hex"}, tc)); !strings.Contains(body, "flag{xx}") {
		t.Fatalf("hex decode failed:\n%s", body)
	}
	if body := text(run(t, "ctf_decode", map[string]any{"input": "synt", "mode": "rot13"}, tc)); !strings.Contains(body, "flag") {
		t.Fatalf("rot13 decode failed:\n%s", body)
	}
	if body := text(run(t, "ctf_decode", map[string]any{
		"input": "a%20b%2Bc", "mode": "url",
	}, tc)); !strings.Contains(body, "a b+c") {
		t.Fatalf("url decode failed:\n%s", body)
	}
	// XOR with a known key round-trips.
	xored := string(xorBytes([]byte("flag{xor}"), []byte{0x42}))
	body := text(run(t, "ctf_decode", map[string]any{"input": xored, "mode": "xor", "key": "0x42"}, tc))
	if !strings.Contains(body, "flag{xor}") {
		t.Fatalf("xor decode failed:\n%s", body)
	}
}

func TestCarveFindsEmbeddedSignatures(t *testing.T) {
	tc := testContext(t)
	blob := append([]byte("noise noise "), []byte("%PDF-1.7 body")...)
	blob = append(blob, 0x50, 0x4b, 0x03, 0x04)
	if err := os.WriteFile(filepath.Join(tc.Workspace, "carrier.bin"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
	body := text(run(t, "carve_artifacts", map[string]any{"path": "carrier.bin"}, tc))
	if !strings.Contains(body, "PDF") || !strings.Contains(body, "ZIP/APK/JAR") {
		t.Fatalf("carve missed a signature:\n%s", body)
	}
}

func TestFindBytesReportsOffsets(t *testing.T) {
	tc := testContext(t)
	if err := os.WriteFile(filepath.Join(tc.Workspace, "b.bin"), []byte("....flag{here}...."), 0o644); err != nil {
		t.Fatal(err)
	}
	body := text(run(t, "find_bytes", map[string]any{"path": "b.bin", "needle": "flag{"}, tc))
	if !strings.Contains(body, "matches: 1") || !strings.Contains(body, "0x00000004") {
		t.Fatalf("find_bytes wrong:\n%s", body)
	}
	hexBody := text(run(t, "find_bytes", map[string]any{"path": "b.bin", "needle": "666c6167", "mode": "hex"}, tc))
	if !strings.Contains(hexBody, "matches: 1") {
		t.Fatalf("hex search failed:\n%s", hexBody)
	}
}

func TestTriageClassifiesStringsAndEntropy(t *testing.T) {
	tc := testContext(t)
	body := []byte("CTF demo\nflag{sample_flag}\nhttps://ctf.example.invalid/api\nAES CBC token secret\n")
	if err := os.WriteFile(filepath.Join(tc.Workspace, "artifact.txt"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	out := text(run(t, "ctf_triage", map[string]any{"path": "artifact.txt"}, tc))
	for _, want := range []string{"flag-like", "url", "crypto-codec", "entropy:", "sha256:"} {
		if !strings.Contains(out, want) {
			t.Fatalf("triage missing %q:\n%s", want, out)
		}
	}
}

func TestEntropyScanOnRandomData(t *testing.T) {
	tc := testContext(t)
	data := make([]byte, 4096)
	for index := range data {
		data[index] = byte(index * 7 % 251)
	}
	if err := os.WriteFile(filepath.Join(tc.Workspace, "packed.bin"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	out := text(run(t, "entropy_scan", map[string]any{"path": "packed.bin", "window": 512, "step": 512}, tc))
	if !strings.Contains(out, "ENTROPY SCAN") || !strings.Contains(out, "windows: 8") {
		t.Fatalf("entropy scan wrong:\n%s", out)
	}
}

func TestUpdatePlanPublishesThroughTheContext(t *testing.T) {
	tc := testContext(t)
	var published []types.PlanStep
	var meta types.PlanUpdateMeta
	tc.OnPlan = func(steps []types.PlanStep, update types.PlanUpdateMeta) {
		published = steps
		meta = update
	}
	result := run(t, "update_plan", map[string]any{
		"plan": []any{
			map[string]any{"step": "triage", "status": "completed"},
			map[string]any{"step": "solve", "status": "in_progress"},
			"bare string step",
		},
		"explanation": "why",
	}, tc)
	if len(published) != 3 || meta.Source != "update_plan" || meta.Note != "why" {
		t.Fatalf("plan not published: %+v %+v", published, meta)
	}
	if published[2].Status != types.StepPending {
		t.Fatal("a bare string step should default to pending")
	}
	if !strings.Contains(text(result), "1/3 done") {
		t.Fatalf("unexpected summary:\n%s", text(result))
	}
}

func TestUpdatePlanRejectsAnEmptyList(t *testing.T) {
	tc := testContext(t)
	result := run(t, "update_plan", map[string]any{"plan": []any{}}, tc)
	if !result.IsError {
		t.Fatal("an empty plan must be an error")
	}
}

func TestFridaHookTemplates(t *testing.T) {
	tc := testContext(t)
	java := text(run(t, "frida_hook_template", map[string]any{
		"target": "com.a.Crypto", "method": "sign", "signature": "java.lang.String",
	}, tc))
	if !strings.Contains(java, `Java.use("com.a.Crypto")`) || !strings.Contains(java, `.overload("java.lang.String")`) {
		t.Fatalf("java hook wrong:\n%s", java)
	}
	native := text(run(t, "frida_hook_template", map[string]any{
		"platform": "android_native", "target": "libfoo.so!sign",
	}, tc))
	if !strings.Contains(native, `Module.findExportByName("libfoo.so", "sign")`) {
		t.Fatalf("native hook wrong:\n%s", native)
	}
	objc := text(run(t, "frida_hook_template", map[string]any{
		"platform": "ios_objc", "target": "AFCrypto", "method": "- sign:",
	}, tc))
	if !strings.Contains(objc, "ObjC.classes") {
		t.Fatalf("objc hook wrong:\n%s", objc)
	}
	ssl := text(run(t, "frida_hook_template", map[string]any{"template": "android_ssl_pinning"}, tc))
	if !strings.Contains(ssl, "CertificatePinner") || !strings.Contains(ssl, "TrustManagerImpl") {
		t.Fatalf("ssl template wrong:\n%s", ssl)
	}
	crypto := text(run(t, "frida_hook_template", map[string]any{"template": "android_crypto"}, tc))
	if !strings.Contains(crypto, "javax.crypto.Cipher") || !strings.Contains(crypto, "SecretKeySpec") {
		t.Fatalf("crypto template wrong:\n%s", crypto)
	}
	rootDebug := text(run(t, "frida_hook_template", map[string]any{"template": "android_root_debug"}, tc))
	if !strings.Contains(rootDebug, "Debug.isDebuggerConnected") || !strings.Contains(rootDebug, "Runtime.exec") {
		t.Fatalf("root/debug template wrong:\n%s", rootDebug)
	}
	trace := text(run(t, "frida_hook_template", map[string]any{
		"template": "native_trace", "target": "libfoo.so", "symbol": "sign",
	}, tc))
	if !strings.Contains(trace, "Stalker.follow") || !strings.Contains(trace, `"libfoo.so"`) || !strings.Contains(trace, `"sign"`) {
		t.Fatalf("native trace template wrong:\n%s", trace)
	}
}

func TestRunCommandCapturesExitAndOutput(t *testing.T) {
	tc := testContext(t)
	result := run(t, "run_command", map[string]any{"command": "printf hello; exit 3"}, tc)
	body := text(result)
	if !strings.Contains(body, "exit=3") || !strings.Contains(body, "hello") {
		t.Fatalf("command output wrong:\n%s", body)
	}
}

func TestRunCommandRespectsThePolicy(t *testing.T) {
	tc := testContext(t)
	tc.Policy.ApprovalMode = types.ApprovalSafe
	tool := Find(CreateReverseTools(), "run_command")
	if _, err := tool.Execute(map[string]any{"command": "curl https://example.com"}, tc); err == nil {
		t.Fatal("a network command must be refused with no one to ask")
	}
}

func TestSpillIfLargeWritesAnArtifact(t *testing.T) {
	tc := testContext(t)
	tc.Policy.MaxToolOutputChars = 200
	result := SpillIfLarge(strings.Repeat("x", 5000), SpillOptions{Context: tc, Label: "objdump -d chall"})
	if result.Artifact == "" {
		t.Fatal("oversized output should spill to an artifact")
	}
	if !strings.Contains(result.Text, "chars elided") || !strings.Contains(result.Text, result.Artifact) {
		t.Fatalf("preview missing its pointer:\n%s", result.Text)
	}
	data, err := os.ReadFile(result.Artifact)
	if err != nil || len(data) != 5000 {
		t.Fatalf("artifact not written in full: %v %d", err, len(data))
	}
}

func TestListFilesRespectsMaxEntries(t *testing.T) {
	tc := testContext(t)
	for index := 0; index < 10; index++ {
		if err := os.WriteFile(filepath.Join(tc.Workspace, string(rune('a'+index))+".txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	body := text(run(t, "list_files", map[string]any{"path": ".", "maxEntries": 4}, tc))
	if len(strings.Split(strings.TrimSpace(body), "\n")) != 4 {
		t.Fatalf("maxEntries ignored:\n%s", body)
	}
}
