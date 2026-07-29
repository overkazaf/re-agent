package tools

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/overkazaf/re-agent/internal/security"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/util"
)

type retoolProbe struct {
	Name        string
	Commands    []string
	PythonMods  []string
	Description string
}

var reverseToolProbes = []retoolProbe{
	{"radare2", []string{"r2", "rabin2", "rasm2", "rahash2"}, nil, "radare2 analysis, disassembly, metadata, and patching helpers"},
	{"rizin", []string{"rizin", "rz-bin", "rz-asm", "rz-hash"}, nil, "rizin/rz-bin analysis workflow"},
	{"ghidra", []string{"analyzeHeadless"}, nil, "Ghidra headless project import and analysis"},
	{"jadx", []string{"jadx", "jadx-gui"}, nil, "DEX/APK/JAR Java decompilation"},
	{"apktool", []string{"apktool"}, nil, "APK resources and smali decode/build workflow"},
	{"android-dex", []string{"aapt", "aapt2", "d2j-dex2jar", "dexdump", "baksmali", "smali", "apkid"}, nil, "Android package, DEX, smali, and packer helpers"},
	{"binwalk", []string{"binwalk"}, nil, "firmware signature scan and extraction"},
	{"yara", []string{"yara", "yarac"}, nil, "rule-based artifact scanning"},
	{"native-debug", []string{"gdb", "lldb", "qemu-x86_64", "qemu-aarch64", "qemu-arm"}, nil, "batch debugger and user-mode emulation helpers"},
	{"frida", []string{"frida", "frida-ps", "frida-trace", "frida-ls-devices", "objection"}, nil, "dynamic instrumentation and mobile runtime inspection"},
	{"burp", []string{"burpsuite", "BurpSuiteCommunity", "BurpSuitePro"}, nil, "Burp Suite HTTP interception, mobile proxy setup, and history export triage"},
	{"mitmproxy", []string{"mitmproxy", "mitmdump", "mitmweb"}, nil, "scriptable HTTP(S) interception proxy capture and flow analysis"},
	{"angr", []string{"python3"}, []string{"angr", "claripy", "cle", "pyvex"}, "symbolic execution, CFG recovery, and path exploration"},
	{"binary-utils", []string{"objdump", "readelf", "nm", "strings", "file"}, nil, "binutils and baseline native triage"},
	{"python-re-libs", []string{"python3"}, []string{"unicorn", "capstone", "keystone", "lief", "angr", "androguard"}, "Python RE libraries for emulation, disassembly, lifting, and APK work"},
	{"unidbg", []string{"java", "javac", "gradle", "mvn"}, nil, "Java Android native emulation harness ecosystem"},
}

func reverseToolkitTool() types.Tool {
	return types.Tool{
		Name:        "reverse_toolkit",
		Description: "Use common external reverse-engineering tools through fixed safe actions: radare2/rizin, JADX, apktool, binwalk, YARA, Ghidra headless, gdb/lldb, APKID/AAPT, Frida inventory/templates, Burp/mitmproxy proxy templates, plus angr/Unicorn/unidbg harness templates.",
		Risk:        types.RiskExecute,
		Parameters: objectSchema(map[string]any{
			"tool": map[string]any{
				"type":        "string",
				"description": "Tool family: inventory, radare2/r2, rizin, jadx, apktool, binwalk, yara, ghidra, gdb, lldb, objdump, readelf, nm, apkid, aapt, frida, burp, mitmproxy, angr, unicorn, unidbg.",
				"default":     "inventory",
			},
			"action": map[string]any{
				"type":        "string",
				"description": "Action for the tool family, for example info/functions/strings/decompile/scan/extract/template.",
				"default":     "auto",
			},
			"template": map[string]any{"type": "string", "description": "Named Frida or proxy template when action=template."},
			"path":     map[string]any{"type": "string", "description": "Workspace-relative artifact path when the action needs one."},
			"rules":    map[string]any{"type": "string", "description": "Workspace-relative YARA rules path."},
			"address":  map[string]any{"type": "string", "description": "Address or symbol for focused disassembly/templates.", "default": ""},
			"symbol":   map[string]any{"type": "string", "description": "Class, method, symbol, or module name used by a few actions.", "default": ""},
			"host":     map[string]any{"type": "string", "description": "Hostname filter for proxy templates.", "default": ""},
			"port":     map[string]any{"type": "number", "description": "Local proxy listener port for proxy templates.", "default": 8080},
			"arch":     map[string]any{"type": "string", "description": "Architecture for emulation templates: x86, x64, arm, arm64.", "default": "x64"},
			"lines":    map[string]any{"type": "number", "description": "Disassembly line count for focused radare2/rizin actions.", "default": 80},
			"maxBytes": map[string]any{"type": "number", "description": "Maximum output characters kept in context before spilling.", "default": 65536},
			"timeoutMs": map[string]any{
				"type":        "number",
				"description": "Command timeout. Clamped to the session command timeout.",
				"default":     120000,
			},
		}),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			tool := normalizeRETool(util.AsString(args["tool"], "inventory"))
			action := strings.ToLower(strings.TrimSpace(util.AsString(args["action"], "auto")))
			if action == "" || action == "auto" {
				action = defaultREAction(tool)
			}
			switch tool {
			case "inventory":
				return textResult(reverseToolkitInventory(tc), map[string]any{"tool": tool}), nil
			case "radare2":
				return runRadare2Action(action, args, tc)
			case "rizin":
				return runRizinAction(action, args, tc)
			case "jadx":
				return runJadxAction(action, args, tc)
			case "apktool":
				return runApktoolAction(action, args, tc)
			case "binwalk":
				return runBinwalkAction(action, args, tc)
			case "yara":
				return runYaraAction(action, args, tc)
			case "ghidra":
				return runGhidraAction(action, args, tc)
			case "gdb":
				return runGDBAction(action, args, tc)
			case "lldb":
				return runLLDBAction(action, args, tc)
			case "objdump":
				return runObjdumpAction(action, args, tc)
			case "readelf":
				return runReadelfAction(action, args, tc)
			case "nm":
				return runNMAction(action, args, tc)
			case "apkid":
				return runAPKIDAction(action, args, tc)
			case "aapt":
				return runAAPTAction(action, args, tc)
			case "frida":
				return runFridaAction(action, args, tc)
			case "burp":
				return runBurpAction(action, args, tc)
			case "mitmproxy":
				return runMITMProxyAction(action, args, tc)
			case "angr":
				return textResult(angrTemplate(args), map[string]any{"tool": tool, "action": "template"}), nil
			case "unicorn":
				return textResult(unicornTemplate(args, tc), map[string]any{"tool": tool, "action": "template"}), nil
			case "unidbg":
				return textResult(unidbgTemplate(args, tc), map[string]any{"tool": tool, "action": "template"}), nil
			}
			return errorResult("unsupported reverse toolkit tool: " + tool), nil
		},
	}
}

