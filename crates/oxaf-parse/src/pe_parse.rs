use crate::util;
use goblin::pe::PE;
use serde_json::{json, Value};

pub fn analyze(data: &[u8], path: &str) -> Value {
    let pe = match PE::parse(data) {
        Ok(p) => p,
        Err(e) => return json!({"error": format!("PE parse failed: {e}"), "path": path}),
    };

    let header = &pe.header;
    let coff = &header.coff_header;
    let machine_str = pe_machine_name(coff.machine);
    let timestamp = coff.time_date_stamp;
    let characteristics = coff_characteristics(coff.characteristics);

    // Optional header
    let opt = header.optional_header.as_ref();
    let is_64 = opt.map_or(false, |o| o.standard_fields.magic == 0x20b);
    let entry = opt.map_or(0, |o| o.standard_fields.address_of_entry_point as u64);
    let image_base = opt.map_or(0, |o| o.windows_fields.image_base);
    let subsystem = opt.map_or(0, |o| o.windows_fields.subsystem);
    let dll_characteristics = opt.map_or(0, |o| o.windows_fields.dll_characteristics);

    // Security flags
    let aslr = dll_characteristics & 0x0040 != 0;
    let high_entropy = dll_characteristics & 0x0020 != 0;
    let dep_nx = dll_characteristics & 0x0100 != 0;
    let cfg = dll_characteristics & 0x4000 != 0;
    let no_seh = dll_characteristics & 0x0400 != 0;
    let force_integrity = dll_characteristics & 0x0080 != 0;
    let has_cert = opt
        .and_then(|o| o.data_directories.get_certificate_table())
        .map_or(false, |d| d.virtual_address != 0);

    // Sections
    let sections: Vec<Value> = pe
        .sections
        .iter()
        .map(|s| {
            let name = String::from_utf8_lossy(&s.name)
                .trim_end_matches('\0')
                .to_string();
            let chars = pe_section_chars(s.characteristics);
            let section_data =
                util::bounded_slice(data, s.pointer_to_raw_data as u64, s.size_of_raw_data as u64);
            json!({
                "name": name,
                "virtual_size": format!("0x{:08x}", s.virtual_size),
                "virtual_address": format!("0x{:08x}", s.virtual_address),
                "raw_size": format!("0x{:08x}", s.size_of_raw_data),
                "raw_offset": format!("0x{:08x}", s.pointer_to_raw_data),
                "characteristics": chars,
                "entropy": (util::shannon_entropy(section_data) * 1000.0).round() / 1000.0,
            })
        })
        .collect();

    // Imports
    let imports: Vec<Value> = pe
        .imports
        .iter()
        .take(300)
        .map(|imp| {
            json!({
                "dll": imp.dll,
                "name": imp.name,
                "ordinal": imp.ordinal,
                "offset": format!("0x{:08x}", imp.offset),
                "rva": format!("0x{:08x}", imp.rva),
            })
        })
        .collect();

    // Group imports by DLL
    let mut dll_map: std::collections::BTreeMap<&str, Vec<&str>> = std::collections::BTreeMap::new();
    for imp in pe.imports.iter() {
        dll_map.entry(imp.dll.as_ref()).or_default().push(imp.name.as_ref());
    }
    let import_dlls: Vec<Value> = dll_map
        .iter()
        .map(|(dll, funcs)| json!({"dll": dll, "functions": funcs.len(), "names": &funcs[..funcs.len().min(20)]}))
        .collect();

    // Exports
    let exports: Vec<Value> = pe
        .exports
        .iter()
        .take(200)
        .map(|exp| {
            json!({
                "name": exp.name.unwrap_or("(ordinal)"),
                "offset": format!("0x{:08x}", exp.offset.unwrap_or(0)),
                "rva": format!("0x{:08x}", exp.rva),
                "reexport": exp.reexport.as_ref().map(|r| format!("{:?}", r)),
            })
        })
        .collect();

    // Data directories
    let data_dirs: Vec<Value> = if let Some(o) = opt {
        let dd = &o.data_directories;
        let names = [
            "Export", "Import", "Resource", "Exception", "Certificate",
            "BaseReloc", "Debug", "Architecture", "GlobalPtr", "TLS",
            "LoadConfig", "BoundImport", "IAT", "DelayImport", "CLR", "Reserved",
        ];
        (0..16)
            .filter_map(|i| {
                let entry = match i {
                    0 => dd.get_export_table(),
                    1 => dd.get_import_table(),
                    2 => dd.get_resource_table(),
                    3 => dd.get_exception_table(),
                    4 => dd.get_certificate_table(),
                    5 => dd.get_base_relocation_table(),
                    6 => dd.get_debug_table(),
                    9 => dd.get_tls_table(),
                    12 => dd.get_import_address_table(),
                    14 => dd.get_clr_runtime_header(),
                    _ => None,
                };
                entry.map(|e| {
                    json!({
                        "name": names.get(i).unwrap_or(&"?"),
                        "rva": format!("0x{:08x}", e.virtual_address),
                        "size": format!("0x{:08x}", e.size),
                    })
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    json!({
        "format": "PE",
        "path": path,
        "size": data.len(),
        "sha256": util::sha256_hex(data),
        "class": if is_64 { "PE32+" } else { "PE32" },
        "machine": machine_str,
        "timestamp": timestamp,
        "entry": format!("0x{:08x}", entry),
        "image_base": format!("0x{:016x}", image_base),
        "subsystem": subsystem_name(subsystem),
        "characteristics": characteristics,
        "sections": sections,
        "data_directories": data_dirs,
        "import_dlls": import_dlls,
        "imports_total": pe.imports.len(),
        "imports_sample": imports,
        "exports": exports,
        "exports_total": pe.exports.len(),
        "security": {
            "aslr": aslr,
            "high_entropy_va": high_entropy,
            "dep_nx": dep_nx,
            "cfg": cfg,
            "no_seh": no_seh,
            "force_integrity": force_integrity,
            "authenticode": has_cert,
        },
        "is_dll": pe.is_lib,
        "name": pe.name.unwrap_or(""),
    })
}

pub fn sections_only(data: &[u8], path: &str) -> Value {
    let pe = match PE::parse(data) {
        Ok(p) => p,
        Err(e) => return json!({"error": format!("PE parse failed: {e}"), "path": path}),
    };
    let sections: Vec<Value> = pe
        .sections
        .iter()
        .map(|s| {
            let name = String::from_utf8_lossy(&s.name)
                .trim_end_matches('\0')
                .to_string();
            let section_data =
                util::bounded_slice(data, s.pointer_to_raw_data as u64, s.size_of_raw_data as u64);
            json!({
                "name": name,
                "type": pe_section_type(s.characteristics),
                "virtual_size": s.virtual_size,
                "raw_size": s.size_of_raw_data,
                "entropy": (util::shannon_entropy(section_data) * 1000.0).round() / 1000.0,
                "characteristics": pe_section_chars(s.characteristics),
            })
        })
        .collect();
    let machine = pe_machine_name(pe.header.coff_header.machine);
    json!({
        "format": "PE",
        "path": path,
        "machine": machine,
        "sections": sections,
    })
}

fn pe_section_type(chars: u32) -> &'static str {
    const CNT_CODE: u32 = 0x0000_0020;
    const CNT_UNINIT_DATA: u32 = 0x0000_0080;
    const CNT_INIT_DATA: u32 = 0x0000_0040;
    if chars & CNT_CODE != 0 {
        "CODE"
    } else if chars & CNT_UNINIT_DATA != 0 {
        "BSS"
    } else if chars & CNT_INIT_DATA != 0 {
        "DATA"
    } else {
        "OTHER"
    }
}

fn pe_machine_name(m: u16) -> &'static str {
    match m {
        0x14c => "x86 (i386)",
        0x8664 => "x86-64 (AMD64)",
        0x1c0 => "ARM",
        0xaa64 => "ARM64 (AArch64)",
        0x1c4 => "ARMv7 Thumb-2",
        0x5032 => "RISC-V 32",
        0x5064 => "RISC-V 64",
        _ => "Unknown",
    }
}

fn subsystem_name(s: u16) -> &'static str {
    match s {
        1 => "Native",
        2 => "Windows GUI",
        3 => "Windows Console",
        5 => "OS/2 Console",
        7 => "POSIX Console",
        10 => "EFI Application",
        11 => "EFI Boot Service Driver",
        12 => "EFI Runtime Driver",
        14 => "Xbox",
        _ => "Unknown",
    }
}

fn coff_characteristics(c: u16) -> Vec<&'static str> {
    let mut flags = Vec::new();
    if c & 0x0002 != 0 { flags.push("EXECUTABLE_IMAGE"); }
    if c & 0x0020 != 0 { flags.push("LARGE_ADDRESS_AWARE"); }
    if c & 0x0100 != 0 { flags.push("32BIT_MACHINE"); }
    if c & 0x0200 != 0 { flags.push("DEBUG_STRIPPED"); }
    if c & 0x2000 != 0 { flags.push("DLL"); }
    flags
}

fn pe_section_chars(c: u32) -> Vec<&'static str> {
    let mut flags = Vec::new();
    if c & 0x00000020 != 0 { flags.push("CODE"); }
    if c & 0x00000040 != 0 { flags.push("INITIALIZED_DATA"); }
    if c & 0x00000080 != 0 { flags.push("UNINITIALIZED_DATA"); }
    if c & 0x20000000 != 0 { flags.push("EXECUTE"); }
    if c & 0x40000000 != 0 { flags.push("READ"); }
    if c & 0x80000000 != 0 { flags.push("WRITE"); }
    if c & 0x02000000 != 0 { flags.push("DISCARDABLE"); }
    flags
}
