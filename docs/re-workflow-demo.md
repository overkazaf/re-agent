# RE Workflow Demo

Two walkthroughs showing 0xAF-Re's interactive reverse workflow end to end.

---

## Demo 1: XOR Token Checker (`demos/welcome/chall.js`)

A Node.js challenge that XOR-encodes a secret token and compares user input.

### Enter reverse mode

```
0xAF ▸ /workflow reverse

╭─ 0xAF TARGET TYPE ─────────────────╮
│  1  APK         Android package    │
│  2  SO          Shared object      │
│  3  dylib       macOS dynamic lib  │
│  4  ELF         Linux binary       │
│  5  PE          Windows binary     │
│  6  firmware    Embedded firmware   │
│  7  PCAP        Network capture    │
│  s  skip                           │
╰─────────────────────────────────────╯
> 4

╭─ ELF prompts ───────────────────────╮
│  1  Triage ELF structure            │
│  2  Identify crypto constants       │
│  3  Recover exported symbols        │
│  c  custom prompt                   │
╰──────────────────────────────────────╯
> c
Custom prompt: Read demos/welcome/chall.js and identify the encoding scheme, key, and encoded data.
```

The agent enters **triage** phase. The HUD shows:

```
 ── RE: ELF ──────────────────────────────────────────────
 ▸TRI → STA → DYN → EVI → IFC → HYP → VER → AUD → WRI
 ▰▱▱▱▱▱▱▱▱  1/9  H:0 E:0
```

### Prompt 1 — Triage (automatic from picker)

> Read demos/welcome/chall.js and identify the encoding scheme, key, and encoded data.

Agent response (abbreviated):

```
The file is a Node.js script. It uses single-byte XOR encoding.

  Key:     0x2a (decimal 42)
  Encoded: [26, 82, 75, 76, 81, 93, 75, 88, 71, 95, 90, 117, 78, 79, 73, 65, 87]

The script XORs each byte with the key and joins the result into a string,
then compares it against argv[2].

Hypothesis: the token is recoverable by applying the same XOR.
```

Every completed `read_file` / `ctf_triage` result is automatically stamped into `evidence-ledger.jsonl` (`ev_001`), and the agent records its hypothesis via `hypothesis_create`:

```json
{"claim": "Token is single-byte XOR with key 0x2a, directly recoverable", "basis": "static", "evidence": ["ev_001"], "confidence": 0.8}
```

### Prompt 2 — Static analysis: decode

```
0xAF[elf|triage] ▸ /phase next
phase → static

0xAF[elf|static] ▸ Decode the array: XOR each element with 0x2a, print the token as a string.
```

Agent response:

```
Decoded: 0xaf{warmup_deck}

Evidence logged (ev_002). The token starts with the expected flag prefix.
```

Agent advances the workflow with `update_re_state`:

```json
{"action": "advance"}
```

HUD:

```
 ── RE: ELF ──────────────────────────────────────────────
 TRI → STA → ▸DYN → EVI → IFC → HYP → VER → AUD → WRI
 ▰▰▰▱▱▱▱▱▱  3/9  H:1 E:2
```

### Prompt 3 — Verify & Audit

```
0xAF[elf|dynamic] ▸ Verify '0xaf{warmup_deck}' and a negative input against demos/welcome/chall.js using verify_artifact, then run /audit.
```

Agent calls `verify_artifact` (`replay_command: "node demos/welcome/chall.js"`, positive + negative cases), recording a `verification_result` (`ev_003`), updates `H-001` via `hypothesis_update` (`action: "confirm"`), and `/audit` records an `audit_finding` (`ev_004`):

```
$ node demos/welcome/chall.js '0xaf{warmup_deck}'
accepted

Verification passed (2/2 cases) · audit passed (ev_004).
```

### Prompt 4 — Writeup

```
0xAF[elf|audit] ▸ /phase writeup

0xAF[elf|writeup] ▸ Write a solve summary.
```

Agent response:

```
## Solve: welcome/chall.js

**Sample:** Node.js XOR token checker
**Technique:** Single-byte XOR decode
**Key:** 0x2a
**Token:** 0xaf{warmup_deck}
**Verification:** `node chall.js '0xaf{warmup_deck}'` → accepted

The encoded array is XORed byte-by-byte with a constant stored in the
same file. No obfuscation beyond the trivial XOR.
```

**4 prompts total.** Phase progression: triage → static → dynamic → writeup.

---

## Demo 2: Binary Carrier Analysis (`demos/reverse-lab/carrier.bin`)

A 121-byte binary that concatenates a prefix, noise, an embedded PDF stub, more noise, and a ZIP marker.

### Enter reverse mode

```
0xAF ▸ /workflow reverse

> 6  (firmware)

╭─ firmware prompts ──────────────────╮
│  1  Map firmware layout             │
│  2  Find crypto constants           │
│  3  Locate debug interfaces         │
│  c  custom prompt                   │
╰──────────────────────────────────────╯
> c
Custom prompt: Triage demos/reverse-lab/carrier.bin — identify file type, size, and any embedded signatures.
```

### Prompt 1 — Triage

> Triage demos/reverse-lab/carrier.bin — identify file type, size, and any embedded signatures.

Agent response:

