import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, ToolContext } from "../types";
import { asNumber, asString, clip, resolveInside, textBlock } from "../utils";
import { validatePathRead } from "../security/policy";
import { spillIfLarge } from "./output";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export function createCryptoTools(): AgentTool[] {
  return [
    cryptoIdentifyTool,
    hashIdentifyTool,
    xorAnalyzeTool,
  ];
}

// ---------------------------------------------------------------------------
// Cryptographic constant signatures for crypto_identify
// ---------------------------------------------------------------------------

interface CryptoSignature {
  name: string;
  confidence: "high" | "medium" | "low";
  bytes: Buffer;
}

// AES forward S-Box (full 256 bytes)
const AES_SBOX = Buffer.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

// AES inverse S-Box (full 256 bytes)
const AES_INV_SBOX = Buffer.from([
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
  0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
  0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
  0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
  0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
  0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
  0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
  0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
  0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
  0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
  0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d,
]);

// AES Rcon (first 10 round constants, each is a single byte but stored as LE uint32 in most impls)
const AES_RCON = Buffer.from([
  0x01, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00,
  0x04, 0x00, 0x00, 0x00,
  0x08, 0x00, 0x00, 0x00,
  0x10, 0x00, 0x00, 0x00,
  0x20, 0x00, 0x00, 0x00,
  0x40, 0x00, 0x00, 0x00,
  0x80, 0x00, 0x00, 0x00,
  0x1b, 0x00, 0x00, 0x00,
  0x36, 0x00, 0x00, 0x00,
]);

// DES initial permutation table (first 16 values)
const DES_IP = Buffer.from([
  58, 50, 42, 34, 26, 18, 10, 2,
  60, 52, 44, 36, 28, 20, 12, 4,
]);

// DES S-box 1 (first row, 16 values as used in most implementations)
const DES_SBOX1 = Buffer.from([
  14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
]);

// MD5 T-table first 4 constants (little-endian uint32)
const MD5_T = Buffer.from([
  0x78, 0xa4, 0x6a, 0xd7, // 0xd76aa478
  0x56, 0xb7, 0xc7, 0xe8, // 0xe8c7b756
  0xdb, 0x70, 0x20, 0x24, // 0x242070db
  0xee, 0xce, 0xbd, 0xc1, // 0xc1bdceee
]);

// SHA-256 K constants first 8 (big-endian uint32)
const SHA256_K = Buffer.from([
  0x42, 0x8a, 0x2f, 0x98, // 0x428a2f98
  0x71, 0x37, 0x44, 0x91, // 0x71374491
  0xb5, 0xc0, 0xfb, 0xcf, // 0xb5c0fbcf
  0xe9, 0xb5, 0xdb, 0xa5, // 0xe9b5dba5
  0x39, 0x56, 0xc2, 0x5b, // 0x3956c25b
  0x59, 0xf1, 0x11, 0xf1, // 0x59f111f1
  0x92, 0x3f, 0x82, 0xa4, // 0x923f82a4
  0xab, 0x1c, 0x5e, 0xd5, // 0xab1c5ed5
]);

// SHA-256 K constants first 8 (little-endian uint32 — alternate layout used by some compilers)
const SHA256_K_LE = Buffer.from([
  0x98, 0x2f, 0x8a, 0x42,
  0x91, 0x44, 0x37, 0x71,
  0xcf, 0xfb, 0xc0, 0xb5,
  0xa5, 0xdb, 0xb5, 0xe9,
  0x5b, 0xc2, 0x56, 0x39,
  0xf1, 0x11, 0xf1, 0x59,
  0xa4, 0x82, 0x3f, 0x92,
  0xd5, 0x5e, 0x1c, 0xab,
]);

// SHA-1 initialization vector (big-endian)
const SHA1_IV = Buffer.from([
  0x67, 0x45, 0x23, 0x01,
  0xef, 0xcd, 0xab, 0x89,
  0x98, 0xba, 0xdc, 0xfe,
  0x10, 0x32, 0x54, 0x76,
  0xc3, 0xd2, 0xe1, 0xf0,
]);

