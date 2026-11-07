use sha2::{Digest, Sha256};

pub fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

pub fn shannon_entropy(data: &[u8]) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &b in data {
        counts[b as usize] += 1;
    }
    let len = data.len() as f64;
    let mut entropy = 0.0f64;
    for &c in &counts {
        if c == 0 {
            continue;
        }
        let p = c as f64 / len;
        entropy -= p * p.log2();
    }
    entropy
}

pub fn ascii_preview(data: &[u8], max: usize) -> String {
    data.iter()
        .take(max)
        .map(|&b| if b >= 0x20 && b <= 0x7e { b as char } else { '.' })
        .collect()
}

/// Extract printable ASCII strings of at least `min_len` characters.
pub fn extract_strings(data: &[u8], min_len: usize) -> Vec<(usize, String)> {
    let mut results = Vec::new();
    let mut current = String::new();
    let mut start = 0;
    for (i, &b) in data.iter().enumerate() {
        if b >= 0x20 && b <= 0x7e {
            if current.is_empty() {
                start = i;
            }
            current.push(b as char);
        } else {
            if current.len() >= min_len {
                results.push((start, std::mem::take(&mut current)));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= min_len {
        results.push((start, current));
    }
    results
}

/// Slice `data` at a file offset/length taken from untrusted binary headers.
///
/// Overflow-safe (headers may hold values near u64::MAX) and bounds-safe:
/// the result is clamped to the file and is never a panic. Returns the
/// available prefix of the requested range rather than nothing when the
/// range runs past EOF.
pub fn bounded_slice(data: &[u8], offset: u64, len: u64) -> &[u8] {
    let start = (offset as usize).min(data.len());
    let end64 = offset.saturating_add(len).min(data.len() as u64);
    let end = end64 as usize;
    if start >= end {
        &[]
    } else {
        &data[start..end]
    }
}

/// Find all occurrences of `needle` in `haystack`.
pub fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return Vec::new();
    }
    let mut results = Vec::new();
    let mut pos = 0;
    while pos + needle.len() <= haystack.len() {
        if let Some(idx) = haystack[pos..].windows(needle.len()).position(|w| w == needle) {
            results.push(pos + idx);
            pos = pos + idx + 1;
        } else {
            break;
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_sha() {
        assert_eq!(hex_encode(&[0xde, 0xad]), "dead");
        assert_eq!(sha256_hex(b"abc").len(), 64);
    }

    #[test]
    fn entropy_bounds() {
        assert_eq!(shannon_entropy(b""), 0.0);
        assert!((shannon_entropy(&[0u8; 16]) - 0.0).abs() < 1e-9);
        let e = shannon_entropy(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        assert!((e - 4.0).abs() < 1e-9);
    }

    #[test]
    fn extract_strings_minlen_and_offset() {
        let data = b"ab\x00longstring\x01tail";
        let s = extract_strings(data, 4);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], (3, "longstring".to_string()));
        assert_eq!(s[1], (14, "tail".to_string()));
    }

    #[test]
    fn find_all_overlapping() {
        assert_eq!(find_all(b"aaa", b"aa"), vec![0, 1]);
        assert!(find_all(b"abc", b"").is_empty());
        assert!(find_all(b"ab", b"abc").is_empty());
    }

    #[test]
    fn bounded_slice_is_safe_and_correct() {
        let data = [10u8, 11, 12, 13, 14];
        assert_eq!(bounded_slice(&data, 1, 2), &[11, 12]);
        // Runs past EOF: clamped, not empty-by-failure
        assert_eq!(bounded_slice(&data, 3, 99), &[13, 14]);
        // Out of range entirely
        assert!(bounded_slice(&data, 50, 5).is_empty());
        // u64 overflow of offset+len must not panic or wrap
        assert_eq!(bounded_slice(&data, u64::MAX - 3, 10).len(), 0);
        assert!(bounded_slice(&data, u64::MAX, u64::MAX).is_empty());
    }
}
