use crate::util;
use serde_json::{json, Value};

#[derive(Clone)]
struct Finding {
    category: &'static str,
    confidence: &'static str,
    description: String,
    offset: Option<usize>,
    detail: String,
}

pub fn analyze(data: &[u8], path: &str) -> Value {
    let strings = util::extract_strings(data, 4);
    let string_text: Vec<&str> = strings.iter().map(|(_, s)| s.as_str()).collect();
    let mut findings: Vec<Finding> = Vec::new();

    // --- Anti-Debug ---
    check_anti_debug(data, &strings, &string_text, &mut findings);
    // --- Anti-VM ---
    check_anti_vm(data, &strings, &string_text, &mut findings);
    // --- Anti-Frida ---
    check_anti_frida(data, &strings, &string_text, &mut findings);
    // --- Anti-Root/Jailbreak ---
    check_anti_root(&strings, &string_text, &mut findings);
    // --- Obfuscation ---
    check_obfuscation(data, &mut findings);
    // --- Anti-Tamper ---
    check_anti_tamper(&strings, &string_text, &mut findings);

    // Organize by category
    let categories = [
        "anti_debug",
        "anti_vm",
        "anti_frida",
        "anti_root",
        "obfuscation",
        "anti_tamper",
    ];
    let mut grouped: Vec<Value> = Vec::new();
    let mut summary = serde_json::Map::new();

    for cat in &categories {
        let cat_findings: Vec<&Finding> = findings.iter().filter(|f| f.category == *cat).collect();
        let max_conf = cat_findings
            .iter()
            .map(|f| match f.confidence {
                "high" => 3,
                "medium" => 2,
                _ => 1,
            })
            .max()
            .unwrap_or(0);
        let conf_label = match max_conf {
            3 => "high",
            2 => "medium",
            1 => "low",
            _ => "none",
        };

        summary.insert(
            cat.to_string(),
            json!({
                "count": cat_findings.len(),
                "confidence": if cat_findings.is_empty() { "none" } else { conf_label },
            }),
        );

        if !cat_findings.is_empty() {
            let items: Vec<Value> = cat_findings
                .iter()
                .map(|f| {
                    let mut v = json!({
                        "description": f.description,
                        "confidence": f.confidence,
                        "detail": f.detail,
                    });
                    if let Some(off) = f.offset {
                        v["offset"] = json!(format!("0x{:08x}", off));
                    }
                    v
                })
                .collect();
            grouped.push(json!({
                "category": cat,
                "findings": items,
            }));
        }
    }

    // Bypass hints
    let hints = generate_bypass_hints(&findings);

    json!({
        "path": path,
        "size": data.len(),
        "total_findings": findings.len(),
        "categories": grouped,
        "summary": summary,
        "bypass_hints": hints,
    })
}

pub fn detect_packer(data: &[u8], path: &str) -> Value {
    let strings = util::extract_strings(data, 3);
    let string_text: Vec<&str> = strings.iter().map(|(_, s)| s.as_str()).collect();
    let mut packers: Vec<Value> = Vec::new();

    let checks: &[(&str, &[&str])] = &[
        ("UPX", &["UPX!", "UPX0", "UPX1", "UPX2"]),
        ("MPRESS", &[".MPRESS", "MPRESS1", "MPRESS2"]),
        ("ASPack", &[".aspack", ".adata", "ASPack"]),
        ("Themida", &[".themida", ".winlice", "Themida", "WinLicense"]),
        ("VMProtect", &[".vmp0", ".vmp1", "VMProtectSDK", "VMProtect"]),
        ("Enigma", &[".enigma", "Enigma Protector"]),
        ("PECompact", &["PEC2", "PECompact"]),
        ("Armadillo", &["Armadillo"]),
        ("Obsidium", &["Obsidium"]),
        ("360 Jiagu", &["libjiagu", "libjiagu_a64"]),
        ("Tencent Legu", &["libshell", "libshellx", "libtup", "libexecmain"]),
        ("Bangcle", &["libsecexe", "libsecmain", "libDexHelper"]),
        ("Ijiami", &["ijiami", "libexec.so"]),
        ("NetEase Yidun", &["libnesec", "yidun"]),
        ("DexGuard", &["dexguard"]),
    ];

    for &(name, patterns) in checks {
        for &pattern in patterns {
            let lower_pattern = pattern.to_lowercase();
            for (offset, s) in &strings {
                if s.to_lowercase().contains(&lower_pattern) {
                    packers.push(json!({
                        "name": name,
                        "matched": pattern,
                        "offset": format!("0x{:08x}", offset),
                        "string": if s.len() > 80 { &s[..80] } else { s.as_str() },
                    }));
                    break;
                }
            }
        }
    }

    // Check byte-level signatures
    if let Some(pos) = util::find_all(data, b"UPX!").first() {
        if !packers.iter().any(|p| p["name"] == "UPX") {
            packers.push(json!({"name": "UPX", "matched": "UPX! magic", "offset": format!("0x{:08x}", pos)}));
        }
    }

    // Entropy analysis for packing detection
    let overall_entropy = util::shannon_entropy(data);
    let is_high_entropy = overall_entropy > 7.2;

    // Check for anomalous section characteristics
    let mut anomalies: Vec<String> = Vec::new();
    if is_high_entropy {
        anomalies.push(format!(
            "Overall entropy {:.3} bits/byte — likely packed or encrypted",
            overall_entropy
        ));
    }

    // Overlay data (data after last section in PE)
    let _ = string_text; // suppress unused warning

    json!({
        "path": path,
        "size": data.len(),
        "overall_entropy": (overall_entropy * 1000.0).round() / 1000.0,
        "packers_detected": packers,
        "anomalies": anomalies,
        "verdict": if !packers.is_empty() {
            "packed/protected"
        } else if is_high_entropy {
            "possibly packed (high entropy)"
        } else {
            "no packer detected"
        },
    })
}