// SHA-1 IV in little-endian (common in x86 implementations)
const SHA1_IV_LE = Buffer.from([
  0x01, 0x23, 0x45, 0x67,
  0x89, 0xab, 0xcd, 0xef,
  0xfe, 0xdc, 0xba, 0x98,
  0x76, 0x54, 0x32, 0x10,
  0xf0, 0xe1, 0xd2, 0xc3,
]);

// MD5 initialization vector (little-endian)
const MD5_IV = Buffer.from([
  0x01, 0x23, 0x45, 0x67,
  0x89, 0xab, 0xcd, 0xef,
  0xfe, 0xdc, 0xba, 0x98,
  0x76, 0x54, 0x32, 0x10,
]);

// CRC32 table — first 4 entries (LE uint32) for polynomial 0xEDB88320
const CRC32_TABLE = Buffer.from([
  0x00, 0x00, 0x00, 0x00, // crc32_tab[0] = 0x00000000
  0x96, 0x30, 0x07, 0x77, // crc32_tab[1] = 0x77073096
  0x2c, 0x61, 0x0e, 0xee, // crc32_tab[2] = 0xee0e612c
  0xba, 0x51, 0x09, 0x99, // crc32_tab[3] = 0x990951ba
]);

// TEA/XTEA delta constant
const TEA_DELTA_LE = Buffer.from([0xb9, 0x79, 0x37, 0x9e]); // 0x9e3779b9 LE
const TEA_DELTA_BE = Buffer.from([0x9e, 0x37, 0x79, 0xb9]); // 0x9e3779b9 BE

// Blowfish P-array initial values (first 4, big-endian uint32)
const BLOWFISH_P = Buffer.from([
  0x24, 0x3f, 0x6a, 0x88, // P[0] = 0x243f6a88
  0x85, 0xa3, 0x08, 0xd3, // P[1] = 0x85a308d3
  0x13, 0x19, 0x8a, 0x2e, // P[2] = 0x13198a2e
  0x03, 0x70, 0x73, 0x44, // P[3] = 0x03707344
]);

// Blowfish P-array (little-endian)
const BLOWFISH_P_LE = Buffer.from([
  0x88, 0x6a, 0x3f, 0x24,
  0xd3, 0x08, 0xa3, 0x85,
  0x2e, 0x8a, 0x19, 0x13,
  0x44, 0x73, 0x70, 0x03,
]);

// ChaCha20/Salsa20 "expand 32-byte k"
const CHACHA_CONST = Buffer.from("expand 32-byte k", "ascii");

// Salsa20 "expand 16-byte k"
const SALSA_CONST_16 = Buffer.from("expand 16-byte k", "ascii");

// Base64 standard alphabet
const BASE64_ALPHABET = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", "ascii");

// RSA public exponent 65537 (0x010001) — 3-byte big-endian
const RSA_E_65537 = Buffer.from([0x01, 0x00, 0x01]);

// RC4 initial state (first 32 bytes of 0x00..0xFF sequence — detects S-box init)
const RC4_INIT = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

// Whirlpool S-box (first 16 bytes)
const WHIRLPOOL_SBOX = Buffer.from([
  0x18, 0x23, 0xc6, 0xe8, 0x87, 0xb8, 0x01, 0x4f,
  0x36, 0xa6, 0xd2, 0xf5, 0x79, 0x6f, 0x91, 0x52,
]);

// SM4 S-box (first 16 bytes) — Chinese national standard
const SM4_SBOX = Buffer.from([
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7,
  0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
]);