func normalizeRETool(tool string) string {
	switch strings.ToLower(strings.TrimSpace(tool)) {
	case "", "list", "check", "tools", "inventory", "avail", "available":
		return "inventory"
	case "r2", "radare", "radare2":
		return "radare2"
	case "rz", "rizin":
		return "rizin"
	case "ghidra", "analyzeheadless":
		return "ghidra"
	case "jadx", "apktool", "binwalk", "yara", "gdb", "lldb", "objdump", "readelf", "nm", "apkid", "aapt", "frida", "angr", "claripy", "unicorn", "unidbg":
		if strings.EqualFold(strings.TrimSpace(tool), "claripy") {
			return "angr"
		}
		return strings.ToLower(strings.TrimSpace(tool))
	case "burp", "burpsuite", "burp-suite", "burp_suite", "burpcommunity", "burppro":
		return "burp"
	case "mitm", "mitmproxy", "mitmdump", "mitmweb", "http-proxy", "httpproxy", "proxy":
		return "mitmproxy"
	}
	return strings.ToLower(strings.TrimSpace(tool))
}

func defaultREAction(tool string) string {
	switch tool {
	case "inventory":
		return "inventory"
	case "jadx", "apktool":
		return "decompile"
	case "binwalk", "yara", "apkid":
		return "scan"
	case "ghidra":
		return "analyze"
	case "angr", "unicorn", "unidbg", "burp", "mitmproxy":
		return "template"
	case "aapt":
		return "badging"
	case "frida":
		return "devices"
	default:
		return "info"
	}
}

func reverseToolkitInventory(tc types.ToolContext) string {
	lines := []string{
		"REVERSE TOOLKIT",
		"workspace: " + tc.Workspace,
		"",
		"availability:",
	}
	python := pythonPath()
	for _, probe := range reverseToolProbes {
		var ready []string
		var missing []string
		for _, command := range probe.Commands {
			if path, err := exec.LookPath(command); err == nil {
				ready = append(ready, command+"="+path)
			} else {
				missing = append(missing, command)
			}
		}
		for _, module := range probe.PythonMods {
			if python != "" && pythonModuleAvailable(python, module) {
				ready = append(ready, "py:"+module)
			} else {
				missing = append(missing, "py:"+module)
			}
		}
		state := "missing"
		if len(ready) > 0 {
			state = "partial"
		}
		if len(missing) == 0 {
			state = "ready"
		}
		lines = append(lines, fmt.Sprintf("- %-13s %-7s %s", probe.Name+":", state, probe.Description))
		if len(ready) > 0 {
			lines = append(lines, "  found: "+strings.Join(ready, ", "))
		}
		if len(missing) > 0 {
			lines = append(lines, "  missing: "+strings.Join(missing, ", "))
		}
	}
	lines = append(lines,
		"",
		"actions:",
		"- radare2/rizin: info, sections, symbols, imports, strings, functions, disasm",
		"- jadx/apktool: decompile into the session artifact directory",
		"- binwalk: scan or extract into the session artifact directory",
		"- yara: scan with workspace-local rules",
		"- ghidra: analyzeHeadless import into the session artifact directory",
		"- gdb/lldb/objdump/readelf/nm/apkid/aapt/frida: fixed read-only/batch actions",
		"- burp/mitmproxy: mobile/API interception setup, flow capture addon, and history export parser templates",
		"- angr/unicorn/unidbg: emit harness templates for symbolic execution and local emulation work",
		"- frida template: common Android SSL, crypto, root/debug, class-loader, and native trace scaffolds",
	)
	return strings.Join(lines, "\n")
}

