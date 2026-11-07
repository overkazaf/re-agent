use crate::util;
use serde_json::{json, Value};

/// A contiguous region where the two files differ.
struct DiffRegion {
    /// Start of the context window (context bytes before the first diff).
    offset: usize,
    /// First differing byte.
    diff_start: usize,
    /// One past the last differing byte.
    diff_end: usize,
    bytes_a: Vec<u8>,
    bytes_b: Vec<u8>,
    notes: Vec<String>,
}

pub fn analyze(
    data_a: &[u8],
    data_b: &[u8],
    path_a: &str,
    path_b: &str,
    max_diffs: usize,
    context: usize,
) -> Value {
    let min_len = data_a.len().min(data_b.len());
    let mut matching: usize = 0;
    let mut regions: Vec<DiffRegion> = Vec::new();

    // Walk byte-by-byte, collecting diff regions.
    let mut i = 0;
    while i < min_len && regions.len() < max_diffs {
        if data_a[i] == data_b[i] {
            matching += 1;
            i += 1;
            continue;
        }
        // Start of a diff region. Extend to include all contiguous differences
        // (gaps of matching bytes < `context` merge adjacent regions).
        let start = i;
        let mut end = i;
        while end < min_len {
            if data_a[end] != data_b[end] {
                end += 1;
            } else {
                // Look ahead: if the next `context` bytes all match, end here.
                let look = end + context;
                let gap_end = look.min(min_len);
                if (end..gap_end).all(|j| data_a[j] == data_b[j]) {
                    break;
                }
                matching += 1;
                end += 1;
            }
        }
        // Add surrounding context
        let ctx_start = start.saturating_sub(context);
        let ctx_end = (end + context).min(min_len);
        let ba: Vec<u8> = data_a[ctx_start..ctx_end].to_vec();
        let bb: Vec<u8> = data_b[ctx_start..ctx_end].to_vec();

        // Auto-detect patch patterns
        let diff_a = &data_a[start..end];
        let diff_b = &data_b[start..end];
        let notes = detect_patch_patterns(diff_a, diff_b);

        regions.push(DiffRegion {
            offset: ctx_start,
            diff_start: start,
            diff_end: end,
            bytes_a: ba,
            bytes_b: bb,
            notes,
        });
        i = end;
    }
    // Count remaining matching bytes
    for j in i..min_len {
        if data_a[j] == data_b[j] {
            matching += 1;
        }
    }

    let match_pct = if min_len > 0 {
        (matching as f64 / min_len as f64) * 100.0
    } else {
        100.0
    };

    let regions_json: Vec<Value> = regions
        .iter()
        .enumerate()
        .map(|(idx, r)| {
            json!({
                "index": idx + 1,
                "offset": format!("0x{:08x}", r.offset),
                "length": r.bytes_a.len(),
                "diff_offset": format!("0x{:08x}", r.diff_start),
                "diff_length": r.diff_end - r.diff_start,
                "hex_a": util::hex_encode(&r.bytes_a),
                "hex_b": util::hex_encode(&r.bytes_b),
                "ascii_a": util::ascii_preview(&r.bytes_a, r.bytes_a.len()),
                "ascii_b": util::ascii_preview(&r.bytes_b, r.bytes_b.len()),
                "notes": r.notes,
            })
        })
        .collect();

    json!({
        "path_a": path_a,
        "path_b": path_b,
        "size_a": data_a.len(),
        "size_b": data_b.len(),
        "same_size": data_a.len() == data_b.len(),
        "compared_bytes": min_len,
        "matching_bytes": matching,
        "matching_pct": (match_pct * 10.0).round() / 10.0,
        "diff_regions": regions_json.len(),
        "regions": regions_json,
        "size_delta": data_b.len() as i64 - data_a.len() as i64,
    })
}