```
carrier.bin (121 bytes):
  Offset 0x00: ASCII text "carrier-prefix"
  Offset 0x21: %PDF-1.7 signature → embedded PDF document
  Offset 0x5F: PK\x03\x04 signature → embedded ZIP archive

Not a standard ELF/PE/Mach-O. This is a custom carrier that concatenates
a prefix, noise, a minimal PDF, more noise, and a ZIP marker.

Hypotheses:
  H1: The PDF is a minimal stub (catalog + EOF only)
  H2: The ZIP may contain the actual payload
```

`hypothesis_create`:

```json
{"claim": "PDF at offset 0x21 is a minimal stub (catalog only)", "basis": "static", "evidence": ["ev_001"]}
{"claim": "ZIP at offset 0x5F may contain the real payload", "basis": "static", "evidence": ["ev_001"]}
```

### Prompt 2 — Static analysis: carve and examine

```
0xAF[firmware|triage] ▸ /phase next

0xAF[firmware|static] ▸ Carve the embedded PDF (offset 33 to %%EOF) and the ZIP section. Show their contents.
```

Agent response:

```
PDF (offset 33–92, 60 bytes):
  %PDF-1.7
  1 0 obj << /Type /Catalog >> endobj
  %%EOF
  → Minimal valid PDF with a single Catalog object, no pages or streams.
  → No hidden JavaScript, no embedded files.

ZIP (offset 95–120, 26 bytes):
  PK\x03\x04 header followed by "demo zip marker"
  → Not a valid ZIP archive — the header is present but the central
    directory and end-of-central-directory records are missing.
  → This is a signature marker, not extractable content.

Evidence:
  - PDF is a skeleton: 1 object, no content
  - ZIP marker is incomplete / non-functional
```

Tool observations are auto-stamped into `evidence-ledger.jsonl`, and `update_re_state` advances the phase:

```json
{"action": "advance"}
```

### Prompt 3 — Cross-reference with artifact.txt

```
0xAF[firmware|dynamic] ▸ Now read demos/reverse-lab/artifact.txt. It is the companion CTF artifact. Decode the base64 string and correlate with carrier.bin findings.
```

Agent response:

```
artifact.txt contains:
  - base64: ZmxhZ3tkZW1vX3JldmVyc2VfbGFiX2ZsYWd9
    Decoded: flag{demo_reverse_lab_flag}
  - Suspicious endpoint: https://ctf.example.invalid/api/sign
  - Crypto words: AES CBC HMAC SHA256 token secret
  - Pwn words: system /bin/sh printf strcpy

The base64 is the flag. The crypto/pwn keywords are red herrings — the
carrier.bin has no encrypted content and no executable code.

Revising hypotheses:
  H2 revised: ZIP marker is intentional noise, not a payload container.
  New: The flag was in artifact.txt all along; carrier.bin is a distraction
       or a secondary challenge (format identification).
```

`hypothesis_update`:

```json
{"id": "H-002", "action": "revise", "evidence": ["ev_004"], "revised_claim": "ZIP is intentional noise, not a payload — flag is in artifact.txt"}
```

### Prompt 4 — Hypothesis revision & writeup

```
0xAF[firmware|dynamic] ▸ /phase writeup

0xAF[firmware|writeup] ▸ Summarize the full analysis.
```

Agent response:

```
## Solve: reverse-lab

**Samples:** carrier.bin (121 B), artifact.txt
**Flag:** flag{demo_reverse_lab_flag}

### carrier.bin layout

| Offset | Content              | Notes              |
|--------|----------------------|--------------------|
| 0x00   | "carrier-prefix\n"   | ASCII header       |
| 0x10   | "noise noise noise"  | Padding            |
| 0x21   | %PDF-1.7 stub        | 1-object catalog   |
| 0x5C   | "more-noise"         | Padding            |
| 0x5F   | PK\x03\x04 marker    | Incomplete ZIP     |
| 0x75   | "final\n"            | Tail               |

### Findings

1. carrier.bin is a format-identification challenge: multiple embedded
   signatures but no real payloads.
2. The actual flag is base64-encoded in artifact.txt, not hidden in
   the binary.
3. The crypto/pwn keywords in artifact.txt are red herrings.
4. Solve technique: signature scanning + base64 decode.
```

**4 prompts total.** Phase progression: triage → static → dynamic → writeup.

---

## Key Commands Used

| Command | Purpose |
|---------|---------|
| `/workflow reverse` | Enter interactive RE mode with sample picker |
| `/phase` | Show current phase (1..9), hypothesis & evidence counts |
| `/phase next` | Advance to next phase (gate-checked against ledger) |
| `/phase writeup` | Jump to writeup phase once intermediate verification & audit gates pass |
| `/audit` | Run context-isolated adversarial audit before writeup |
| `/workflow off` | Exit RE mode |

## What the Agent Does Automatically

- Auto-stamps every completed tool result into `evidence-ledger.jsonl` (`ev_NNN`)
- Calls `hypothesis_create` / `hypothesis_update` to track and downgrade/revise claims (`H-NNN`)
- Calls `verify_artifact` to turn build/replay/diff runs into `verification_result` records
- Calls `update_re_state` (`advance` / `skip_to`) with deterministic 9-phase gate checks
- Wraps each prompt with phase-specific instructions and live HUD progress (`TRI → … → WRI`)