func pythonPath() string {
	if path, err := exec.LookPath("python3"); err == nil {
		return path
	}
	if path, err := exec.LookPath("python"); err == nil {
		return path
	}
	return ""
}

func pythonModuleAvailable(python, module string) bool {
	result, err := Run([]string{python, "-c", "import " + module}, RunOptions{TimeoutMs: 3000})
	return err == nil && result.Code == 0
}

func runRadare2Action(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	switch action {
	case "info":
		return runRECommand("reverse_toolkit", []string{"rabin2", "-I", target}, "rabin2 -I "+rel, args, tc, "")
	case "sections":
		return runRECommand("reverse_toolkit", []string{"rabin2", "-S", target}, "rabin2 -S "+rel, args, tc, "")
	case "symbols":
		return runRECommand("reverse_toolkit", []string{"rabin2", "-s", target}, "rabin2 -s "+rel, args, tc, "")
	case "imports":
		return runRECommand("reverse_toolkit", []string{"rabin2", "-i", target}, "rabin2 -i "+rel, args, tc, "")
	case "strings":
		return runRECommand("reverse_toolkit", []string{"rabin2", "-zz", target}, "rabin2 -zz "+rel, args, tc, "")
	case "functions":
		return runRECommand("reverse_toolkit", []string{"r2", "-q", "-2", "-A", "-c", "afl", "-c", "q", target}, "r2 -A afl "+rel, args, tc, "")
	case "disasm":
		address := util.AsString(args["address"], "entry0")
		if strings.TrimSpace(address) == "" {
			address = "entry0"
		}
		if !safeRetoolToken(address) {
			return errorResult("radare2 disasm address must be a simple address or symbol"), nil
		}
		lines := clampInt(util.AsInt(args["lines"], 80), 1, 2000)
		cmd := fmt.Sprintf("pd %d @ %s", lines, address)
		return runRECommand("reverse_toolkit", []string{"r2", "-q", "-2", "-A", "-c", cmd, "-c", "q", target}, "r2 -A "+cmd+" "+rel, args, tc, "")
	}
	return errorResult("unsupported radare2 action: " + action), nil
}

func runRizinAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	switch action {
	case "info":
		return runRECommand("reverse_toolkit", []string{"rz-bin", "-I", target}, "rz-bin -I "+rel, args, tc, "")
	case "sections":
		return runRECommand("reverse_toolkit", []string{"rz-bin", "-S", target}, "rz-bin -S "+rel, args, tc, "")
	case "symbols":
		return runRECommand("reverse_toolkit", []string{"rz-bin", "-s", target}, "rz-bin -s "+rel, args, tc, "")
	case "imports":
		return runRECommand("reverse_toolkit", []string{"rz-bin", "-i", target}, "rz-bin -i "+rel, args, tc, "")
	case "strings":
		return runRECommand("reverse_toolkit", []string{"rz-bin", "-zz", target}, "rz-bin -zz "+rel, args, tc, "")
	case "functions":
		return runRECommand("reverse_toolkit", []string{"rizin", "-q", "-A", "-c", "afl", "-c", "q", target}, "rizin -A afl "+rel, args, tc, "")
	case "disasm":
		address := util.AsString(args["address"], "entry0")
		if strings.TrimSpace(address) == "" {
			address = "entry0"
		}
		if !safeRetoolToken(address) {
			return errorResult("rizin disasm address must be a simple address or symbol"), nil
		}
		lines := clampInt(util.AsInt(args["lines"], 80), 1, 2000)
		cmd := fmt.Sprintf("pd %d @ %s", lines, address)
		return runRECommand("reverse_toolkit", []string{"rizin", "-q", "-A", "-c", cmd, "-c", "q", target}, "rizin -A "+cmd+" "+rel, args, tc, "")
	}
	return errorResult("unsupported rizin action: " + action), nil
}

func runJadxAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	if action != "decompile" && action != "sources" {
		return errorResult("unsupported jadx action: " + action), nil
	}
	outDir, err := retoolOutputDir(tc, "jadx-"+filepath.Base(target))
	if err != nil {
		return types.ToolResult{}, err
	}
	command := []string{"jadx", "--show-bad-code", "--no-imports", "-d", outDir, target}
	return runRECommand("reverse_toolkit", command, "jadx -d "+outDir+" "+rel, args, tc, outDir)
}

func runApktoolAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	if action != "decompile" && action != "decode" {
		return errorResult("unsupported apktool action: " + action), nil
	}
	outDir, err := retoolOutputDir(tc, "apktool-"+filepath.Base(target))
	if err != nil {
		return types.ToolResult{}, err
	}
	command := []string{"apktool", "d", "-f", "-o", outDir, target}
	return runRECommand("reverse_toolkit", command, "apktool d -o "+outDir+" "+rel, args, tc, outDir)
}

func runBinwalkAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	switch action {
	case "scan", "info":
		return runRECommand("reverse_toolkit", []string{"binwalk", target}, "binwalk "+rel, args, tc, "")
	case "extract":
		outDir, err := retoolOutputDir(tc, "binwalk-"+filepath.Base(target))
		if err != nil {
			return types.ToolResult{}, err
		}
		return runRECommand("reverse_toolkit", []string{"binwalk", "-e", "-C", outDir, target}, "binwalk -e -C "+outDir+" "+rel, args, tc, outDir)
	}
	return errorResult("unsupported binwalk action: " + action), nil
}

func runYaraAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	if action != "scan" && action != "match" {
		return errorResult("unsupported yara action: " + action), nil
	}
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	rulesValue := strings.TrimSpace(util.AsString(args["rules"]))
	if rulesValue == "" {
		return errorResult("yara requires rules=<workspace-relative .yar file>"), nil
	}
	rules, err := util.ResolveInside(tc.Workspace, rulesValue)
	if err != nil {
		return types.ToolResult{}, err
	}
	if err := security.ValidatePathRead(rules, tc.Policy); err != nil {
		return types.ToolResult{}, err
	}
	command := []string{"yara", "-r", rules, target}
	return runRECommand("reverse_toolkit", command, "yara -r "+relative(tc.Workspace, rules)+" "+rel, args, tc, "")
}

func runGhidraAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	if action != "analyze" && action != "import" {
		return errorResult("unsupported ghidra action: " + action), nil
	}
	outDir, err := retoolOutputDir(tc, "ghidra-"+filepath.Base(target))
	if err != nil {
		return types.ToolResult{}, err
	}
	timeoutSec := maxInt(1, timeoutForRE(args, tc)/1000)
	command := []string{"analyzeHeadless", outDir, "project", "-import", target, "-overwrite", "-analysisTimeoutPerFile", strconv.Itoa(timeoutSec)}
	return runRECommand("reverse_toolkit", command, "analyzeHeadless "+outDir+" project -import "+rel, args, tc, outDir)
}

func runGDBAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	if action != "info" && action != "symbols" {
		return errorResult("unsupported gdb action: " + action), nil
	}
	command := []string{"gdb", "-q", "-batch", "-ex", "info files", "-ex", "info functions", target}
	return runRECommand("reverse_toolkit", command, "gdb -batch info "+rel, args, tc, "")
}

func runLLDBAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	if action != "info" && action != "symbols" {
		return errorResult("unsupported lldb action: " + action), nil
	}
	command := []string{"lldb", "--batch", "--file", target, "-o", "image list", "-o", "image dump symtab"}
	return runRECommand("reverse_toolkit", command, "lldb --batch --file "+rel, args, tc, "")
}

func runObjdumpAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	switch action {
	case "info", "headers":
		return runRECommand("reverse_toolkit", []string{"objdump", "-x", target}, "objdump -x "+rel, args, tc, "")
	case "disasm":
		return runRECommand("reverse_toolkit", []string{"objdump", "-d", "-Mintel", target}, "objdump -d -Mintel "+rel, args, tc, "")
	case "symbols":
		return runRECommand("reverse_toolkit", []string{"objdump", "-t", target}, "objdump -t "+rel, args, tc, "")
	}
	return errorResult("unsupported objdump action: " + action), nil
}

func runReadelfAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	flags := map[string][]string{
		"info":     {"-h"},
		"headers":  {"-h"},
		"sections": {"-S"},
		"symbols":  {"-Ws"},
		"imports":  {"-d"},
		"dynamic":  {"-d"},
		"relocs":   {"-r"},
		"all":      {"-a"},
	}
	selected, ok := flags[action]
	if !ok {
		return errorResult("unsupported readelf action: " + action), nil
	}
	command := append([]string{"readelf"}, selected...)
	command = append(command, target)
	return runRECommand("reverse_toolkit", command, "readelf "+strings.Join(selected, " ")+" "+rel, args, tc, "")
}

func runNMAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	if action != "info" && action != "symbols" {
		return errorResult("unsupported nm action: " + action), nil
	}
	return runRECommand("reverse_toolkit", []string{"nm", "-an", target}, "nm -an "+rel, args, tc, "")
}

func runAPKIDAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	if action != "scan" && action != "info" {
		return errorResult("unsupported apkid action: " + action), nil
	}
	return runRECommand("reverse_toolkit", []string{"apkid", target}, "apkid "+rel, args, tc, "")
}

func runAAPTAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	target, rel, err := requiredREPath(args, tc)
	if err != nil {
		return types.ToolResult{}, err
	}
	switch action {
	case "badging", "info":
		return runRECommand("reverse_toolkit", []string{"aapt", "dump", "badging", target}, "aapt dump badging "+rel, args, tc, "")
	case "xmltree":
		symbol := util.AsString(args["symbol"], "AndroidManifest.xml")
		return runRECommand("reverse_toolkit", []string{"aapt", "dump", "xmltree", target, symbol}, "aapt dump xmltree "+rel+" "+symbol, args, tc, "")
	}
	return errorResult("unsupported aapt action: " + action), nil
}

func runFridaAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	switch action {
	case "devices":
		return runRECommand("reverse_toolkit", []string{"frida-ls-devices"}, "frida-ls-devices", args, tc, "")
	case "ps":
		return runRECommand("reverse_toolkit", []string{"frida-ps", "-Uai"}, "frida-ps -Uai", args, tc, "")
	case "template":
		templateValue := util.AsString(args["template"])
		if strings.TrimSpace(templateValue) == "" {
			templateValue = util.AsString(args["path"], "catalog")
		}
		template := normalizeFridaTemplate(templateValue)
		script, err := commonFridaTemplate(template, args)
		if err != nil {
			return types.ToolResult{}, err
		}
		return textResult(script, map[string]any{"tool": "frida", "action": "template", "template": template}), nil
	}
	return errorResult("unsupported frida action: " + action), nil
}

func runBurpAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	switch action {
	case "template", "mobile", "setup", "checklist", "export", "parser", "catalog":
		defaultTemplate := "burp_mobile"
		if action == "export" || action == "parser" {
			defaultTemplate = "burp_export_parser"
		}
		template, host := proxyTemplateAndHost(args, defaultTemplate)
		if action == "catalog" {
			template = "catalog"
		}
		body, err := proxyTemplate(template, host, proxyPort(args))
		if err != nil {
			return types.ToolResult{}, err
		}
		return textResult(body, map[string]any{"tool": "burp", "action": "template", "template": template, "host": host}), nil
	case "info":
		return textResult(burpMobileTemplate(proxyHost(args), proxyPort(args)), map[string]any{"tool": "burp", "action": "info"}), nil
	}
	return errorResult("unsupported burp action: " + action), nil
}

func runMITMProxyAction(action string, args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
	switch action {
	case "info", "version":
		return runRECommand("reverse_toolkit", []string{"mitmdump", "--version"}, "mitmdump --version", args, tc, "")
	case "template", "addon", "capture", "flow", "flows", "catalog":
		defaultTemplate := "mitmproxy_addon"
		template, host := proxyTemplateAndHost(args, defaultTemplate)
		if action == "catalog" {
			template = "catalog"
		}
		body, err := proxyTemplate(template, host, proxyPort(args))
		if err != nil {
			return types.ToolResult{}, err
		}
		return textResult(body, map[string]any{"tool": "mitmproxy", "action": "template", "template": template, "host": host}), nil
	}
	return errorResult("unsupported mitmproxy action: " + action), nil
}

func proxyTemplateAndHost(args map[string]any, fallback string) (string, string) {
	host := proxyHost(args)
	rawTemplate := strings.TrimSpace(util.AsString(args["template"]))
	rawPath := strings.TrimSpace(util.AsString(args["path"]))
	raw := rawTemplate
	if raw == "" {
		raw = rawPath
	}
	if raw == "" {
		return fallback, host
	}
	normalized := normalizeProxyTemplate(raw)
	if isKnownProxyTemplate(normalized) {
		return normalized, host
	}
	if rawTemplate == "" && host == "example.test" {
		return fallback, raw
	}
	return normalized, host
}

func proxyHost(args map[string]any) string {
	host := strings.TrimSpace(util.AsString(args["host"]))
	if host == "" {
		host = strings.TrimSpace(util.AsString(args["symbol"]))
	}
	if host == "" {
		host = "example.test"
	}
	return host
}

func proxyPort(args map[string]any) int {
	port := util.AsInt(args["port"], 8080)
	return clampInt(port, 1, 65535)
}

