---
name: web-wasm-crypto
description: Web reverse workflow for JavaScript crypto, WASM modules, dynamic parameters, anti-debug scripts, and browser-side hooks.
tags: web javascript wasm crypto browser hook
---

# Web / WASM / Crypto Reverse

Use this for web CTFs, JavaScript obfuscation, browser crypto, WASM modules, signatures, dynamic request parameters, and frontend anti-debug logic.

## Workflow

1. Identify entry points: script bundle names, WASM fetch/instantiate calls, network request builders, and event handlers.
2. Search for crypto libraries and primitives: `crypto.subtle`, `CryptoJS`, `AES`, `RSA`, `HMAC`, `MD5`, `SHA`, `PBKDF2`, `scrypt`.
3. Extract encoded constants and run `ctf_decode`.
4. For WASM, locate `00 61 73 6d`, exports/imports, memory, and JS glue code.
5. Hook before rewriting: wrap `fetch`, `XMLHttpRequest`, `WebAssembly.instantiate`, and crypto functions to capture inputs/outputs.

## Useful Patterns

```javascript
const oldFetch = window.fetch;
window.fetch = async function(...args) {
  console.log("[fetch]", args);
  return oldFetch.apply(this, args);
};
```

```javascript
const oldInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function(buffer, imports) {
  console.log("[wasm]", buffer.byteLength || buffer.length, imports);
  const result = await oldInstantiate.call(this, buffer, imports);
  console.log("[exports]", Object.keys(result.instance.exports));
  return result;
};
```

## Notes

Avoid live target abuse. Keep analysis to authorized CTF/lab assets or locally saved pages, bundles, and WASM files.