const CRYPTO_SIGNATURES: CryptoSignature[] = [
  { name: "AES S-Box", confidence: "high", bytes: AES_SBOX },
  { name: "AES Inverse S-Box", confidence: "high", bytes: AES_INV_SBOX },
  { name: "AES Rcon", confidence: "medium", bytes: AES_RCON },
  { name: "DES Initial Permutation", confidence: "medium", bytes: DES_IP },
  { name: "DES S-Box 1", confidence: "medium", bytes: DES_SBOX1 },
  { name: "MD5 T-table (LE)", confidence: "high", bytes: MD5_T },
  { name: "SHA-256 K constants (BE)", confidence: "high", bytes: SHA256_K },
  { name: "SHA-256 K constants (LE)", confidence: "high", bytes: SHA256_K_LE },
  { name: "SHA-1 IV (BE)", confidence: "high", bytes: SHA1_IV },
  { name: "SHA-1 IV (LE)", confidence: "high", bytes: SHA1_IV_LE },
  { name: "MD5 IV", confidence: "medium", bytes: MD5_IV },
  { name: "CRC32 table (poly 0xEDB88320)", confidence: "medium", bytes: CRC32_TABLE },
  { name: "TEA/XTEA delta (LE)", confidence: "medium", bytes: TEA_DELTA_LE },
  { name: "TEA/XTEA delta (BE)", confidence: "medium", bytes: TEA_DELTA_BE },
  { name: "Blowfish P-array (BE)", confidence: "high", bytes: BLOWFISH_P },
  { name: "Blowfish P-array (LE)", confidence: "high", bytes: BLOWFISH_P_LE },
  { name: "ChaCha20/Salsa20 constant", confidence: "high", bytes: CHACHA_CONST },
  { name: "Salsa20 constant (16-byte key)", confidence: "high", bytes: SALSA_CONST_16 },
  { name: "Base64 alphabet", confidence: "medium", bytes: BASE64_ALPHABET },
  { name: "RSA exponent 65537", confidence: "low", bytes: RSA_E_65537 },
  { name: "RC4 state init (0x00..0x1F)", confidence: "low", bytes: RC4_INIT },
  { name: "Whirlpool S-Box", confidence: "high", bytes: WHIRLPOOL_SBOX },
  { name: "SM4 S-Box", confidence: "high", bytes: SM4_SBOX },
];

interface CryptoHit {
  offset: number;
  name: string;
  confidence: string;
  signatureHex: string;
}

