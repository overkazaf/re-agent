---
name: web-crypto-analyzer
description: Analyze and identify cryptographic implementations in web applications. Detect encryption algorithms, key generation, hashing functions, and signature schemes. Use for security research and algorithm extraction.
---

# Web Cryptography Analyzer

A skill for identifying and analyzing cryptographic implementations in JavaScript code for security research and reverse engineering.

## Workflow Overview

### Step 1: Identify Cryptographic Patterns

**Common Crypto Libraries:**

| Library | Detection Pattern | Purpose |
|---------|-------------------|---------|
| **CryptoJS** | `CryptoJS.AES`, `CryptoJS.MD5` | General crypto |
| **Web Crypto API** | `crypto.subtle`, `window.crypto` | Browser native |
| **sjcl** | `sjcl.encrypt`, `sjcl.hash` | Stanford JS Crypto |
| **forge** | `forge.cipher`, `forge.md` | Node-forge |
| **tweetnacl** | `nacl.secretbox`, `nacl.sign` | NaCl bindings |
| **jsencrypt** | `JSEncrypt`, `encrypt`, `decrypt` | RSA encryption |
| **bcrypt.js** | `bcrypt.hash`, `bcrypt.compare` | Password hashing |
| **jsSHA** | `new jsSHA()`, `getHash` | SHA variants |
| **aes-js** | `aes.ModeOfOperation` | Pure JS AES |
| **elliptic** | `elliptic.ec`, `ecdsa` | ECC curves |
| **noble** | `@noble/ed25519`, `@noble/secp256k1` | Modern ECC |

**Crypto Function Signatures:**

```javascript
// Hash functions
md5(data)                    // MD5 (insecure)
sha1(data)                   // SHA-1 (deprecated)
sha256(data)                 // SHA-256
sha512(data)                 // SHA-512
hmac(key, data)              // HMAC

// Symmetric encryption
encrypt(key, data)           // Generic encrypt
decrypt(key, ciphertext)     // Generic decrypt
AES.encrypt(data, key)       // AES
DES.encrypt(data, key)       // DES (insecure)

// Asymmetric encryption
RSA.encrypt(data, publicKey) // RSA
sign(data, privateKey)       // Digital signature
verify(data, signature, key) // Signature verification

// Key derivation
pbkdf2(password, salt, iterations)
scrypt(password, salt, options)
argon2(password, salt, options)
```

### Step 2: Pattern Detection Script

```javascript
// Run in DevTools to detect crypto usage
(function detectCrypto() {
    const findings = {
        libraries: [],
        functions: [],
        constants: [],
        suspicious: []
    };

    // Check global objects
    const cryptoGlobals = [
        'CryptoJS', 'sjcl', 'forge', 'nacl', 'JSEncrypt',
        'bcrypt', 'jsSHA', 'aesjs', 'elliptic', 'crypto'
    ];

    cryptoGlobals.forEach(name => {
        if (window[name]) {
            findings.libraries.push({
                name: name,
                type: typeof window[name],
                methods: Object.keys(window[name]).slice(0, 20)
            });
        }
    });

    // Check Web Crypto API
    if (window.crypto?.subtle) {
        findings.libraries.push({
            name: 'Web Crypto API',
            type: 'native',
            methods: Object.keys(window.crypto.subtle.__proto__)
        });
    }

    // Search for crypto patterns in loaded scripts
    const scripts = document.querySelectorAll('script:not([src])');
    scripts.forEach(script => {
        const code = script.textContent;

        // Hash patterns
        if (/\b(md5|MD5)\s*\(/.test(code)) findings.functions.push('MD5');
        if (/\b(sha1|SHA1)\s*\(/.test(code)) findings.functions.push('SHA-1');
        if (/\b(sha256|SHA256)\s*\(/.test(code)) findings.functions.push('SHA-256');
        if (/\b(sha512|SHA512)\s*\(/.test(code)) findings.functions.push('SHA-512');

        // Encryption patterns
        if (/\bAES\b/.test(code)) findings.functions.push('AES');
        if (/\bDES\b/.test(code)) findings.functions.push('DES');
        if (/\bRSA\b/.test(code)) findings.functions.push('RSA');
        if (/\bHMAC\b/i.test(code)) findings.functions.push('HMAC');

        // Key patterns
        if (/pbkdf2/i.test(code)) findings.functions.push('PBKDF2');
        if (/scrypt/i.test(code)) findings.functions.push('scrypt');

        // Suspicious constants (hardcoded keys)
        const keyPatterns = code.match(/['"][A-Fa-f0-9]{32,}['"]/g);
        if (keyPatterns) {
            findings.constants.push(...keyPatterns.slice(0, 5));
        }

        // Base64 encoded potential keys
        const base64Keys = code.match(/['"][A-Za-z0-9+/]{40,}={0,2}['"]/g);
        if (base64Keys) {
            findings.suspicious.push(...base64Keys.slice(0, 5));
        }
    });

    console.log('Crypto Detection Results:', findings);
    return findings;
})();
```

