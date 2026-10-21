mod anti;
mod diff;
mod elf_parse;
mod macho_parse;
mod pe_parse;
mod util;

use clap::{Parser, Subcommand};
use memmap2::Mmap;
use std::fs::File;
use std::process;

#[derive(Parser)]
#[command(name = "oxaf-parse", about = "Binary format parser for 0xAF-Re agent")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Deep ELF analysis
    Elf {
        /// Binary file path
        path: String,
    },
    /// Deep PE/COFF analysis
    Pe {
        /// Binary file path
        path: String,
    },
    /// Deep Mach-O analysis
    Macho {
        /// Binary file path
        path: String,
    },
    /// Auto-detect format and show section overview
    Sections {
        /// Binary file path
        path: String,
    },
    /// Byte-level binary diff
    Diff {
        /// First file
        path_a: String,
        /// Second file
        path_b: String,
        /// Max diff regions to report
        #[arg(long, default_value_t = 100)]
        max_diffs: usize,
        /// Context bytes around each diff
        #[arg(long, default_value_t = 8)]
        context: usize,
    },
    /// Anti-analysis detection scan
    Anti {
        /// Binary file path
        path: String,
    },
    /// Packer/protector detection
    Packer {
        /// Binary file path
        path: String,
    },
}

fn mmap_file(path: &str) -> Result<Mmap, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    unsafe { Mmap::map(&file) }.map_err(|e| format!("Cannot mmap {path}: {e}"))
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Cmd::Elf { ref path } => {
            let data = unwrap_or_exit(mmap_file(path));
            elf_parse::analyze(&data, path)
        }
        Cmd::Pe { ref path } => {
            let data = unwrap_or_exit(mmap_file(path));
            pe_parse::analyze(&data, path)
        }
        Cmd::Macho { ref path } => {
            let data = unwrap_or_exit(mmap_file(path));
            macho_parse::analyze(&data, path)
        }
        Cmd::Sections { ref path } => {
            let data = unwrap_or_exit(mmap_file(path));
            sections_auto(&data, path)
        }
        Cmd::Diff {
            ref path_a,
            ref path_b,
            max_diffs,
            context,
        } => {
            let da = unwrap_or_exit(mmap_file(path_a));
            let db = unwrap_or_exit(mmap_file(path_b));
            diff::analyze(&da, &db, path_a, path_b, max_diffs, context)
        }
        Cmd::Anti { ref path } => {
            let data = unwrap_or_exit(mmap_file(path));
            anti::analyze(&data, path)
        }
        Cmd::Packer { ref path } => {
            let data = unwrap_or_exit(mmap_file(path));
            anti::detect_packer(&data, path)
        }
    };
    println!("{}", serde_json::to_string(&result).unwrap());
}

fn unwrap_or_exit<T>(r: Result<T, String>) -> T {
    match r {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
    }
}

fn sections_auto(data: &[u8], path: &str) -> serde_json::Value {
    if data.len() >= 4 {
        if data.starts_with(b"\x7fELF") {
            return elf_parse::sections_only(data, path);
        }
        if data[0] == b'M' && data[1] == b'Z' {
            return pe_parse::sections_only(data, path);
        }
        let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if matches!(
            magic,
            0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe |
            // Mach-O universal (fat) binaries: big-endian 0xcafebabe on disk
            // (bytes ca fe ba be -> 0xbebafeca read LE), plus the byte-swapped
            // form goblin also accepts. Note this collides with Java class
            // files; Mach::parse will reject those as a malformed fat header.
            0xbebafeca | 0xcafebabe
        ) {
            return macho_parse::sections_only(data, path);
        }
    }
    serde_json::json!({
        "error": "Unknown binary format",
        "path": path,
        "magic_hex": util::hex_encode(data.get(..4).unwrap_or_default()),
    })
}
