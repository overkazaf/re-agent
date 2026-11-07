use crate::util;
use goblin::mach::{
    load_command::CommandVariant, Mach, MachO,
};
use serde_json::{json, Value};

pub fn analyze(data: &[u8], path: &str) -> Value {
    match Mach::parse(data) {
        Ok(Mach::Binary(macho)) => analyze_single(&macho, data, path),
        Ok(Mach::Fat(fat)) => {
            let arches: Vec<Value> = fat
                .iter_arches()
                .flatten()
                .enumerate()
                .filter_map(|(i, arch)| {
                    let offset = arch.offset as usize;
                    let size = arch.size as usize;
                    let slice = data.get(offset..offset + size)?;
                    if let Ok(macho) = MachO::parse(slice, 0) {
                        let mut v = analyze_single(&macho, slice, path);
                        v["fat_index"] = json!(i);
                        v["fat_offset"] = json!(format!("0x{:08x}", offset));
                        Some(v)
                    } else {
                        None
                    }
                })
                .collect();
            json!({
                "format": "Mach-O Fat (Universal)",
                "path": path,
                "size": data.len(),
                "sha256": util::sha256_hex(data),
                "architectures": arches,
            })
        }
        Err(e) => json!({"error": format!("Mach-O parse failed: {e}"), "path": path}),
    }
}

fn analyze_single(macho: &MachO, data: &[u8], path: &str) -> Value {
    let header = &macho.header;
    let is_64 = matches!(header.magic, goblin::mach::header::MH_MAGIC_64 | goblin::mach::header::MH_CIGAM_64);
    let cputype_str = cputype_name(header.cputype);
    let filetype_str = filetype_name(header.filetype);

    // Flags
    let flags = header.flags;
    let has_pie = flags & 0x200000 != 0; // MH_PIE
    let has_no_heap_exec = flags & 0x1000000 != 0;
    let has_allow_stack_exec = flags & 0x20000 != 0;

    // Segments & sections
    let mut segments_out = Vec::new();
    for seg in macho.segments.iter() {
        let segname = seg
            .name()
            .unwrap_or("?");
        let initprot = prot_str(seg.initprot);
        let maxprot = prot_str(seg.maxprot);
        let seg_data = util::bounded_slice(data, seg.fileoff, seg.filesize);

        let mut sections_out = Vec::new();
        for (section, _data_opt) in seg.sections().unwrap_or_default() {
            let sectname = section
                .name()
                .unwrap_or("?");
            let sect_data = util::bounded_slice(data, section.offset as u64, section.size);
            sections_out.push(json!({
                "name": sectname,
                "segment": segname,
                "addr": format!("0x{:016x}", section.addr),
                "size": format!("0x{:08x}", section.size),
                "offset": format!("0x{:08x}", section.offset),
                "entropy": (util::shannon_entropy(sect_data) * 1000.0).round() / 1000.0,
            }));
        }

        segments_out.push(json!({
            "name": segname,
            "vmaddr": format!("0x{:016x}", seg.vmaddr),
            "vmsize": format!("0x{:08x}", seg.vmsize),
            "fileoff": format!("0x{:08x}", seg.fileoff),
            "filesize": format!("0x{:08x}", seg.filesize),
            "initprot": initprot,
            "maxprot": maxprot,
            "nsects": sections_out.len(),
            "sections": sections_out,
            "entropy": (util::shannon_entropy(seg_data) * 1000.0).round() / 1000.0,
        }));
    }

    // Load commands
    let mut load_cmds = Vec::new();
    let mut dylibs = Vec::new();
    let mut rpaths = Vec::new();
    let mut uuid_str = String::new();
    let mut has_code_signature = false;
    let mut has_encryption = false;
    let mut entrypoint: Option<u64> = None;

    for lc in &macho.load_commands {
        match lc.command {
            CommandVariant::LoadDylib(ref cmd)
            | CommandVariant::LoadWeakDylib(ref cmd)
            | CommandVariant::ReexportDylib(ref cmd)
            | CommandVariant::LazyLoadDylib(ref cmd) => {
                // cmd.dylib.name is an LCStr: an offset relative to the start
                // of this load command — not a string. Resolving it in the
                // file gives the dylib path; .to_string() would print the
                // raw offset number.
                let dylib_name = lc_string(data, lc.offset, cmd.dylib.name);
                dylibs.push(json!({
                    "name": dylib_name,
                    "timestamp": cmd.dylib.timestamp,
                }));
            }
            CommandVariant::Rpath(ref cmd) => {
                // Same LCStr resolution as dylib names.
                rpaths.push(lc_string(data, lc.offset, cmd.path));
            }
            CommandVariant::Uuid(ref cmd) => {
                uuid_str = cmd
                    .uuid
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join("");
                // Format as UUID
                if uuid_str.len() == 32 {
                    uuid_str = format!(
                        "{}-{}-{}-{}-{}",
                        &uuid_str[0..8],
                        &uuid_str[8..12],
                        &uuid_str[12..16],
                        &uuid_str[16..20],
                        &uuid_str[20..32]
                    );
                }
            }
            CommandVariant::Main(ref cmd) => {
                entrypoint = Some(cmd.entryoff);
            }
            CommandVariant::CodeSignature(_) => {
                has_code_signature = true;
            }
            CommandVariant::EncryptionInfo64(_) | CommandVariant::EncryptionInfo32(_) => {
                has_encryption = true;
            }
            _ => {}
        }
        let cmd_name = format!("{:?}", lc.command).split('(').next().unwrap_or("?").to_string();
        load_cmds.push(json!({
            "cmd": cmd_name,
            "size": lc.command.cmdsize(),
        }));
    }

    // Symbols (sample)
    let mut syms_out = Vec::new();
    let sym_iter = macho.symbols();
    for result in sym_iter.take(300) {
        if let Ok((name, nlist)) = result {
            syms_out.push(json!({
                "name": name,
                "value": format!("0x{:016x}", nlist.n_value),
                "type": format!("0x{:02x}", nlist.n_type),
                "sect": nlist.n_sect,
                "external": nlist.is_global(),
            }));
        }
    }

    json!({
        "format": "Mach-O",
        "path": path,
        "size": data.len(),
        "sha256": util::sha256_hex(data),
        "class": if is_64 { "Mach-O 64-bit" } else { "Mach-O 32-bit" },
        "cputype": cputype_str,
        "filetype": filetype_str,
        "ncmds": header.ncmds,
        "flags": format!("0x{:08x}", flags),
        "entry": entrypoint.map(|e| format!("0x{:08x}", e)),
        "uuid": uuid_str,
        "segments": segments_out,
        "load_commands": load_cmds,
        "dylibs": dylibs,
        "rpaths": rpaths,
        "symbols_sample": syms_out,
        "symbols_total": macho.symbols().count(),
        "security": {
            "pie": has_pie,
            "code_signature": has_code_signature,
            "encrypted": has_encryption,
            "no_heap_exec": has_no_heap_exec,
            "allow_stack_exec": has_allow_stack_exec,
        },
    })
}