### Step 3: Algorithm Identification

#### 3.1 Hash Algorithm Detection

| Algorithm | Output Length | Hex Length | Pattern |
|-----------|---------------|------------|---------|
| MD5 | 128 bits | 32 chars | Deprecated, fast |
| SHA-1 | 160 bits | 40 chars | Deprecated |
| SHA-256 | 256 bits | 64 chars | Common, secure |
| SHA-384 | 384 bits | 96 chars | Less common |
| SHA-512 | 512 bits | 128 chars | Secure, longer |
| HMAC | Varies | Based on hash | Keyed hash |

```javascript
// Identify hash by output length
function identifyHash(hashOutput) {
    const hexLength = hashOutput.length;

    const hashTypes = {
        32: 'MD5 (128-bit)',
        40: 'SHA-1 (160-bit)',
        56: 'SHA-224 (224-bit)',
        64: 'SHA-256 (256-bit)',
        96: 'SHA-384 (384-bit)',
        128: 'SHA-512 (512-bit)'
    };

    return hashTypes[hexLength] || `Unknown (${hexLength} hex chars)`;
}
```

#### 3.2 Encryption Mode Detection

| Mode | Pattern | Characteristics |
|------|---------|-----------------|
| ECB | Repeating patterns | Insecure for data |
| CBC | IV prepended | Common, needs IV |
| CTR | Counter mode | Stream-like |
| GCM | Auth tag appended | AEAD, recommended |
| CFB | Feedback mode | Self-synchronizing |

```javascript
// CryptoJS mode patterns
CryptoJS.AES.encrypt(data, key, {
    mode: CryptoJS.mode.CBC,    // Most common
    padding: CryptoJS.pad.Pkcs7,
    iv: CryptoJS.lib.WordArray.random(16)
});
```

#### 3.3 Key Format Detection

```javascript
// Common key formats
function identifyKeyFormat(key) {
    // Hex key
    if (/^[A-Fa-f0-9]+$/.test(key)) {
        const bits = (key.length / 2) * 8;
        return `Hex key (${bits} bits)`;
    }

    // Base64 key
    if (/^[A-Za-z0-9+/]+=*$/.test(key)) {
        const decoded = atob(key);
        const bits = decoded.length * 8;
        return `Base64 key (${bits} bits decoded)`;
    }

    // PEM format (RSA)
    if (key.includes('-----BEGIN')) {
        if (key.includes('PUBLIC KEY')) return 'RSA Public Key (PEM)';
        if (key.includes('PRIVATE KEY')) return 'RSA Private Key (PEM)';
        if (key.includes('CERTIFICATE')) return 'X.509 Certificate (PEM)';
    }

    // JWK format
    if (key.includes('"kty"')) {
        const jwk = JSON.parse(key);
        return `JWK (${jwk.kty} - ${jwk.alg || 'unspecified'})`;
    }

    return 'Unknown format';
}
```

### Step 4: Extract Encryption Logic

```javascript
// Hook encryption functions to capture parameters
(function hookCrypto() {
    // Hook CryptoJS
    if (window.CryptoJS) {
        const originalEncrypt = CryptoJS.AES.encrypt;
        CryptoJS.AES.encrypt = function(message, key, options) {
            console.group('CryptoJS.AES.encrypt');
            console.log('Message:', message.toString());
            console.log('Key:', key.toString());
            console.log('Options:', options);
            const result = originalEncrypt.apply(this, arguments);
            console.log('Ciphertext:', result.toString());
            console.groupEnd();
            return result;
        };
    }

    // Hook Web Crypto API
    if (window.crypto?.subtle) {
        const originalEncrypt = crypto.subtle.encrypt;
        crypto.subtle.encrypt = async function(algorithm, key, data) {
            console.group('crypto.subtle.encrypt');
            console.log('Algorithm:', algorithm);
            console.log('Key:', key);
            console.log('Data:', new Uint8Array(data));
            const result = await originalEncrypt.apply(this, arguments);
            console.log('Result:', new Uint8Array(result));
            console.groupEnd();
            return result;
        };

        const originalDecrypt = crypto.subtle.decrypt;
        crypto.subtle.decrypt = async function(algorithm, key, data) {
            console.group('crypto.subtle.decrypt');
            console.log('Algorithm:', algorithm);
            console.log('Data:', new Uint8Array(data));
            const result = await originalDecrypt.apply(this, arguments);
            console.log('Decrypted:', new TextDecoder().decode(result));
            console.groupEnd();
            return result;
        };
    }

    console.log('Crypto hooks installed');
})();
```

### Step 5: Common Implementation Patterns

