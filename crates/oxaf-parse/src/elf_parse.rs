use crate::util;
use goblin::elf::dynamic::{DT_BIND_NOW, DT_FLAGS, DT_FLAGS_1, DT_NEEDED, DT_SONAME};
use goblin::elf::program_header::*;
use goblin::elf::section_header::*;
use goblin::elf::sym::*;
use goblin::elf::Elf;
use serde_json::{json, Value};

pub fn analyze(data: &[u8], path: &str) -> Value {
    let elf = match Elf::parse(data) {
        Ok(e) => e,
        Err(e) => return json!({"error": format!("ELF parse failed: {e}"), "path": path}),
    };

    let header = &elf.header;
    let is_64 = header.e_ident[4] == 2;
    let le = header.e_ident[5] == 1;

    let class_str = if is_64 { "ELF64" } else { "ELF32" };
    let encoding_str = if le {
        "2's complement, little endian"
    } else {
        "2's complement, big endian"
    };
    let type_str = match header.e_type {
        0 => "NONE",
        1 => "REL (Relocatable)",
        2 => "EXEC (Executable)",
        3 => "DYN (Position-Independent Executable)",
        4 => "CORE",
        _ => "UNKNOWN",
    };
    let machine_str = machine_name(header.e_machine);

    // Program headers
    let phdrs: Vec<Value> = elf
        .program_headers
        .iter()
        .map(|ph| {
            let flags = format!(
                "{}{}{}",
                if ph.p_flags & PF_R != 0 { "R" } else { "" },
                if ph.p_flags & PF_W != 0 { "W" } else { "" },
                if ph.p_flags & PF_X != 0 { "X" } else { "" },
            );
            json!({
                "type": phdr_type_name(ph.p_type),
                "offset": format!("0x{:08x}", ph.p_offset),
                "vaddr": format!("0x{:08x}", ph.p_vaddr),
                "filesz": format!("0x{:08x}", ph.p_filesz),
                "memsz": format!("0x{:08x}", ph.p_memsz),
                "flags": flags,
                "align": format!("0x{:x}", ph.p_align),
            })
        })
        .collect();

    // Section headers
    let shdrs: Vec<Value> = elf
        .section_headers
        .iter()
        .map(|sh| {
            let name = elf
                .shdr_strtab
                .get_at(sh.sh_name)
                .unwrap_or("");
            let flags_str = shdr_flags_str(sh.sh_flags as u32);
            json!({
                "name": name,
                "type": shdr_type_name(sh.sh_type),
                "addr": format!("0x{:08x}", sh.sh_addr),
                "offset": format!("0x{:08x}", sh.sh_offset),
                "size": format!("0x{:06x}", sh.sh_size),
                "flags": flags_str,
                "entropy": util::shannon_entropy(
                    util::bounded_slice(data, sh.sh_offset, sh.sh_size)
                ),
            })
        })
        .collect();

    // Dynamic section
    let mut dynamic_entries = Vec::new();
    if let Some(ref dynamic) = elf.dynamic {
        for dyn_entry in &dynamic.dyns {
            let tag_name = dyn_tag_name(dyn_entry.d_tag as u64);
            let val = match dyn_entry.d_tag as u64 {
                DT_NEEDED => {
                    let name = elf
                        .dynstrtab
                        .get_at(dyn_entry.d_val as usize)
                        .unwrap_or("?");
                    name.to_string()
                }
                DT_SONAME => {
                    let name = elf
                        .dynstrtab
                        .get_at(dyn_entry.d_val as usize)
                        .unwrap_or("?");
                    name.to_string()
                }
                _ => format!("0x{:x}", dyn_entry.d_val),
            };
            dynamic_entries.push(json!({"tag": tag_name, "value": val}));
        }
    }

    // Symbols (.dynsym)
    let dynsyms: Vec<Value> = elf
        .dynsyms
        .iter()
        .take(200)
        .map(|sym| {
            let name = elf.dynstrtab.get_at(sym.st_name).unwrap_or("");
            json!({
                "value": format!("0x{:016x}", sym.st_value),
                "size": sym.st_size,
                "type": sym_type_name(st_type(sym.st_info)),
                "bind": sym_bind_name(st_bind(sym.st_info)),
                "name": name,
            })
        })
        .collect();

    // Symbols (.symtab)
    let symtab: Vec<Value> = elf
        .syms
        .iter()
        .take(500)
        .map(|sym| {
            let name = elf.strtab.get_at(sym.st_name).unwrap_or("");
            json!({
                "value": format!("0x{:016x}", sym.st_value),
                "size": sym.st_size,
                "type": sym_type_name(st_type(sym.st_info)),
                "bind": sym_bind_name(st_bind(sym.st_info)),
                "name": name,
            })
        })
        .collect();

    // Relocations
    let mut relocs = Vec::new();
    for reloc in elf
        .dynrelas
        .iter()
        .chain(elf.dynrels.iter())
        .chain(elf.pltrelocs.iter())
        .take(200)
    {
        let sym_name = if reloc.r_sym > 0 {
            elf.dynsyms
                .get(reloc.r_sym)
                .and_then(|s| elf.dynstrtab.get_at(s.st_name))
                .unwrap_or("")
        } else {
            ""
        };
        relocs.push(json!({
            "offset": format!("0x{:016x}", reloc.r_offset),
            "type": reloc_type_name(header.e_machine, reloc.r_type),
            "sym": sym_name,
            "addend": reloc.r_addend.unwrap_or(0),
        }));
    }

    // Security summary
    let has_nx = elf.program_headers.iter().any(|ph| {
        ph.p_type == PT_GNU_STACK && (ph.p_flags & PF_X) == 0
    });
    let has_pie = header.e_type == 3; // ET_DYN
    let has_canary = elf.dynsyms.iter().any(|s| {
        let name = elf.dynstrtab.get_at(s.st_name).unwrap_or("");
        name.contains("__stack_chk_fail") || name.contains("__stack_chk_guard")
    });
    let has_relro = elf
        .program_headers
        .iter()
        .any(|ph| ph.p_type == PT_GNU_RELRO);
    let has_bind_now = elf
        .dynamic
        .as_ref()
        .map(|d| {
            d.dyns.iter().any(|e| {
                e.d_tag as u64 == DT_BIND_NOW
                    || (e.d_tag as u64 == DT_FLAGS && e.d_val & 0x8 != 0)
                    || (e.d_tag as u64 == DT_FLAGS_1 && e.d_val & 0x1 != 0)
            })
        })
        .unwrap_or(false);
    let relro_str = if has_relro && has_bind_now {
        "Full RELRO"
    } else if has_relro {
        "Partial RELRO"
    } else {
        "No RELRO"
    };
    let has_rwx = elf
        .program_headers
        .iter()
        .any(|ph| ph.p_type == PT_LOAD && ph.p_flags & (PF_R | PF_W | PF_X) == (PF_R | PF_W | PF_X));

    json!({
        "format": "ELF",
        "path": path,
        "size": data.len(),
        "sha256": util::sha256_hex(data),
        "class": class_str,
        "encoding": encoding_str,
        "type": type_str,
        "machine": machine_str,
        "entry": format!("0x{:08x}", header.e_entry),
        "program_headers": phdrs,
        "section_headers": shdrs,
        "dynamic": dynamic_entries,
        "dynsyms": dynsyms,
        "dynsyms_total": elf.dynsyms.len(),
        "symtab": symtab,
        "symtab_total": elf.syms.len(),
        "relocations": relocs,
        "relocations_total": elf.dynrelas.len() + elf.dynrels.len() + elf.pltrelocs.len(),
        "security": {
            "relro": relro_str,
            "canary": has_canary,
            "nx": has_nx,
            "pie": has_pie,
            "rwx_segments": has_rwx,
        },
        "libraries": elf.libraries.iter().collect::<Vec<_>>(),
        "interpreter": elf.interpreter,
        "is_stripped": elf.syms.is_empty(),
    })
}