fn check_anti_debug(
    data: &[u8],
    strings: &[(usize, String)],
    _string_text: &[&str],
    findings: &mut Vec<Finding>,
) {
    let patterns: &[(&str, &str, &str)] = &[
        ("ptrace", "ptrace import — likely PTRACE_TRACEME self-trace", "high"),
        ("/proc/self/status", "/proc/self/status read — TracerPid check", "high"),
        ("/proc/self/maps", "/proc/self/maps inspection", "medium"),
        ("getppid", "getppid() — parent process check", "low"),
        ("PR_SET_DUMPABLE", "prctl(PR_SET_DUMPABLE) — prevent core dumps", "medium"),
        ("SIGTRAP", "SIGTRAP handler — breakpoint detection", "medium"),
        ("clock_gettime", "timing check — clock_gettime", "low"),
        ("gettimeofday", "timing check — gettimeofday", "low"),
        ("IsDebuggerPresent", "Win32 IsDebuggerPresent", "high"),
        ("CheckRemoteDebuggerPresent", "Win32 CheckRemoteDebuggerPresent", "high"),
        ("NtQueryInformationProcess", "NtQueryInformationProcess — debug port check", "high"),
        ("OutputDebugString", "OutputDebugString trick", "medium"),
        ("NtGlobalFlag", "NtGlobalFlag check", "medium"),
        ("FindWindow", "FindWindow — debugger window detection", "medium"),
        ("OllyDbg", "OllyDbg detection string", "high"),
        ("x64dbg", "x64dbg detection string", "high"),
        ("IDA Pro", "IDA Pro detection string", "high"),
    ];

    for &(needle, desc, conf) in patterns {
        for (offset, s) in strings {
            if s.contains(needle) {
                findings.push(Finding {
                    category: "anti_debug",
                    confidence: conf,
                    description: desc.into(),
                    offset: Some(*offset),
                    detail: format!("string: \"{}\"", if s.len() > 60 { &s[..60] } else { s }),
                });
                break;
            }
        }
    }

    // INT 3 (CC) clusters — breakpoint traps
    let int3_count = data.iter().filter(|&&b| b == 0xCC).count();
    if int3_count > 50 {
        findings.push(Finding {
            category: "anti_debug",
            confidence: "low",
            description: format!("INT 3 (0xCC) — {} occurrences, possible trap-based anti-debug", int3_count),
            offset: None,
            detail: "byte: 0xCC".into(),
        });
    }

    // INT 2D (anti-debug interrupt)
    for pos in util::find_all(data, &[0xCD, 0x2D]).iter().take(3) {
        findings.push(Finding {
            category: "anti_debug",
            confidence: "medium",
            description: "INT 2D instruction — kernel debugger detection".into(),
            offset: Some(*pos),
            detail: "bytes: CD 2D".into(),
        });
    }
}

