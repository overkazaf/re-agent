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
		Description: "Generate Frida scaffolds: targeted Android Java/native/iOS hooks plus common Android SSL, crypto, root/debug, class-loader, and native trace templates. Writes only when outputPath is provided and --write is enabled.",
		Risk:        types.RiskRead,
		Parameters: objectSchema(map[string]any{
			"platform":     map[string]any{"type": "string", "enum": []string{"android_java", "android_native", "ios_objc"}, "default": "android_java"},
			"template":     map[string]any{"type": "string", "description": "Optional named template: catalog, android_ssl_pinning, android_crypto, android_root_debug, android_class_loader, native_trace."},
			"target":       map[string]any{"type": "string", "description": "Class name, module!export, module+offset, or ObjC class."},
			"method":       map[string]any{"type": "string", "description": "Method name for Java/ObjC targets."},
			"signature":    map[string]any{"type": "string", "description": "Optional comma-separated Java overload types."},
			"includeStack": map[string]any{"type": "boolean", "default": true},
			"outputPath":   map[string]any{"type": "string", "description": "Optional workspace-relative path to write the hook script."},
		}),
		Execute: func(args map[string]any, tc types.ToolContext) (types.ToolResult, error) {
			script, err := generateFridaTemplate(args)
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

func generateFridaTemplate(args map[string]any) (string, error) {
	template := normalizeFridaTemplate(util.AsString(args["template"], "auto"))
	if template != "" && template != "auto" {
		return commonFridaTemplate(template, args)
	}
	return generateFridaHook(
		util.AsString(args["platform"], "android_java"),
		util.AsString(args["target"]),
		util.AsString(args["method"]),
		util.AsString(args["signature"]),
		util.AsBool(args["includeStack"], true),
	)
}

func normalizeFridaTemplate(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "auto", "target", "hook":
		return "auto"
	case "list", "templates", "catalog":
		return "catalog"
	case "ssl", "tls", "pinning", "ssl_pinning", "android_ssl", "android_ssl_pinning", "okhttp":
		return "android_ssl_pinning"
	case "crypto", "cipher", "javax_crypto", "android_crypto", "java_crypto":
		return "android_crypto"
	case "root", "debug", "anti_debug", "root_debug", "android_root", "android_root_debug":
		return "android_root_debug"
	case "class", "classloader", "class_loader", "dex", "android_class_loader":
		return "android_class_loader"
	case "native", "native_trace", "stalker", "module_trace":
		return "native_trace"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func commonFridaTemplate(template string, args map[string]any) (string, error) {
	switch template {
	case "catalog":
		return fridaTemplateCatalog(), nil
	case "android_ssl_pinning":
		return androidSSLPinningTemplate(), nil
	case "android_crypto":
		return androidCryptoTemplate(), nil
	case "android_root_debug":
		return androidRootDebugTemplate(), nil
	case "android_class_loader":
		return androidClassLoaderTemplate(), nil
	case "native_trace":
		return nativeTraceTemplate(
			util.AsString(args["target"], "libtarget.so"),
			util.AsString(args["symbol"], util.AsString(args["method"], "")),
		), nil
	default:
		return "", fmt.Errorf("unsupported frida template: %s", template)
	}
}

func fridaTemplateCatalog() string {
	return strings.Join([]string{
		"FRIDA TEMPLATE CATALOG",
		"",
		"- android_ssl_pinning: TrustManagerImpl, OkHostnameVerifier, CertificatePinner, SSLContext hooks",
		"- android_crypto: Cipher, SecretKeySpec, IvParameterSpec, MessageDigest, Mac tracing",
		"- android_root_debug: local root/debug/frida check tracing and neutralizers for authorized testing",
		"- android_class_loader: ClassLoader/DexClassLoader tracing for packed or plugin apps",
		"- native_trace: module export/address trace with Interceptor and optional Stalker",
		"",
		"Examples:",
		`frida_hook_template {"template":"android_ssl_pinning"}`,
		`frida_hook_template {"template":"android_crypto"}`,
		`frida_hook_template {"template":"native_trace","target":"libfoo.so","symbol":"sign"}`,
	}, "\n")
}

func androidSSLPinningTemplate() string {
	return strings.TrimSpace(`
// Android SSL pinning inspection template for authorized local testing.
// Run: frida -U -f <package> -l ssl-pinning.js --no-pause
Java.perform(function () {
  function hook(name, fn) {
    try { fn(); console.log("[+] hooked " + name); }
    catch (e) { console.log("[-] " + name + ": " + e); }
  }

  hook("TrustManagerImpl", function () {
    const TMI = Java.use("com.android.org.conscrypt.TrustManagerImpl");
    TMI.checkTrustedRecursive.implementation = function () {
      console.log("[SSL] TrustManagerImpl.checkTrustedRecursive");
      return Java.use("java.util.ArrayList").$new();
    };
    TMI.verifyChain.implementation = function (chain, anchors, host, clientAuth, ocsp, sct) {
      console.log("[SSL] TrustManagerImpl.verifyChain host=" + host);
      return chain;
    };
  });

  hook("OkHostnameVerifier", function () {
    const Verifier = Java.use("com.android.okhttp.internal.tls.OkHostnameVerifier");
    Verifier.verify.overload("java.lang.String", "javax.net.ssl.SSLSession").implementation = function (host, session) {
      console.log("[SSL] OkHostnameVerifier.verify " + host);
      return true;
    };
  });

  hook("OkHttp CertificatePinner", function () {
    const Pinner = Java.use("okhttp3.CertificatePinner");
    Pinner.check.overloads.forEach(function (overload) {
      overload.implementation = function () {
        console.log("[SSL] CertificatePinner.check " + arguments[0]);
        return;
      };
    });
  });

  hook("SSLContext.init", function () {
    const SSLContext = Java.use("javax.net.ssl.SSLContext");
    const init = SSLContext.init.overload("[Ljavax.net.ssl.KeyManager;", "[Ljavax.net.ssl.TrustManager;", "java.security.SecureRandom");
    init.implementation = function (km, tm, sr) {
      console.log("[SSL] SSLContext.init");
      return init.call(this, km, tm, sr);
    };
  });
});
`) + "\n"
}

func androidCryptoTemplate() string {
	return strings.TrimSpace(`
// Android Java crypto tracing template.
// Captures algorithm names, key/IV material, inputs, and outputs in hex.
Java.perform(function () {
  function hex(bytes) {
    if (bytes === null || bytes === undefined) return "null";
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i] & 0xff;
      out.push(("0" + v.toString(16)).slice(-2));
    }
    return out.join("");
  }

  const SecretKeySpec = Java.use("javax.crypto.spec.SecretKeySpec");
  const secretKeyInit = SecretKeySpec.$init.overload("[B", "java.lang.String");
  secretKeyInit.implementation = function (key, alg) {
    console.log("[KEY] " + alg + " " + hex(key));
    return secretKeyInit.call(this, key, alg);
  };

  const IvParameterSpec = Java.use("javax.crypto.spec.IvParameterSpec");
  const ivInit = IvParameterSpec.$init.overload("[B");
  ivInit.implementation = function (iv) {
    console.log("[IV] " + hex(iv));
    return ivInit.call(this, iv);
  };

  const Cipher = Java.use("javax.crypto.Cipher");
  const cipherGetInstance = Cipher.getInstance.overload("java.lang.String");
  cipherGetInstance.implementation = function (name) {
    console.log("[Cipher.getInstance] " + name);
    return cipherGetInstance.call(Cipher, name);
  };
  const cipherDoFinal = Cipher.doFinal.overload("[B");
  cipherDoFinal.implementation = function (input) {
    console.log("[Cipher.doFinal in]  " + hex(input));
    const out = cipherDoFinal.call(this, input);
    console.log("[Cipher.doFinal out] " + hex(out));
    return out;
  };

  const MessageDigest = Java.use("java.security.MessageDigest");
  const digestUpdate = MessageDigest.update.overload("[B");
  digestUpdate.implementation = function (input) {
    console.log("[Digest.update] " + this.getAlgorithm() + " " + hex(input));
    return digestUpdate.call(this, input);
  };
  const digestFinal = MessageDigest.digest.overload();
  digestFinal.implementation = function () {
    const out = digestFinal.call(this);
    console.log("[Digest.out] " + this.getAlgorithm() + " " + hex(out));
    return out;
  };

  const Mac = Java.use("javax.crypto.Mac");
  const macDoFinal = Mac.doFinal.overload("[B");
  macDoFinal.implementation = function (input) {
    console.log("[Mac.doFinal in]  " + hex(input));
    const out = macDoFinal.call(this, input);
    console.log("[Mac.doFinal out] " + hex(out));
    return out;
  };
});
`) + "\n"
}

func androidRootDebugTemplate() string {
	return strings.TrimSpace(`
// Android root/debug/frida check tracing template for authorized local testing.
Java.perform(function () {
  function hook(name, fn) {
    try { fn(); console.log("[+] hooked " + name); }
    catch (e) { console.log("[-] " + name + ": " + e); }
  }

  hook("Debug.isDebuggerConnected", function () {
    const Debug = Java.use("android.os.Debug");
    Debug.isDebuggerConnected.implementation = function () {
      console.log("[anti-debug] isDebuggerConnected");
      return false;
    };
  });

  hook("File.exists", function () {
    const File = Java.use("java.io.File");
    const exists = File.exists.overload();
    exists.implementation = function () {
      const path = this.getAbsolutePath();
      if (path.indexOf("/su") >= 0 || path.indexOf("magisk") >= 0 || path.indexOf("frida") >= 0) {
        console.log("[anti-root] File.exists " + path + " -> false");
        return false;
      }
      return exists.call(this);
    };
  });

  hook("Runtime.exec", function () {
    const Runtime = Java.use("java.lang.Runtime");
    Runtime.exec.overloads.forEach(function (overload) {
      overload.implementation = function () {
        console.log("[exec] " + JSON.stringify(arguments));
        return overload.apply(this, arguments);
      };
    });
  });

  hook("SystemProperties.get", function () {
    const SP = Java.use("android.os.SystemProperties");
    const get = SP.get.overload("java.lang.String");
    get.implementation = function (key) {
      const value = get.call(SP, key);
      console.log("[prop] " + key + "=" + value);
      return value;
    };
  });
});
`) + "\n"
}

func androidClassLoaderTemplate() string {
	return strings.TrimSpace(`
// Android class loader tracing template for packed, plugin, or dynamic DEX apps.
Java.perform(function () {
  const ClassLoader = Java.use("java.lang.ClassLoader");
  const loadClass = ClassLoader.loadClass.overload("java.lang.String");
  loadClass.implementation = function (name) {
    const cls = loadClass.call(this, name);
    if (name.indexOf("com.") === 0 || name.indexOf("okhttp") >= 0 || name.indexOf("crypto") >= 0) {
      console.log("[loadClass] " + name + " via " + this);
    }
    return cls;
  };

  const DexClassLoader = Java.use("dalvik.system.DexClassLoader");
  const init = DexClassLoader.$init.overload("java.lang.String", "java.lang.String", "java.lang.String", "java.lang.ClassLoader");
  init.implementation = function (dexPath, optimizedDir, libPath, parent) {
    console.log("[DexClassLoader] dex=" + dexPath + " opt=" + optimizedDir + " lib=" + libPath);
    return init.call(this, dexPath, optimizedDir, libPath, parent);
  };

  Java.enumerateClassLoaders({
    onMatch(loader) { console.log("[loader] " + loader); },
    onComplete() { console.log("[loader] done"); }
  });
});
`) + "\n"
}

func nativeTraceTemplate(moduleName, symbol string) string {
	if strings.TrimSpace(moduleName) == "" {
		moduleName = "libtarget.so"
	}
	symbolLine := ""
	if strings.TrimSpace(symbol) != "" {
		symbolLine = fmt.Sprintf("const symbolName = %s;", jsonString(symbol))
	} else {
		symbolLine = "const symbolName = null; // set to an export name to attach one function"
	}
	return strings.TrimSpace(fmt.Sprintf(`
// Native module trace template. Set moduleName and optional symbolName.
const moduleName = %s;
%s

function attach(ptrValue, label) {
  if (ptrValue === null) throw new Error("target not found: " + label);
  Interceptor.attach(ptrValue, {
    onEnter(args) {
      this.tid = Process.getCurrentThreadId();
      console.log("[native enter] " + label + " tid=" + this.tid);
      for (let i = 0; i < 6; i++) console.log("  arg" + i + ": " + args[i]);
      Stalker.follow(this.tid, {
        events: { call: true, ret: false, exec: false, block: false, compile: false },
        onReceive(events) { console.log("[stalker] events=" + events.byteLength); }
      });
    },
    onLeave(retval) {
      Stalker.unfollow(this.tid);
      console.log("[native leave] " + label + " ret=" + retval);
    }
  });
}

const mod = Process.getModuleByName(moduleName);
console.log("[module] " + moduleName + " base=" + mod.base + " size=" + mod.size);
if (symbolName) {
  attach(Module.findExportByName(moduleName, symbolName), moduleName + "!" + symbolName);
} else {
  mod.enumerateExports().slice(0, 40).forEach(function (exp) {
    console.log("[export] " + exp.name + " " + exp.address);
  });
}
`, jsonString(moduleName), symbolLine)) + "\n"
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
