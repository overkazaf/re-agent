---
name: proxy-capture
description: Scoped Burp Suite and mitmproxy workflow for mobile/API traffic capture, export, and replay-ready evidence.
tags: proxy burp mitmproxy http mobile api traffic capture
---

# Proxy Capture

Use this for authorized mobile app, WebView, browser, API, or CTF traffic analysis where request/response evidence matters.

## Workflow

1. Define scope first: target host, app/package, account, endpoint family, and the user action that triggers traffic.
2. Run `/retool inventory` to see whether Burp Suite or mitmproxy is available locally.
3. Generate the proxy setup you need:
   - Burp mobile/API checklist: `/retool burp template mobile`
   - Burp XML history parser: `/retool burp template export`
   - mitmproxy JSONL addon: `/retool mitmproxy template <host>`
4. Capture a small in-scope trace: login, challenge load, request signing, upload, result check, and error paths.
5. Export evidence before reasoning: HTTP history XML/HAR, mitmproxy JSONL, screenshots of scope/proxy settings, and hashes of captured files.
6. Compare two traces by changing one input at a time. Focus on timestamp, nonce, body hash, path, method, headers, cookies, and encrypted fields.

## Evidence Checklist

- Request method, URL path, query parameters, headers, cookies, and body.
- Response status, headers, body preview, and content hash.
- Which fields change when body, timestamp, nonce, or account changes.
- Whether signing/encryption happens in JavaScript, Java/Kotlin, native code, or a remote challenge.
- Exact replay delta: the smallest request change that flips server behavior.

## Handoff Rules

- Browser JavaScript or WebView assets: read `web-crypto-analyzer` or `web-wasm-crypto`.
- API signature or token logic: read `api-signature-crack`.
- APK classes or Java crypto: read `android-apk-frida` and `jadx`.
- Native signing function: read `radare2-reverse`, `unidbg`, or `unicorn-emulator`.
- If trusted lab interception is blocked, prefer debug builds or authorized instrumentation and keep the proxy capture scoped.