pub fn sections_only(data: &[u8], path: &str) -> Value {
    match Mach::parse(data) {
        Ok(Mach::Binary(macho)) => sections_single(&macho, data, path),
        Ok(Mach::Fat(fat)) => {
            // Use first arch
            if let Some(Ok(arch)) = fat.iter_arches().next() {
                let offset = arch.offset as usize;
                let size = arch.size as usize;
                if let Some(slice) = data.get(offset..offset + size) {
                    if let Ok(macho) = MachO::parse(slice, 0) {
                        return sections_single(&macho, slice, path);
                    }
                }
            }
            json!({"error": "Cannot parse fat Mach-O", "path": path})
        }
        Err(e) => json!({"error": format!("Mach-O parse failed: {e}"), "path": path}),
    }
}

fn sections_single(macho: &MachO, data: &[u8], path: &str) -> Value {
    let mut sections = Vec::new();
    for seg in macho.segments.iter() {
        let segname = seg.name().unwrap_or("?");
        for (section, _) in seg.sections().unwrap_or_default() {
            let sectname = section.name().unwrap_or("?");
            let sect_data = util::bounded_slice(data, section.offset as u64, section.size);
            sections.push(json!({
                "name": format!("{},{}", segname, sectname),
                "type": section_type_name(section.flags),
                "size": section.size,
                "entropy": (util::shannon_entropy(sect_data) * 1000.0).round() / 1000.0,
            }));
        }
    }
    json!({
        "format": "Mach-O",
        "path": path,
        "cputype": cputype_name(macho.header.cputype),
        "sections": sections,
    })
}

/// Resolve an LCStr (offset relative to the start of a load command) to the
/// NUL-terminated string that follows it in the file. Bounds-safe on
/// malformed headers.
fn lc_string(data: &[u8], lc_offset: usize, str_offset: u32) -> String {
    let start = lc_offset.saturating_add(str_offset as usize);
    if start >= data.len() {
        return String::new();
    }
    let bytes = &data[start..];
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn section_type_name(flags: u32) -> &'static str {
    // SECTION_TYPE = flags & 0xff (mach-o/reloc.h)
    match flags & 0xff {
        0 => "REGULAR",
        1 => "ZEROFILL",
        2 => "CSTRING",
        3 => "4BYTE_LIT",
        4 => "8BYTE_LIT",
        5 => "LIT_PTRS",
        6 => "NL_SYM_PTR",
        7 => "LAZY_SYM_PTR",
        8 => "STUBS",
        9 => "MOD_INIT",
        10 => "MOD_TERM",
        11 => "COALESCED",
        12 => "GB_ZEROFILL",
        13 => "INTERPOSING",
        14 => "16BYTE_LIT",
        _ => "OTHER",
    }
}

fn cputype_name(t: u32) -> &'static str {
    match t as i32 {
        1 => "VAX",
        6 => "MC680x0",
        7 => "x86",
        0x01000007 => "x86_64",
        12 => "ARM",
        0x0100000c => "ARM64",
        14 => "SPARC",
        18 => "PowerPC",
        0x01000012 => "PowerPC 64",
        _ => "Unknown",
    }
}

fn filetype_name(t: u32) -> &'static str {
    match t {
        1 => "MH_OBJECT",
        2 => "MH_EXECUTE",
        3 => "MH_FVMLIB",
        4 => "MH_CORE",
        5 => "MH_PRELOAD",
        6 => "MH_DYLIB",
        7 => "MH_DYLINKER",
        8 => "MH_BUNDLE",
        9 => "MH_DYLIB_STUB",
        10 => "MH_DSYM",
        11 => "MH_KEXT_BUNDLE",
        _ => "?",
    }
}

fn prot_str(p: u32) -> String {
    format!(
        "{}{}{}",
        if p & 1 != 0 { "R" } else { "-" },
        if p & 2 != 0 { "W" } else { "-" },
        if p & 4 != 0 { "X" } else { "-" },
    )
}