fn check_anti_vm(
    data: &[u8],
    strings: &[(usize, String)],
    _string_text: &[&str],
    findings: &mut Vec<Finding>,
) {
    let vm_strings: &[(&str, &str, &str)] = &[
        ("VMwareVMware", "CPUID VMware vendor string", "high"),
        ("KVMKVMKVM", "CPUID KVM vendor string", "high"),
        ("XenVMMXenVMM", "CPUID Xen vendor string", "high"),
        ("VBoxVBoxVBox", "CPUID VirtualBox vendor string", "high"),
        ("Microsoft Hv", "CPUID Hyper-V vendor string", "high"),
        ("vmtoolsd", "VMware Tools daemon reference", "medium"),
        ("VBoxService", "VirtualBox Guest Additions", "medium"),
        ("vmware", "VMware reference", "low"),
        ("virtualbox", "VirtualBox reference", "low"),
        ("qemu", "QEMU reference", "medium"),
    ];

    for &(needle, desc, conf) in vm_strings {
        for (offset, s) in strings {
            if s.to_lowercase().contains(&needle.to_lowercase()) {
                findings.push(Finding {
                    category: "anti_vm",
                    confidence: conf,
                    description: desc.into(),
                    offset: Some(*offset),
                    detail: format!("string: \"{}\"", if s.len() > 60 { &s[..60] } else { s }),
                });
                break;
            }
        }
    }

    // RDTSC (0F 31) — timing-based VM detection
    for pos in util::find_all(data, &[0x0F, 0x31]).iter().take(5) {
        findings.push(Finding {
            category: "anti_vm",
            confidence: "low",
            description: "RDTSC instruction — timing check".into(),
            offset: Some(*pos),
            detail: "bytes: 0F 31".into(),
        });
    }

    // CPUID (0F A2)
    for pos in util::find_all(data, &[0x0F, 0xA2]).iter().take(5) {
        findings.push(Finding {
            category: "anti_vm",
            confidence: "medium",
            description: "CPUID instruction — hypervisor/vendor check".into(),
            offset: Some(*pos),
            detail: "bytes: 0F A2".into(),
        });
    }
}

fn check_anti_frida(
    _data: &[u8],
    strings: &[(usize, String)],
    _string_text: &[&str],
    findings: &mut Vec<Finding>,
) {
    let frida_patterns: &[(&str, &str, &str)] = &[
        ("frida-server", "frida-server detection", "high"),
        ("frida-agent", "frida-agent detection", "high"),
        ("frida-gadget", "frida-gadget detection", "high"),
        ("frida-helper", "frida-helper detection", "medium"),
        ("linjector", "linjector — Frida injection mechanism", "high"),
        ("gmain", "GLib main loop — Frida uses GLib internally", "low"),
        ("GDBusConnection", "D-Bus connection — Frida communication", "low"),
    ];

    for &(needle, desc, conf) in frida_patterns {
        for (offset, s) in strings {
            if s.contains(needle) {
                findings.push(Finding {
                    category: "anti_frida",
                    confidence: conf,
                    description: desc.into(),
                    offset: Some(*offset),
                    detail: format!("string: \"{}\"", if s.len() > 60 { &s[..60] } else { s }),
                });
                break;
            }
        }
    }

    // Port 27042 (Frida default) as LE u16: 0x69B2
    for pos in util::find_all(_data, &[0xB2, 0x69]).iter().take(5) {
        findings.push(Finding {
            category: "anti_frida",
            confidence: "low",
            description: "port 27042 LE constant — Frida default port check".into(),
            offset: Some(*pos),
            detail: "bytes: B2 69".into(),
        });
    }
}

fn check_anti_root(
    strings: &[(usize, String)],
    _string_text: &[&str],
    findings: &mut Vec<Finding>,
) {
    let root_patterns: &[(&str, &str, &str)] = &[
        ("/system/xbin/su", "su binary check", "high"),
        ("/system/app/Superuser", "Superuser app check", "high"),
        ("/sbin/su", "su binary check (sbin)", "high"),
        ("com.topjohnwu.magisk", "Magisk package check", "high"),
        ("eu.chainfire.supersu", "SuperSU package check", "high"),
        ("com.noshufou.android.su", "Superuser package check", "medium"),
        ("libmagisk", "Magisk library reference", "high"),
        ("/data/adb/magisk", "Magisk data path", "high"),
        ("test-keys", "Build tags check (test-keys)", "medium"),
        ("SafetyNet", "SafetyNet reference", "medium"),
        ("PlayIntegrity", "Play Integrity API", "medium"),
        ("/Applications/Cydia.app", "Cydia app (iOS jailbreak)", "high"),
        ("MobileSubstrate", "MobileSubstrate (iOS)", "high"),
        ("cydia://", "Cydia URL scheme", "high"),
    ];

    for &(needle, desc, conf) in root_patterns {
        for (offset, s) in strings {
            if s.contains(needle) {
                findings.push(Finding {
                    category: "anti_root",
                    confidence: conf,
                    description: desc.into(),
                    offset: Some(*offset),
                    detail: format!("string: \"{}\"", if s.len() > 60 { &s[..60] } else { s }),
                });
                break;
            }
        }
    }
}