pub fn sections_only(data: &[u8], path: &str) -> Value {
    let elf = match Elf::parse(data) {
        Ok(e) => e,
        Err(e) => return json!({"error": format!("ELF parse failed: {e}"), "path": path}),
    };
    let sections: Vec<Value> = elf
        .section_headers
        .iter()
        .filter(|sh| sh.sh_size > 0)
        .map(|sh| {
            let name = elf.shdr_strtab.get_at(sh.sh_name).unwrap_or("");
            let ent = util::shannon_entropy(
                util::bounded_slice(data, sh.sh_offset, sh.sh_size),
            );
            json!({
                "name": name,
                "type": shdr_type_name(sh.sh_type),
                "addr": format!("0x{:08x}", sh.sh_addr),
                "size": sh.sh_size,
                "entropy": (ent * 1000.0).round() / 1000.0,
            })
        })
        .collect();
    json!({
        "format": "ELF",
        "path": path,
        "machine": machine_name(elf.header.e_machine),
        "sections": sections,
    })
}

fn machine_name(m: u16) -> &'static str {
    match m {
        0 => "None",
        3 => "Intel 80386",
        8 => "MIPS",
        20 => "PowerPC",
        40 => "ARM",
        50 => "IA-64",
        62 => "Advanced Micro Devices X86-64",
        183 => "AArch64",
        243 => "RISC-V",
        _ => "Unknown",
    }
}

fn phdr_type_name(t: u32) -> &'static str {
    match t {
        PT_NULL => "NULL",
        PT_LOAD => "LOAD",
        PT_DYNAMIC => "DYNAMIC",
        PT_INTERP => "INTERP",
        PT_NOTE => "NOTE",
        PT_SHLIB => "SHLIB",
        PT_PHDR => "PHDR",
        PT_TLS => "TLS",
        PT_GNU_EH_FRAME => "GNU_EH_FRAME",
        PT_GNU_STACK => "GNU_STACK",
        PT_GNU_RELRO => "GNU_RELRO",
        _ => "UNKNOWN",
    }
}