fn detect_patch_patterns(a: &[u8], b: &[u8]) -> Vec<String> {
    let mut notes = Vec::new();
    if a.is_empty() || b.is_empty() {
        return notes;
    }

    // NOP sled
    if b.iter().all(|&x| x == 0x90) && !a.iter().all(|&x| x == 0x90) {
        notes.push("NOP sled patch".into());
    }

    // Zeroed out
    if b.iter().all(|&x| x == 0x00) && a.iter().any(|&x| x != 0x00) {
        notes.push("zeroed-out region".into());
    }

    // Single-byte conditional branch flip (x86)
    if a.len() == 1 && b.len() == 1 {
        let branch_flips = [
            (0x74, 0x75, "JE→JNE"),
            (0x75, 0x74, "JNE→JE"),
            (0x74, 0xEB, "JE→JMP (unconditional)"),
            (0x75, 0xEB, "JNE→JMP (unconditional)"),
            (0x7C, 0x7D, "JL→JGE"),
            (0x7D, 0x7C, "JGE→JL"),
            (0x7E, 0x7F, "JLE→JG"),
            (0x7F, 0x7E, "JG→JLE"),
            (0x72, 0x73, "JB→JAE"),
            (0x73, 0x72, "JAE→JB"),
            (0x76, 0x77, "JBE→JA"),
            (0x77, 0x76, "JA→JBE"),
        ];
        for &(from, to, label) in &branch_flips {
            if a[0] == from && b[0] == to {
                notes.push(format!("conditional branch flip: {label}"));
            }
        }
    }

    // Two-byte conditional branch flip (near jcc: 0F 84 <-> 0F 85 etc.)
    if a.len() >= 2 && b.len() >= 2 && a[0] == 0x0F && b[0] == 0x0F {
        let near_flips = [
            (0x84, 0x85, "JE→JNE (near)"),
            (0x85, 0x84, "JNE→JE (near)"),
            (0x8C, 0x8D, "JL→JGE (near)"),
            (0x8D, 0x8C, "JGE→JL (near)"),
            (0x8E, 0x8F, "JLE→JG (near)"),
            (0x8F, 0x8E, "JG→JLE (near)"),
        ];
        for &(from, to, label) in &near_flips {
            if a[1] == from && b[1] == to {
                notes.push(format!("conditional branch flip: {label}"));
            }
        }
    }

    // CALL/JMP target redirect (E8/E9 with different rel32)
    if a.len() == 5 && b.len() == 5 && a[0] == b[0] && (a[0] == 0xE8 || a[0] == 0xE9) {
        let kind = if a[0] == 0xE8 { "CALL" } else { "JMP" };
        notes.push(format!("{kind} target redirected"));
    }

    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_files_no_regions() {
        let v = analyze(b"same", b"same", "a", "b", 100, 8);
        assert_eq!(v["diff_regions"], 0);
        assert_eq!(v["matching_pct"], 100.0);
    }

    #[test]
    fn single_byte_diff_detected_with_location() {
        let a = b"AAAA BBBB";
        let b = b"AAAA CBBB";
        let v = analyze(a, b, "a", "b", 100, 2);
        assert_eq!(v["diff_regions"], 1);
        let r = &v["regions"][0];
        assert_eq!(r["diff_offset"], "0x00000005");
        assert_eq!(r["diff_length"], 1);
    }

    #[test]
    fn size_mismatch_counted() {
        let v = analyze(b"abc", b"abcdef", "a", "b", 100, 8);
        assert_eq!(v["same_size"], false);
        assert_eq!(v["compared_bytes"], 3);
        assert_eq!(v["matching_bytes"], 3);
        assert_eq!(v["size_delta"], 3);
    }

    #[test]
    fn max_diffs_respected() {
        let a = [0u8; 40];
        let mut b = [0u8; 40];
        for i in (0..40).step_by(4) {
            b[i] = 1;
        }
        let v = analyze(&a, &b, "a", "b", 2, 1);
        assert_eq!(v["diff_regions"], 2);
    }

    #[test]
    fn patch_patterns() {
        assert_eq!(detect_patch_patterns(&[0x74], &[0x90]), ["NOP sled patch"]);
        assert_eq!(detect_patch_patterns(&[0x74], &[0xEB]), ["conditional branch flip: JE→JMP (unconditional)"]);
        assert_eq!(detect_patch_patterns(&[0x74], &[0x75]), ["conditional branch flip: JE→JNE"]);
        assert_eq!(detect_patch_patterns(&[0x0F, 0x84, 0, 0, 0, 0], &[0x0F, 0x85, 0, 0, 0, 0]), ["conditional branch flip: JE→JNE (near)"]);
        assert!(detect_patch_patterns(&[0xE8, 0, 0, 0, 0], &[0xE8, 1, 1, 1, 1]).contains(&"CALL target redirected".to_string()));
    }
}