fn check_obfuscation(data: &[u8], findings: &mut Vec<Finding>) {
    // Check for RWX segments in ELF
    if data.starts_with(b"\x7fELF") {
        if let Ok(elf) = goblin::elf::Elf::parse(data) {
            for ph in &elf.program_headers {
                if ph.p_type == goblin::elf::program_header::PT_LOAD
                    && ph.p_flags & 7 == 7
                {
                    findings.push(Finding {
                        category: "obfuscation",
                        confidence: "high",
                        description: "RWX LOAD segment — self-modifying code possible".into(),
                        offset: Some(ph.p_offset as usize),
                        detail: format!(
                            "segment at 0x{:08x}, size 0x{:x}",
                            ph.p_vaddr, ph.p_memsz
                        ),
                    });
                }
            }

            // .text entropy
            for sh in &elf.section_headers {
                let name = elf.shdr_strtab.get_at(sh.sh_name).unwrap_or("");
                if name == ".text" && sh.sh_size > 0 {
                    let section_data = util::bounded_slice(data, sh.sh_offset, sh.sh_size);
                    let ent = util::shannon_entropy(section_data);
                    if ent > 7.5 {
                        findings.push(Finding {
                            category: "obfuscation",
                            confidence: "high",
                            description: format!(
                                ".text section entropy: {:.2} bits/byte — packed/encrypted",
                                ent
                            ),
                            offset: Some(sh.sh_offset as usize),
                            detail: format!("size: {}", sh.sh_size),
                        });
                    } else if ent > 6.5 {
                        findings.push(Finding {
                            category: "obfuscation",
                            confidence: "medium",
                            description: format!(
                                ".text section entropy: {:.2} bits/byte — possibly obfuscated",
                                ent
                            ),
                            offset: Some(sh.sh_offset as usize),
                            detail: format!("size: {}", sh.sh_size),
                        });
                    }
                }
            }
        }
    }

    // Known packer magic
    if !util::find_all(data, b"UPX!").is_empty() {
        findings.push(Finding {
            category: "obfuscation",
            confidence: "high",
            description: "UPX packer signature detected".into(),
            offset: util::find_all(data, b"UPX!").first().copied(),
            detail: "string: UPX!".into(),
        });
    }
}

fn check_anti_tamper(
    strings: &[(usize, String)],
    _string_text: &[&str],
    findings: &mut Vec<Finding>,
) {
    let tamper_patterns: &[(&str, &str, &str)] = &[
        ("tampered", "tamper detection string", "medium"),
        ("integrity check", "integrity verification", "medium"),
        ("checksum failed", "checksum validation", "medium"),
        ("modified", "modification detection", "low"),
        ("codeSigning", "code signing verification", "low"),
        ("Code Signing", "code signing verification", "low"),
        ("signature verif", "signature verification", "medium"),
    ];

    for &(needle, desc, conf) in tamper_patterns {
        for (offset, s) in strings {
            if s.to_lowercase().contains(&needle.to_lowercase()) {
                findings.push(Finding {
                    category: "anti_tamper",
                    confidence: conf,
                    description: desc.into(),
                    offset: Some(*offset),
                    detail: format!("string: \"{}\"", if s.len() > 60 { &s[..60] } else { s }),
                });
                break;
            }
        }
    }
}

fn generate_bypass_hints(findings: &[Finding]) -> Vec<String> {
    let mut hints = Vec::new();
    let cats: Vec<&str> = findings.iter().map(|f| f.category).collect();

    if cats.contains(&"anti_debug") {
        if findings.iter().any(|f| f.description.contains("ptrace")) {
            hints.push("ptrace: hook ptrace() to return 0, or NOP the PTRACE_TRACEME call".into());
        }
        if findings.iter().any(|f| f.description.contains("/proc/self/status")) {
            hints.push("/proc/self/status: hook open/read to return TracerPid: 0".into());
        }
        if findings.iter().any(|f| f.description.contains("IsDebuggerPresent")) {
            hints.push("IsDebuggerPresent: patch PEB->BeingDebugged to 0, or hook the API".into());
        }
        if findings.iter().any(|f| f.description.contains("timing")) {
            hints.push("timing: use a hypervisor or hook time APIs to return consistent values".into());
        }
    }
    if cats.contains(&"anti_vm") {
        hints.push("VM detection: use a bare-metal machine, or patch CPUID/RDTSC handlers".into());
    }
    if cats.contains(&"anti_frida") {
        hints.push("Frida: use frida-gadget (embedded), non-default port (frida-server -l 0.0.0.0:1337), or hook the detection function".into());
    }
    if cats.contains(&"anti_root") {
        hints.push("root/jailbreak: use Magisk Hide/DenyList, or hook the file existence checks".into());
    }
    if findings.iter().any(|f| f.description.contains("UPX")) {
        hints.push("UPX: unpack with `upx -d <binary>`, then re-analyze".into());
    }
    if findings.iter().any(|f| f.description.contains("RWX")) {
        hints.push("RWX segment: likely self-modifying code — dump after runtime unpacking".into());
    }

    hints
}
