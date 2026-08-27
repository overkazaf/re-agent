---
name: batch-apk-analysis
description: Batch APK workflow — scan a directory of APKs, classify by framework/packer, group similar apps, and generate per-group reverse engineering writeups automatically.
tags: batch apk android bulk workflow writeup classify group
---

# Batch APK Analysis

Use this when the operator has multiple APK files to analyze in one shot.
Typical triggers: "analyze all APKs in this folder", "batch reverse these apps",
"classify and group these APKs", "write up findings for these Android apps".

This workflow replaces the repetitive per-APK manual triage with an automated
pipeline: discover → inspect → classify → group → writeup.

## Workflow

1. **Discover**: Run `batch_analyze` on the target directory. It scans for `.apk`
   files, inspects each one (packer, framework, native libs, DEX count, assets),
   clusters them by framework+packer fingerprint, and returns a grouped report.

2. **Review groups**: Read the batch report. Each group shares a framework and
   packer profile. Decide which groups need deeper analysis — prioritize by:
   - Groups with a packer (harder targets, likely protecting something valuable).
   - Groups with native libraries (crypto, signing, anti-tamper live here).
   - Groups with unusual assets (embedded DBs, configs, keys).

3. **Deep-dive per group**: For the priority groups, pick one representative APK
   and run the full `android-apk-frida` skill on it. Findings from the
   representative usually apply to the whole group because they share the same
   framework and packer.

4. **Cross-group comparison**: After analyzing representative APKs from each group,
   compare shared native libraries across groups. A `libsecure.so` that appears in
   both a Flutter group and a React Native group is likely a company-wide SDK —
   crack it once and it opens both groups.

5. **Writeup**: Generate a structured writeup covering:
   - Scope: how many APKs, directory, date.
   - Group summary table: group label, count, packer, framework, representative APK.
   - Per-group findings: protection level, key classes/functions, hook targets, bypass notes.
   - Cross-group patterns: shared SDKs, common signing keys, reused native libs.
   - Recommendations: which groups to prioritize, estimated effort per group.

## Using batch_analyze

```text
/batch ./apks
/batch ./apks --output ./reports
```

Or from a prompt:

```text
Use batch_analyze on ./apks, classify the results, and write a grouped report.
```

The tool accepts:
- `path`: directory to scan (required).
- `maxDepth`: scan depth (default 3, max 10).
- `maxApks`: cap on APKs to inspect (default 50, max 200).
- `outputDir`: write per-group `.txt` reports and a summary (requires `--write`).

## Writeup Template

Use this structure for the final writeup:

```markdown
# Batch APK Analysis Report

**Scope**: {count} APKs from `{directory}`
**Date**: {date}
**Analyst**: 0xAF-Re

## Summary

| Group | Count | Framework | Packer | Representative |
|-------|-------|-----------|--------|----------------|
| 1     | 5     | Flutter   | 360    | app-a.apk      |
| 2     | 3     | RN        | none   | app-b.apk      |

## Group 1: Flutter + 360 Jiagu

**Protection**: 360 jiagu packing on all 5 APKs.
**Key targets**: libapp.so (Dart AOT), libjiagu.so (unpacking stub).
**Approach**: Bypass 360 packer → dump libapp.so → extract Dart symbols → hook.
**Effort**: Medium — packer bypass is well-documented, Dart reversing is the real work.

### Shared Libraries
- libflutter.so — standard Flutter engine
- libapp.so — Dart AOT compiled application code
- libjiagu.so — 360 packer stub

### Hook Targets
- `com.example.app.crypto.SignHelper.sign` — likely API signature
- `libapp.so!_kDartIsolateSnapshotInstructions` — Dart entry

## Group 2: React Native (unpacked)
...

## Cross-Group Patterns
- `libnetease-sec.so` appears in groups 1, 2, 3 — likely a shared security SDK.
- All APKs use the same signing certificate — same publisher.

## Recommendations
1. Priority: Group 1 (packed, likely protecting crypto/auth logic).
2. Quick win: Group 2 (unpacked RN, bundle is readable JS).
3. Shared: Reverse `libnetease-sec.so` once, apply to all groups.
```

## Decision Hints

- If all APKs use the same packer, that packer is the single gate — bypass it once.
- If a group has only 1 APK, it is an outlier — may be more interesting or less.
- If native libs are identical across groups, the app-level code differs but the
  security SDK is shared — reverse the SDK, not each app individually.
- Use `--output` to persist reports when the batch is large; the agent can read
  them back with `read_file` for deeper analysis without re-running the scan.