function findCryptoConstants(data: Buffer, maxHits: number): CryptoHit[] {
  const hits: CryptoHit[] = [];
  for (const sig of CRYPTO_SIGNATURES) {
    let offset = 0;
    while (offset < data.length && hits.length < maxHits) {
      const idx = data.indexOf(sig.bytes, offset);
      if (idx < 0) break;
      hits.push({
        offset: idx,
        name: sig.name,
        confidence: sig.confidence,
        signatureHex: sig.bytes.subarray(0, Math.min(16, sig.bytes.length)).toString("hex"),
      });
      offset = idx + 1;
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

// ---------------------------------------------------------------------------
// Tool 1: crypto_identify
// ---------------------------------------------------------------------------

const cryptoIdentifyTool: AgentTool = {
  name: "crypto_identify",
  description:
    "Scan a binary file for known cryptographic constants (FindCrypt-style). Detects AES S-Box, DES tables, MD5/SHA-1/SHA-256 constants, CRC32, Blowfish, ChaCha20/Salsa20, TEA/XTEA, RC4, RSA, Base64, Whirlpool, SM4, and more.",
  risk: "read",
  parameters: objectSchema(
    {
      path: { type: "string", description: "Workspace-relative file path." },
      maxHits: { type: "number", default: 50, description: "Maximum number of hits to report." },
    },
    ["path"],
  ),
  async execute(args, context) {
    const target = resolveInside(context.workspace, asString(args.path));
    validatePathRead(target, context.policy);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("crypto_identify expects a file path.");
    const maxHits = Math.min(Math.max(1, asNumber(args.maxHits, 50)), 200);
    const maxBytes = Math.min(stat.size, 16 * 1024 * 1024);
    const data = await readPrefix(target, maxBytes);
    const hits = findCryptoConstants(data, maxHits);
    const rel = path.relative(context.workspace, target);

    const algSummary = new Map<string, number>();
    for (const hit of hits) algSummary.set(hit.name, (algSummary.get(hit.name) ?? 0) + 1);

    const out = [
      "CRYPTO IDENTIFY",
      `path: ${rel}`,
      `size: ${stat.size} bytes`,
      `scanned: ${data.length}/${stat.size} bytes`,
      `hits: ${hits.length}${hits.length >= maxHits ? " (limit reached)" : ""}`,
      "",
      "summary:",
      ...(algSummary.size
        ? [...algSummary.entries()].map(([name, count]) => `- ${name}: ${count} hit${count > 1 ? "s" : ""}`)
        : ["- no known cryptographic constants found"]),
      "",
      "hits:",
      ...hits.map(
        (hit) =>
          `- 0x${hit.offset.toString(16).padStart(8, "0")}  ${hit.name}  [${hit.confidence}]  ${hit.signatureHex}`,
      ),
      ...(hits.length === 0 ? ["- none"] : []),
    ];
    if (stat.size > data.length) {
      out.splice(4, 0, `note: scanned first ${data.length} bytes; file is larger`);
    }

    const spilled = await spillIfLarge(out.join("\n"), { context, label: `crypto-id-${path.basename(target)}` });
    return {
      content: [textBlock(spilled.text)],
      details: { hits: hits.length, algorithms: Object.fromEntries(algSummary) },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 2: hash_identify
// ---------------------------------------------------------------------------

interface HashCandidate {
  name: string;
  hashcat?: number;
  notes: string;
}

function identifyHashByLength(hexLen: number): HashCandidate[] {
  const candidates: HashCandidate[] = [];
  switch (hexLen) {
    case 8:
      candidates.push({ name: "CRC32", notes: "32-bit cyclic redundancy check" });
      candidates.push({ name: "Adler-32", notes: "32-bit Adler checksum" });
      candidates.push({ name: "FNV-32", notes: "32-bit Fowler–Noll–Vo hash" });
      break;
    case 16:
      candidates.push({ name: "xxHash64 (half)", notes: "or any 64-bit hash truncated to hex" });
      candidates.push({ name: "SipHash-2-4", notes: "64-bit keyed hash" });
      candidates.push({ name: "FNV-64", notes: "64-bit Fowler–Noll–Vo hash" });
      candidates.push({ name: "MySQL 3.x", hashcat: 200, notes: "MySQL old-style hash (16 hex chars)" });
      break;
    case 32:
      candidates.push({ name: "MD5", hashcat: 0, notes: "128-bit, widely used but broken for collision resistance" });
      candidates.push({ name: "MD4", hashcat: 900, notes: "128-bit, predecessor to MD5, broken" });
      candidates.push({ name: "NTLM", hashcat: 1000, notes: "Windows NT LAN Manager hash (MD4-based)" });
      candidates.push({ name: "MD2", notes: "128-bit, obsolete" });
      candidates.push({ name: "RIPEMD-128", notes: "128-bit RIPEMD variant" });
      break;
    case 40:
      candidates.push({ name: "SHA-1", hashcat: 100, notes: "160-bit, deprecated for security use" });
      candidates.push({ name: "RIPEMD-160", hashcat: 6000, notes: "160-bit RIPEMD variant" });
      candidates.push({ name: "MySQL 4.1+", hashcat: 300, notes: "SHA-1 based, usually prefixed with *" });
      candidates.push({ name: "HAS-160", notes: "Korean standard, 160-bit" });
      break;
    case 56:
      candidates.push({ name: "SHA-224", notes: "224-bit truncated SHA-256" });
      candidates.push({ name: "SHA3-224", notes: "224-bit SHA-3 variant" });
      break;
    case 64:
      candidates.push({ name: "SHA-256", hashcat: 1400, notes: "256-bit, current standard" });
      candidates.push({ name: "SHA3-256", notes: "256-bit SHA-3 (Keccak)" });
      candidates.push({ name: "SM3", notes: "Chinese national standard, 256-bit" });
      candidates.push({ name: "BLAKE2s-256", notes: "256-bit BLAKE2 (short variant)" });
      candidates.push({ name: "RIPEMD-256", notes: "256-bit RIPEMD variant" });
      break;
    case 96:
      candidates.push({ name: "SHA-384", hashcat: 10800, notes: "384-bit truncated SHA-512" });
      candidates.push({ name: "SHA3-384", notes: "384-bit SHA-3 variant" });
      break;
    case 128:
      candidates.push({ name: "SHA-512", hashcat: 1700, notes: "512-bit SHA-2" });
      candidates.push({ name: "SHA3-512", notes: "512-bit SHA-3 (Keccak)" });
      candidates.push({ name: "BLAKE2b-512", notes: "512-bit BLAKE2 (long variant)" });
      candidates.push({ name: "Whirlpool", hashcat: 6100, notes: "512-bit, AES-based" });
      break;
  }
  return candidates;
}

function identifyHashByFormat(input: string): HashCandidate[] {
  const candidates: HashCandidate[] = [];
  const trimmed = input.trim();

  if (/^\$2[aby]\$\d{2}\$.{53}$/.test(trimmed)) {
    candidates.push({ name: "bcrypt", hashcat: 3200, notes: "Blowfish-based, slow by design, salt embedded" });
  }
  if (/^\$argon2(i|d|id)\$/.test(trimmed)) {
    candidates.push({ name: "Argon2", notes: "Memory-hard password hash, winner of PHC" });
  }
  if (/^\$scrypt\$/.test(trimmed) || /^\$7\$/.test(trimmed)) {
    candidates.push({ name: "scrypt", hashcat: 8900, notes: "Memory-hard KDF" });
  }
  if (/^\$1\$/.test(trimmed)) {
    candidates.push({ name: "MD5-crypt", hashcat: 500, notes: "Unix MD5 crypt (1000 rounds)" });
  }
  if (/^\$5\$/.test(trimmed)) {
    candidates.push({ name: "SHA-256-crypt", hashcat: 7400, notes: "Unix SHA-256 crypt" });
  }
  if (/^\$6\$/.test(trimmed)) {
    candidates.push({ name: "SHA-512-crypt", hashcat: 1800, notes: "Unix SHA-512 crypt" });
  }
  if (/^\$apr1\$/.test(trimmed)) {
    candidates.push({ name: "Apache APR1", hashcat: 1600, notes: "Apache htpasswd MD5" });
  }
  if (/^\$P\$/.test(trimmed) || /^\$H\$/.test(trimmed)) {
    candidates.push({ name: "phpass", hashcat: 400, notes: "WordPress/phpBB portable hash" });
  }
  if (/^\*[0-9A-Fa-f]{40}$/.test(trimmed)) {
    candidates.push({ name: "MySQL 4.1+", hashcat: 300, notes: "SHA-1 double hash, * prefix" });
  }
  if (/^[0-9a-f]{32}:[0-9a-f]+$/i.test(trimmed)) {
    candidates.push({ name: "MD5 + salt (appended)", notes: "hash:salt format, likely salted MD5" });
  }
  if (/^sha256\$/.test(trimmed)) {
    candidates.push({ name: "Django SHA-256", notes: "Django password hash format" });
  }
  if (/^pbkdf2[:_]sha256\$/.test(trimmed) || /^\$pbkdf2-sha256\$/.test(trimmed)) {
    candidates.push({ name: "PBKDF2-SHA256", hashcat: 10900, notes: "PBKDF2 with SHA-256" });
  }

  return candidates;
}

const hashIdentifyTool: AgentTool = {
  name: "hash_identify",
  description:
    "Identify likely hash type from a hex string or formatted hash. Detects MD5, SHA-1/224/256/384/512, bcrypt, argon2, scrypt, NTLM, MySQL, CRC32, and many more by length and format.",
  risk: "read",
  parameters: objectSchema(
    {
      hash: { type: "string", description: "Hash value to identify (hex string or formatted hash like $2b$...)." },
    },
    ["hash"],
  ),
  async execute(args) {
    const input = asString(args.hash).trim();
    if (!input) throw new Error("hash_identify requires a non-empty hash value.");

    const formatCandidates = identifyHashByFormat(input);
    const cleaned = input.replace(/^0x/i, "").replace(/[\s:-]/g, "");
    const isPlainHex = /^[0-9a-fA-F]+$/.test(cleaned);
    const lengthCandidates = isPlainHex ? identifyHashByLength(cleaned.length) : [];
    const allCandidates = [...formatCandidates, ...lengthCandidates];

    const out = [
      "HASH IDENTIFY",
      `input: ${input.length > 100 ? `${input.slice(0, 97)}...` : input}`,
      ...(isPlainHex
        ? [
            `hex length: ${cleaned.length} chars${
              cleaned.length % 2 === 0 ? ` (${cleaned.length / 2} bytes)` : " (odd length — not a whole number of bytes)"
            }`,
          ]
        : []),
      `candidates: ${allCandidates.length}`,
      "",
      ...(allCandidates.length
        ? allCandidates.map(
            (c) =>
              `- ${c.name}${c.hashcat !== undefined ? ` (hashcat mode ${c.hashcat})` : ""}: ${c.notes}`,
          )
        : ["- no known hash type matches this input"]),
    ];

    return { content: [textBlock(out.join("\n"))], details: { candidates: allCandidates.length } };
  },
};

// ---------------------------------------------------------------------------
// Tool 3: xor_analyze
// ---------------------------------------------------------------------------

const XOR_MODES = ["known_plaintext", "key_length", "full_auto"] as const;
type XorMode = (typeof XOR_MODES)[number];

function isXorMode(value: string): value is XorMode {
  return (XOR_MODES as readonly string[]).includes(value);
}

function parseInputBytes(input: string): Buffer {
  const trimmed = input.trim();
  // Only strip the "\x" escape sequence, never a bare "x" — otherwise plain
  // text like "box" would be silently reinterpreted as hex bytes.
  const hexCleaned = trimmed.replace(/^0x/i, "").replace(/\\x/gi, "").replace(/[\s:_-]+/g, "");
  if (/^[0-9a-fA-F]+$/.test(hexCleaned) && hexCleaned.length >= 2 && hexCleaned.length % 2 === 0) {
    return Buffer.from(hexCleaned, "hex");
  }
  return Buffer.from(input, "utf8");
}

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const len = Math.min(a.length, b.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = a[i] ^ b[i];
  return out;
}

function xorWithKey(data: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  return out;
}

function knownPlaintextAttack(
  ciphertext: Buffer,
  plaintext: Buffer,
): { key: Buffer; repeating: boolean; keyLen: number } {
  const raw = xorBuffers(ciphertext, plaintext);
  if (raw.length === 0) return { key: raw, repeating: false, keyLen: 0 };

  for (let kl = 1; kl <= Math.min(raw.length, 64); kl++) {
    const candidate = raw.subarray(0, kl);
    let match = true;
    for (let i = kl; i < raw.length; i++) {
      if (raw[i] !== candidate[i % kl]) {
        match = false;
        break;
      }
    }
    if (match) return { key: candidate, repeating: raw.length > kl, keyLen: kl };
  }
  return { key: raw, repeating: false, keyLen: raw.length };
}

function gcd(a: number, b: number): number {
  while (b > 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function kasiskiExamination(data: Buffer, maxKeyLength: number): Map<number, number> {
  const distances: number[] = [];
  const minSeqLen = 3;
  const seen = new Map<string, number[]>();

  for (let i = 0; i <= data.length - minSeqLen; i++) {
    const seq = data.subarray(i, i + minSeqLen).toString("hex");
    const positions = seen.get(seq);
    if (positions) {
      for (const prev of positions) {
        distances.push(i - prev);
      }
      positions.push(i);
    } else {
      seen.set(seq, [i]);
    }
  }

  const factorCounts = new Map<number, number>();
  for (const d of distances) {
    for (let f = 2; f <= Math.min(d, maxKeyLength); f++) {
      if (d % f === 0) {
        factorCounts.set(f, (factorCounts.get(f) ?? 0) + 1);
      }
    }
  }
  return factorCounts;
}

function indexOfCoincidence(data: Buffer): number {
  const counts = new Array<number>(256).fill(0);
  for (const b of data) counts[b]++;
  const n = data.length;
  if (n <= 1) return 0;
  let sum = 0;
  for (const c of counts) sum += c * (c - 1);
  return sum / (n * (n - 1));
}

function estimateKeyLengthByIC(data: Buffer, maxKeyLength: number): Array<{ length: number; avgIC: number }> {
  const results: Array<{ length: number; avgIC: number }> = [];
  for (let kl = 1; kl <= Math.min(maxKeyLength, Math.floor(data.length / 3)); kl++) {
    let totalIC = 0;
    for (let pos = 0; pos < kl; pos++) {
      const stripe: number[] = [];
      for (let i = pos; i < data.length; i += kl) stripe.push(data[i]);
      totalIC += indexOfCoincidence(Buffer.from(stripe));
    }
    results.push({ length: kl, avgIC: totalIC / kl });
  }
  return results.sort((a, b) => b.avgIC - a.avgIC);
}

function recoverKeyByFrequency(data: Buffer, keyLength: number): Buffer {
  const key = Buffer.alloc(keyLength);
  for (let pos = 0; pos < keyLength; pos++) {
    const stripe: number[] = [];
    for (let i = pos; i < data.length; i += keyLength) stripe.push(data[i]);
    let bestScore = -1;
    let bestByte = 0;
    for (let candidate = 0; candidate < 256; candidate++) {
      let score = 0;
      for (const b of stripe) {
        const decoded = b ^ candidate;
        if (decoded >= 0x20 && decoded <= 0x7e) score += 2;
        if (decoded === 0x20) score += 3; // space is very common
        if ((decoded >= 0x61 && decoded <= 0x7a) || (decoded >= 0x41 && decoded <= 0x5a)) score += 2;
        if (decoded === 0x65 || decoded === 0x74 || decoded === 0x61 || decoded === 0x6f ||
            decoded === 0x69 || decoded === 0x6e || decoded === 0x73) score += 3; // etaonis
        if (decoded === 0x0a || decoded === 0x0d || decoded === 0x09) score += 1;
        if (decoded === 0x00) score -= 2;
      }
      if (score > bestScore) {
        bestScore = score;
        bestByte = candidate;
      }
    }
    key[pos] = bestByte;
  }
  return key;
}

function printableRatio(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let count = 0;
  for (const b of buf) {
    if ((b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09) count++;
  }
  return count / buf.length;
}

function asciiPreview(data: Buffer, max: number): string {
  const clipped = data.subarray(0, max);
  return Array.from(clipped, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
}

const xorAnalyzeTool: AgentTool = {
  name: "xor_analyze",
  description:
    "Advanced XOR analysis: known-plaintext attack (derive key from ciphertext + known plaintext), key length detection (Kasiski + Index of Coincidence), and full automatic recovery (detect length then frequency-analyze each position).",
  risk: "read",
  parameters: objectSchema(
    {
      input: { type: "string", description: "Ciphertext as hex string or raw text." },
      mode: {
        type: "string",
        enum: XOR_MODES,
        default: "full_auto",
        description: "known_plaintext: derive key from known plaintext. key_length: detect repeating key length. full_auto: detect length + recover key + decrypt.",
      },
      knownPlaintext: { type: "string", description: "Known/expected plaintext fragment for known_plaintext mode." },
      maxKeyLength: { type: "number", default: 32, description: "Maximum key length to test." },
    },
    ["input"],
  ),
  async execute(args, context) {
    const rawMode = asString(args.mode, "full_auto");
    const mode: XorMode = isXorMode(rawMode) ? rawMode : "full_auto";
    const maxKeyLength = Math.min(Math.max(1, asNumber(args.maxKeyLength, 32)), 128);
    const ciphertext = parseInputBytes(asString(args.input));

    if (ciphertext.length === 0) throw new Error("xor_analyze requires non-empty input.");

    const out: string[] = ["XOR ANALYZE", `mode: ${mode}`, `input: ${ciphertext.length} bytes`, ""];

    if (mode === "known_plaintext") {
      const ptText = asString(args.knownPlaintext);
      if (!ptText) throw new Error("known_plaintext mode requires the knownPlaintext parameter.");
      const plaintext = parseInputBytes(ptText);
      const result = knownPlaintextAttack(ciphertext, plaintext);
      out.push(
        "known-plaintext attack:",
        `  derived key (${result.keyLen} bytes): ${result.key.toString("hex")}`,
        `  key as ASCII: ${asciiPreview(result.key, 64)}`,
        `  repeating: ${result.repeating ? "yes (key is shorter than overlap)" : "no (key may be longer)"}`,
        "",
      );
      const decrypted = xorWithKey(ciphertext, result.key);
      const preview = decrypted.subarray(0, Math.min(decrypted.length, 256));
      out.push(
        "decrypted preview:",
        `  printable: ${(printableRatio(preview) * 100).toFixed(1)}%`,
        `  text: ${asciiPreview(preview, 256)}`,
      );
    } else if (mode === "key_length") {
      const kasiski = kasiskiExamination(ciphertext, maxKeyLength);
      const icResults = estimateKeyLengthByIC(ciphertext, maxKeyLength);
      const top5Kasiski = [...kasiski.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      const top5IC = icResults.slice(0, 8);

      out.push(
        "Kasiski examination (top factors):",
        ...(top5Kasiski.length
          ? top5Kasiski.map(([len, count]) => `  length ${len}: ${count} supporting distances`)
          : ["  insufficient repeated sequences found"]),
        "",
        "Index of Coincidence (top candidates):",
        ...top5IC.map((r) => `  length ${r.length}: IC = ${r.avgIC.toFixed(6)}${r.avgIC > 0.06 ? " ★" : ""}`),
        "",
        "notes:",
        "- English text IC ≈ 0.0667; random ≈ 0.0039",
        "- Key lengths with IC close to 0.0667 are strong candidates",
        "- Kasiski counts show how many repeated-sequence distances are divisible by each length",
      );
    } else {
      // full_auto
      const icResults = estimateKeyLengthByIC(ciphertext, maxKeyLength);
      const kasiski = kasiskiExamination(ciphertext, maxKeyLength);

      // Score each candidate: combine IC ranking and Kasiski support
      const scores = new Map<number, number>();
      for (let i = 0; i < icResults.length; i++) {
        const r = icResults[i];
        const icScore = r.avgIC > 0.06 ? 10 : r.avgIC > 0.04 ? 5 : 1;
        const kasiskiScore = kasiski.get(r.length) ?? 0;
        scores.set(r.length, icScore * (icResults.length - i) + kasiskiScore);
      }
      const bestLengths = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const bestKeyLength = bestLengths[0]?.[0] ?? 1;

      out.push(
        "key length candidates:",
        ...bestLengths.map(
          ([len, score]) =>
            `  length ${len}: score ${score} (IC=${icResults.find((r) => r.length === len)?.avgIC.toFixed(6) ?? "?"}, Kasiski=${kasiski.get(len) ?? 0})`,
        ),
        "",
        `best guess: key length = ${bestKeyLength}`,
        "",
      );

      const key = recoverKeyByFrequency(ciphertext, bestKeyLength);
      out.push(
        `recovered key (${key.length} bytes):`,
        `  hex: ${key.toString("hex")}`,
        `  ascii: ${asciiPreview(key, 64)}`,
        "",
      );

      const decrypted = xorWithKey(ciphertext, key);
      const previewLen = Math.min(decrypted.length, 512);
      const preview = decrypted.subarray(0, previewLen);
      const ratio = printableRatio(preview);
      out.push(
        `decrypted preview (${previewLen}/${decrypted.length} bytes):`,
        `  printable: ${(ratio * 100).toFixed(1)}%`,
        `  text: ${asciiPreview(preview, 512)}`,
      );

      if (ratio < 0.5) {
        out.push("", "warning: low printable ratio — the key may be wrong or the plaintext is binary");
      }

      // Also try top 2 alternative key lengths
      if (bestLengths.length > 1) {
        out.push("", "alternatives:");
        for (const [altLen] of bestLengths.slice(1)) {
          const altKey = recoverKeyByFrequency(ciphertext, altLen);
          const altDec = xorWithKey(ciphertext, altKey);
          const altPreview = altDec.subarray(0, Math.min(altDec.length, 128));
          const altRatio = printableRatio(altPreview);
          out.push(
            `  key length ${altLen}: key=${altKey.toString("hex")} printable=${(altRatio * 100).toFixed(1)}%`,
            `    preview: ${asciiPreview(altPreview, 128)}`,
          );
        }
      }
    }

    const spilled = await spillIfLarge(out.join("\n"), { context, label: "xor-analyze" });
    return { content: [textBlock(spilled.text)], details: { mode } };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readPrefix(file: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