#### 5.1 Password-Based Encryption

```javascript
// Common pattern: derive key from password
function encryptWithPassword(plaintext, password) {
    const salt = CryptoJS.lib.WordArray.random(128/8);
    const key = CryptoJS.PBKDF2(password, salt, {
        keySize: 256/32,
        iterations: 10000
    });
    const iv = CryptoJS.lib.WordArray.random(128/8);
    const encrypted = CryptoJS.AES.encrypt(plaintext, key, { iv: iv });

    // Output: salt + iv + ciphertext
    return salt.toString() + iv.toString() + encrypted.ciphertext.toString();
}

// To reverse: extract salt, iv, derive key, decrypt
```

#### 5.2 API Request Signing

```javascript
// Common pattern: HMAC signature
function signRequest(method, url, timestamp, body, secretKey) {
    const payload = [method, url, timestamp, body].join('\n');
    const signature = CryptoJS.HmacSHA256(payload, secretKey);
    return signature.toString(CryptoJS.enc.Base64);
}

// Headers typically include:
// X-Timestamp: 1234567890
// X-Signature: base64_signature
// X-Nonce: random_nonce
```

#### 5.3 Token Generation

```javascript
// JWT-like structure
function createToken(payload, secret) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const headerB64 = btoa(JSON.stringify(header));
    const payloadB64 = btoa(JSON.stringify(payload));
    const signature = CryptoJS.HmacSHA256(
        headerB64 + '.' + payloadB64,
        secret
    ).toString(CryptoJS.enc.Base64url);

    return headerB64 + '.' + payloadB64 + '.' + signature;
}
```

## Output Format

```markdown
## Web Cryptography Analysis Report

### Summary
- **Crypto Libraries Detected**: {{LIST}}
- **Algorithms Found**: {{LIST}}
- **Security Level**: {{LOW/MEDIUM/HIGH}}
- **Hardcoded Keys Found**: {{YES/NO}}

### Libraries Detected

| Library | Version | Usage |
|---------|---------|-------|
| {{NAME}} | {{VER}} | {{USAGE}} |

### Encryption Analysis

#### Algorithm: {{NAME}}
- **Type**: Symmetric/Asymmetric
- **Mode**: {{MODE}}
- **Key Size**: {{SIZE}} bits
- **IV/Nonce**: {{PRESENT/ABSENT}}
- **Padding**: {{PADDING_SCHEME}}

#### Implementation Details
```javascript
{{CODE_SNIPPET}}
```

#### Key Derivation
| Parameter | Value |
|-----------|-------|
| Algorithm | {{ALG}} |
| Iterations | {{N}} |
| Salt | {{LENGTH}} bytes |
| Output | {{SIZE}} bits |

### Hash Functions

| Function | Input | Output Length | Purpose |
|----------|-------|---------------|---------|
| {{FUNC}} | {{INPUT}} | {{LEN}} | {{PURPOSE}} |

### Security Findings

#### Vulnerabilities
| Severity | Issue | Location |
|----------|-------|----------|
| HIGH | Hardcoded encryption key | line {{N}} |
| MEDIUM | Weak hash (MD5) used | {{FUNC}} |
| LOW | Missing IV randomization | {{FUNC}} |

#### Hardcoded Secrets
| Type | Value (masked) | Risk |
|------|----------------|------|
| AES Key | {{FIRST_4}}...{{LAST_4}} | Critical |
| API Secret | {{MASKED}} | High |

### Reverse Engineering Guide

#### To decrypt data:
1. Extract key: {{KEY_LOCATION}}
2. Extract IV: {{IV_EXTRACTION}}
3. Algorithm: {{ALGORITHM}}
4. Code:
```javascript
{{DECRYPTION_CODE}}
```

#### To sign requests:
```javascript
{{SIGNING_CODE}}
```
```

## Security Checklist

| Check | Status | Notes |
|-------|--------|-------|
| No hardcoded keys in client | | |
| Strong algorithms (AES-256, RSA-2048+) | | |
| Proper IV/nonce generation | | |
| Secure key derivation (PBKDF2 10k+ iterations) | | |
| No deprecated algorithms (MD5, SHA1, DES) | | |
| Authenticated encryption (GCM) | | |
| Secure random number generation | | |

## Tools Reference

| Tool | Purpose |
|------|---------|
| **CyberChef** | Encode/decode/encrypt operations |
| **HashID** | Identify hash types |
| **jwt.io** | Decode JWT tokens |
| **Burp Suite** | Intercept and modify crypto params |
| **Frida** | Hook crypto at runtime |

## Usage

```
/web-crypto-analyzer

[Paste JavaScript code or URL for analysis]
```

This will:
1. Identify crypto libraries and functions
2. Extract algorithm parameters
3. Detect hardcoded keys/secrets
4. Provide decryption/signing code
5. Highlight security issues