fn shdr_type_name(t: u32) -> &'static str {
    match t {
        SHT_NULL => "NULL",
        SHT_PROGBITS => "PROGBITS",
        SHT_SYMTAB => "SYMTAB",
        SHT_STRTAB => "STRTAB",
        SHT_RELA => "RELA",
        SHT_HASH => "HASH",
        SHT_DYNAMIC => "DYNAMIC",
        SHT_NOTE => "NOTE",
        SHT_NOBITS => "NOBITS",
        SHT_REL => "REL",
        SHT_DYNSYM => "DYNSYM",
        SHT_INIT_ARRAY => "INIT_ARRAY",
        SHT_FINI_ARRAY => "FINI_ARRAY",
        SHT_GNU_HASH => "GNU_HASH",
        SHT_GNU_VERDEF => "VERDEF",
        SHT_GNU_VERNEED => "VERNEED",
        SHT_GNU_VERSYM => "VERSYM",
        _ => "OTHER",
    }
}

fn shdr_flags_str(flags: u32) -> String {
    let mut s = String::new();
    if flags & SHF_WRITE as u32 != 0 { s.push('W'); }
    if flags & SHF_ALLOC as u32 != 0 { s.push('A'); }
    if flags & SHF_EXECINSTR as u32 != 0 { s.push('X'); }
    if flags & SHF_MERGE as u32 != 0 { s.push('M'); }
    if flags & SHF_STRINGS as u32 != 0 { s.push('S'); }
    if s.is_empty() { s.push('-'); }
    s
}

fn sym_type_name(t: u8) -> &'static str {
    match t {
        STT_NOTYPE => "NOTYPE",
        STT_OBJECT => "OBJECT",
        STT_FUNC => "FUNC",
        STT_SECTION => "SECTION",
        STT_FILE => "FILE",
        STT_COMMON => "COMMON",
        STT_TLS => "TLS",
        STT_GNU_IFUNC => "IFUNC",
        _ => "?",
    }
}

fn sym_bind_name(b: u8) -> &'static str {
    match b {
        STB_LOCAL => "LOCAL",
        STB_GLOBAL => "GLOBAL",
        STB_WEAK => "WEAK",
        STB_GNU_UNIQUE => "UNIQUE",
        _ => "?",
    }
}

fn dyn_tag_name(tag: u64) -> &'static str {
    match tag {
        0 => "NULL",
        1 => "NEEDED",
        2 => "PLTRELSZ",
        3 => "PLTGOT",
        4 => "HASH",
        5 => "STRTAB",
        6 => "SYMTAB",
        7 => "RELA",
        8 => "RELASZ",
        9 => "RELAENT",
        10 => "STRSZ",
        11 => "SYMENT",
        12 => "INIT",
        13 => "FINI",
        14 => "SONAME",
        15 => "RPATH",
        29 => "RUNPATH",
        20 => "JMPREL",
        23 => "PLTREL",
        25 => "INIT_ARRAY",
        26 => "FINI_ARRAY",
        27 => "INIT_ARRAYSZ",
        28 => "FINI_ARRAYSZ",
        30 => "FLAGS",
        0x6ffffef5 => "GNU_HASH",
        0x6ffffff0 => "VERSYM",
        0x6ffffffe => "VERNEED",
        0x6fffffff => "VERNEEDNUM",
        0x6ffffff9 => "RELACOUNT",
        0x6ffffffb => "FLAGS_1",
        _ => "?",
    }
}

fn reloc_type_name(machine: u16, rtype: u32) -> &'static str {
    if machine == 62 {
        // x86_64
        match rtype {
            0 => "R_X86_64_NONE",
            1 => "R_X86_64_64",
            2 => "R_X86_64_PC32",
            5 => "R_X86_64_COPY",
            6 => "R_X86_64_GLOB_DAT",
            7 => "R_X86_64_JUMP_SLOT",
            8 => "R_X86_64_RELATIVE",
            10 => "R_X86_64_32",
            11 => "R_X86_64_32S",
            _ => "R_X86_64_?",
        }
    } else if machine == 183 {
        // AArch64
        match rtype {
            0 => "R_AARCH64_NONE",
            257 => "R_AARCH64_ABS64",
            258 => "R_AARCH64_ABS32",
            1025 => "R_AARCH64_GLOB_DAT",
            1026 => "R_AARCH64_JUMP_SLOT",
            1027 => "R_AARCH64_RELATIVE",
            1028 => "R_AARCH64_TLS_DTPREL64",
            1029 => "R_AARCH64_TLS_DTPMOD64",
            1030 => "R_AARCH64_TLS_TPREL64",
            1031 => "R_AARCH64_TLSDESC",
            _ => "R_AARCH64_?",
        }
    } else {
        "?"
    }
}