func normalizeProxyTemplate(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "auto":
		return ""
	case "list", "templates", "catalog":
		return "catalog"
	case "mitm", "mitmproxy", "mitmdump", "addon", "capture", "captures", "flow", "flows", "jsonl", "traffic":
		return "mitmproxy_addon"
	case "burp", "mobile", "android", "ios", "setup", "checklist", "burp_mobile", "burp_setup":
		return "burp_mobile"
	case "export", "parser", "xml", "history", "http_history", "burp_xml", "burp_export", "burp_export_parser":
		return "burp_export_parser"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func isKnownProxyTemplate(template string) bool {
	switch template {
	case "catalog", "mitmproxy_addon", "burp_mobile", "burp_export_parser":
		return true
	default:
		return false
	}
}

func proxyTemplate(template, host string, port int) (string, error) {
	switch template {
	case "catalog":
		return proxyTemplateCatalog(), nil
	case "mitmproxy_addon":
		return mitmproxyAddonTemplate(host, port), nil
	case "burp_mobile":
		return burpMobileTemplate(host, port), nil
	case "burp_export_parser":
		return burpExportParserTemplate(), nil
	default:
		return "", fmt.Errorf("unsupported proxy template: %s", template)
	}
}

func proxyTemplateCatalog() string {
	return strings.Join([]string{
		"PROXY TOOL TEMPLATE CATALOG",
		"",
		"- mitmproxy_addon: scoped mitmdump addon that records request/response digests as JSONL",
		"- burp_mobile: Burp Suite mobile/API interception checklist for a scoped lab target",
		"- burp_export_parser: Python parser for Burp XML HTTP history exports",
		"",
		"Examples:",
		`/retool mitmproxy template api.example.test`,
		`/retool burp template mobile`,
		`/retool burp template export`,
	}, "\n")
}

func mitmproxyAddonTemplate(host string, port int) string {
	template := `# mitmproxy scoped capture addon for authorized local RE/CTF work.
# Save as capture_flows.py, then run:
#   MITM_HOST=__HOST_VALUE__ MITM_OUT=flows.jsonl mitmdump -q -p __PORT__ -s capture_flows.py --set flow_detail=0
#
# Point the test browser/device at the proxy, import the mitmproxy CA into that
# lab profile, and keep MITM_HOST set to the target host you are analyzing.

from mitmproxy import http
import base64
import hashlib
import json
import os
import time

FLOW_LOG = os.environ.get("MITM_OUT", "flows.jsonl")
HOST_FILTER = os.environ.get("MITM_HOST", __HOST_JSON__)
MAX_BODY = int(os.environ.get("MITM_MAX_BODY", "4096"))


def body_info(data):
    data = data or b""
    return {
        "len": len(data),
        "sha256": hashlib.sha256(data).hexdigest() if data else "",
        "preview_b64": base64.b64encode(data[:MAX_BODY]).decode("ascii"),
    }


def in_scope(flow):
    if not HOST_FILTER:
        return True
    return HOST_FILTER in flow.request.pretty_host


def emit(event, flow, extra):
    row = {
        "ts": time.time(),
        "event": event,
        "id": flow.id,
        "client": flow.client_conn.address,
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "host": flow.request.pretty_host,
        "request_headers": dict(flow.request.headers),
    }
    row.update(extra)
    with open(FLOW_LOG, "a", encoding="utf-8") as fp:
        fp.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def request(flow: http.HTTPFlow):
    if not in_scope(flow):
        return
    flow.metadata["capture"] = True
    emit("request", flow, {"request_body": body_info(flow.request.raw_content)})


def response(flow: http.HTTPFlow):
    if not flow.metadata.get("capture"):
        return
    emit("response", flow, {
        "status_code": flow.response.status_code if flow.response else 0,
        "response_headers": dict(flow.response.headers) if flow.response else {},
        "response_body": body_info(flow.response.raw_content if flow.response else b""),
    })
`
	replacements := map[string]string{
		"__HOST_VALUE__": host,
		"__HOST_JSON__":  jsonString(host),
		"__PORT__":       strconv.Itoa(port),
	}
	for key, value := range replacements {
		template = strings.ReplaceAll(template, key, value)
	}
	return template
}

func burpMobileTemplate(host string, port int) string {
	return fmt.Sprintf(`BURP SUITE MOBILE/API CAPTURE CHECKLIST

scope:
- target host: %s
- local listener: 127.0.0.1:%d

setup:
1. Start Burp Suite and create a project for the lab target.
2. Proxy > Proxy settings > Proxy listeners: bind 127.0.0.1:%d for local browser testing.
3. For a device on the LAN, bind the listener to the host LAN IP and keep the scope limited to the target host.
4. Import the Burp CA into the lab browser/profile/device trust store.
5. Add the target host to Target > Scope, then enable "show only in-scope items" in Proxy history.

Android emulator proxy:
adb shell settings put global http_proxy 10.0.2.2:%d
adb shell settings put global http_proxy :0

triage:
1. Capture login, challenge load, signing, crypto, upload, and result-check requests.
2. Send one representative request to Repeater and vary one parameter at a time.
3. Export selected HTTP history as XML or HAR for offline notes and parser-based comparison.
4. If a mobile app blocks trusted lab interception, prefer debug builds or authorized instrumentation in the same lab.

related templates:
- /retool burp template export
- /retool mitmproxy template %s
- /retool frida template android_ssl_pinning
`, host, port, port, port, host)
}

func burpExportParserTemplate() string {
	return `#!/usr/bin/env python3
# Parse a Burp Suite XML HTTP history export into one JSON object per item.
# Usage:
#   python3 burp_xml_digest.py burp-history.xml > burp-history.jsonl

import base64
import hashlib
import json
import sys
import xml.etree.ElementTree as ET


def node_text(item, name):
    node = item.find(name)
    return "" if node is None or node.text is None else node.text


def node_bytes(item, name):
    node = item.find(name)
    if node is None or node.text is None:
        return b""
    data = node.text.strip()
    if node.get("base64") == "true":
        return base64.b64decode(data)
    return data.encode("utf-8", errors="replace")


def digest(data):
    return {
        "len": len(data),
        "sha256": hashlib.sha256(data).hexdigest() if data else "",
        "preview": data[:240].decode("utf-8", errors="replace"),
    }


def main(path):
    root = ET.parse(path).getroot()
    for item in root.findall(".//item"):
        request = node_bytes(item, "request")
        response = node_bytes(item, "response")
        row = {
            "time": node_text(item, "time"),
            "host": node_text(item, "host"),
            "method": node_text(item, "method"),
            "url": node_text(item, "url"),
            "status": node_text(item, "status"),
            "mime": node_text(item, "mimetype"),
            "request": digest(request),
            "response": digest(response),
        }
        print(json.dumps(row, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: burp_xml_digest.py burp-history.xml")
    main(sys.argv[1])
`
}

func runRECommand(toolName string, command []string, label string, args map[string]any, tc types.ToolContext, outputDir string) (types.ToolResult, error) {
	if len(command) == 0 {
		return errorResult("empty reverse toolkit command"), nil
	}
	if _, err := exec.LookPath(command[0]); err != nil {
		return errorResult(fmt.Sprintf("%s is not installed or not on PATH. Run /retool inventory to see detected tools.", command[0])), nil
	}
	if label == "" {
		label = commandDisplay(command)
	}
	if err := security.RequestApproval(types.ApprovalRequest{
		Tool: toolName, Tier: types.TierExec, Summary: label,
	}, tc); err != nil {
		return types.ToolResult{}, err
	}
	result, err := Run(command, RunOptions{
		Cwd: tc.Workspace, TimeoutMs: timeoutForRE(args, tc), Ctx: tc.Context(),
	})
	if err != nil {
		return types.ToolResult{}, err
	}
	body := CommandText(label, result)
	if outputDir != "" {
		body += "\n\noutput_dir: " + outputDir
	}
	maxChars := util.AsInt(args["maxBytes"], tc.Policy.MaxToolOutputChars)
	if maxChars > tc.Policy.MaxReadBytes {
		maxChars = tc.Policy.MaxReadBytes
	}
	spilled := SpillIfLarge(body, SpillOptions{Context: tc, Label: label, MaxChars: maxChars})
	return textResult(spilled.Text, map[string]any{
		"exit": result.Code, "artifact": spilled.Artifact, "outputDir": outputDir,
	}), nil
}

func requiredREPath(args map[string]any, tc types.ToolContext) (string, string, error) {
	value := strings.TrimSpace(util.AsString(args["path"]))
	if value == "" {
		return "", "", fmt.Errorf("path is required for this reverse toolkit action")
	}
	target, err := util.ResolveInside(tc.Workspace, value)
	if err != nil {
		return "", "", err
	}
	if err := security.ValidatePathRead(target, tc.Policy); err != nil {
		return "", "", err
	}
	return target, relative(tc.Workspace, target), nil
}

func timeoutForRE(args map[string]any, tc types.ToolContext) int {
	timeout := util.AsInt(args["timeoutMs"], minInt(120000, tc.Policy.CommandTimeoutMs))
	if timeout <= 0 {
		timeout = tc.Policy.CommandTimeoutMs
	}
	if tc.Policy.CommandTimeoutMs > 0 && timeout > tc.Policy.CommandTimeoutMs {
		timeout = tc.Policy.CommandTimeoutMs
	}
	return timeout
}

func retoolOutputDir(tc types.ToolContext, label string) (string, error) {
	base := tc.SessionDir
	if base == "" {
		base = tc.Workspace
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	dir := filepath.Join(base, "artifacts", slug("retool-"+label)+"-"+stamp)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

var retoolTokenRE = regexp.MustCompile(`^[A-Za-z0-9_.$:+\-]+$`)

func safeRetoolToken(value string) bool {
	return retoolTokenRE.MatchString(strings.TrimSpace(value))
}

func commandDisplay(command []string) string {
	var parts []string
	for _, part := range command {
		if strings.ContainsAny(part, " \t\n\"'\\$") {
			parts = append(parts, strconv.Quote(part))
		} else {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, " ")
}

func angrTemplate(args map[string]any) string {
	path := util.AsString(args["path"], "./chall")
	find := strings.TrimSpace(util.AsString(args["address"]))
	if find == "" {
		find = "0x401000"
	}
	avoid := strings.TrimSpace(util.AsString(args["symbol"]))
	template := `#!/usr/bin/env python3
# angr symbolic exploration harness for local authorized RE/CTF work.
# Install locally: python3 -m pip install angr
# Usage:
#   python3 solve_angr.py ./chall --find 0x401000 --avoid 0x402000 --stdin-len 64

import argparse
import angr
import claripy

DEFAULT_BINARY = __PATH__
DEFAULT_FIND = __FIND__
DEFAULT_AVOID = __AVOID__


def parse_addr(value):
    value = (value or "").strip()
    return int(value, 0) if value else None


def parse_addr_list(value):
    return [parse_addr(item) for item in (value or "").split(",") if item.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", nargs="?", default=DEFAULT_BINARY)
    parser.add_argument("--find", default=DEFAULT_FIND, help="success address, for example 0x401234")
    parser.add_argument("--avoid", default=DEFAULT_AVOID, help="comma-separated bad addresses")
    parser.add_argument("--stdin-len", type=int, default=64)
    parser.add_argument("--argv1", default="", help="optional symbolic argv[1] label when needed")
    parser.add_argument("--cfg", action="store_true", help="print CFGFast summary before exploration")
    args = parser.parse_args()

    proj = angr.Project(args.binary, auto_load_libs=False)
    if args.cfg:
        cfg = proj.analyses.CFGFast(normalize=True)
        print(f"cfg functions={len(cfg.kb.functions)}")
        for addr, func in list(cfg.kb.functions.items())[:40]:
            print(f"0x{addr:x} {func.name}")

    stdin = claripy.BVS("stdin", args.stdin_len * 8)
    state = proj.factory.full_init_state(args=[args.binary], stdin=stdin)
    for byte in stdin.chop(8):
        state.solver.add(byte >= 0x20)
        state.solver.add(byte <= 0x7e)

    simgr = proj.factory.simgr(state)
    find = parse_addr(args.find)
    avoid = parse_addr_list(args.avoid)
    if find is None:
        print("Set --find to a success address. Use --cfg or radare2/Ghidra to locate it.")
        return

    simgr.explore(find=find, avoid=avoid)
    if not simgr.found:
        print("no path found")
        return

    found = simgr.found[0]
    data = found.solver.eval(stdin, cast_to=bytes)
    print(data.rstrip(b"\x00"))


if __name__ == "__main__":
    main()
`
	replacements := map[string]string{
		"__PATH__":  jsonString(path),
		"__FIND__":  jsonString(find),
		"__AVOID__": jsonString(avoid),
	}
	for key, value := range replacements {
		template = strings.ReplaceAll(template, key, value)
	}
	return template
}

func unicornTemplate(args map[string]any, tc types.ToolContext) string {
	path := util.AsString(args["path"], "shellcode.bin")
	arch := strings.ToLower(util.AsString(args["arch"], "x64"))
	address := util.AsString(args["address"], "0x100000")
	if strings.TrimSpace(address) == "" {
		address = "0x100000"
	}
	switch arch {
	case "x86", "i386", "386":
		return unicornPythonTemplate(path, address, "from unicorn.x86_const import *", "UC_ARCH_X86", "UC_MODE_32", "UC_X86_REG_EIP", "UC_X86_REG_ESP", "0x200000")
	case "arm", "arm32":
		return unicornPythonTemplate(path, address, "from unicorn.arm_const import *", "UC_ARCH_ARM", "UC_MODE_ARM", "UC_ARM_REG_PC", "UC_ARM_REG_SP", "0x200000")
	case "arm64", "aarch64":
		return unicornPythonTemplate(path, address, "from unicorn.arm64_const import *", "UC_ARCH_ARM64", "UC_MODE_ARM", "UC_ARM64_REG_PC", "UC_ARM64_REG_SP", "0x200000")
	default:
		return unicornPythonTemplate(path, address, "from unicorn.x86_const import *", "UC_ARCH_X86", "UC_MODE_64", "UC_X86_REG_RIP", "UC_X86_REG_RSP", "0x200000")
	}
}

func unicornPythonTemplate(path, base, constImport, archConst, modeConst, pcReg, spReg, stackBase string) string {
	return fmt.Sprintf(`# Unicorn single-blob harness.
# Install locally: python3 -m pip install unicorn capstone
from unicorn import *
%s

CODE_PATH = %q
BASE = %s
STACK = %s
STACK_SIZE = 0x100000

code = open(CODE_PATH, "rb").read()
mu = Uc(%s, %s)
mu.mem_map(BASE & ~0xfff, ((len(code) + 0xfff) & ~0xfff) or 0x1000)
mu.mem_write(BASE, code)
mu.mem_map(STACK, STACK_SIZE)
mu.reg_write(%s, STACK + STACK_SIZE // 2)

def hook_code(uc, address, size, user_data):
    print("trace pc=0x%%x size=%%d" %% (address, size))

mu.hook_add(UC_HOOK_CODE, hook_code)
try:
    mu.emu_start(BASE, BASE + len(code))
except UcError as exc:
    print("unicorn stopped:", exc)
print("pc=0x%%x" %% mu.reg_read(%s))
`, constImport, path, base, stackBase, archConst, modeConst, spReg, pcReg)
}

func unidbgTemplate(args map[string]any, tc types.ToolContext) string {
	lib := util.AsString(args["path"], "libtarget.so")
	symbol := util.AsString(args["symbol"], "JNI_OnLoad")
	if strings.TrimSpace(symbol) == "" {
		symbol = "JNI_OnLoad"
	}
	call := fmt.Sprintf(`        com.github.unidbg.Symbol target = module.findSymbolByName(%q, false);
        if (target == null) {
            throw new IllegalStateException("symbol not found: %s");
        }
        Number result = target.call(emulator);`, symbol, symbol)
	if strings.HasPrefix(symbol, "0x") || strings.HasPrefix(symbol, "0X") {
		call = fmt.Sprintf(`        Number result = module.callFunction(emulator, %s);`, symbol)
	}
	return fmt.Sprintf(`// unidbg Android native harness sketch.
// Keep this in a local Gradle project with unidbg on the classpath.
// Example dependency style:
//   implementation "com.github.zhkl0228:unidbg-android:${UNIDBG_VERSION}"

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.DalvikModule;
import com.github.unidbg.linux.android.dvm.VM;
import com.github.unidbg.memory.Memory;

import java.io.File;

public class UnidbgHarness {
    public static void main(String[] args) {
        AndroidEmulator emulator = AndroidEmulatorBuilder
                .for64Bit()
                .setProcessName("com.example.target")
                .build();
        Memory memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));

        VM vm = emulator.createDalvikVM();
        vm.setVerbose(true);

        DalvikModule dm = vm.loadLibrary(new File(%q), true);
        Module module = dm.getModule();
        dm.callJNI_OnLoad(emulator);

%s
        System.out.println("result=" + result);

        emulator.close();
    }
}
`, lib, call)
}
