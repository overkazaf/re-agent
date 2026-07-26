---
name: api-signature-crack
description: Reverse engineer API request signatures, authentication tokens, and encryption parameters. Analyze signature algorithms, timestamp validation, and nonce generation. Use for security testing and API integration research.
---

# API Signature Reverse Engineering

A skill for analyzing and reverse engineering API request signatures, authentication mechanisms, and encrypted parameters in web applications.

## Workflow Overview

### Step 1: Capture Request Signatures

**Common Signature Locations:**

| Location | Header/Param Names | Examples |
|----------|-------------------|----------|
| Headers | `X-Signature`, `Authorization`, `X-Sign` | `X-Signature: abc123...` |
| Headers | `X-Timestamp`, `X-Nonce`, `X-Token` | `X-Timestamp: 1234567890` |
| Query Params | `sign`, `signature`, `sig`, `token` | `?sign=abc123` |
| Body | `sign`, `signature`, `checksum` | `{"sign": "abc123"}` |
| Cookies | Session tokens, auth tokens | Various |

**Capture Script:**

```javascript
// Intercept all XHR/fetch requests
(function interceptRequests() {
    const log = [];

    // Hook XMLHttpRequest
    const originalXHR = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._requestData = { method, url, headers: {} };
        return originalXHR.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        this._requestData.headers[name] = value;
        return originalSetHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        this._requestData.body = body;
        log.push({
            type: 'XHR',
            ...this._requestData,
            timestamp: Date.now()
        });
        console.log('XHR Request:', this._requestData);
        return originalSend.apply(this, arguments);
    };

    // Hook fetch
    const originalFetch = window.fetch;
    window.fetch = function(url, options = {}) {
        log.push({
            type: 'Fetch',
            url: url.toString(),
            method: options.method || 'GET',
            headers: Object.fromEntries(options.headers?.entries?.() || []),
            body: options.body,
            timestamp: Date.now()
        });
        console.log('Fetch Request:', { url, options });
        return originalFetch.apply(this, arguments);
    };

    window.__requestLog = log;
    console.log('Request interception enabled. Access via window.__requestLog');
})();
```

### Step 2: Identify Signature Components

**Common Signature Patterns:**

| Pattern | Description | Example |
|---------|-------------|---------|
| **HMAC** | Keyed hash | `HMAC-SHA256(key, data)` |
| **Simple Hash** | Hash of params | `MD5(params + secret)` |
| **Timestamp + Nonce** | Anti-replay | `sign(ts + nonce + params)` |
| **JWT** | Token-based | `header.payload.signature` |
| **OAuth** | Standard auth | `oauth_signature=...` |
| **Custom** | App-specific | Various |

**Analysis Checklist:**

```markdown
## Request Analysis

### Observed Parameters
- [ ] Timestamp (unix/ISO format)
- [ ] Nonce/Random value
- [ ] App ID/Key
- [ ] User token
- [ ] Request body hash
- [ ] URL/Path included
- [ ] HTTP method included

### Signature Characteristics
- Length: __ characters
- Format: hex/base64/custom
- Changes with: timestamp/nonce/body
- Static when: params unchanged
```

### Step 3: Signature Algorithm Identification

```javascript
// Test common signature algorithms
(function identifySignature() {
    const testData = 'test_data';
    const testKey = 'test_key';

    // Compare captured signature with known algorithms
    const algorithms = {
        // MD5
        'MD5': () => CryptoJS.MD5(testData).toString(),
        'MD5+Key': () => CryptoJS.MD5(testData + testKey).toString(),
        'Key+MD5': () => CryptoJS.MD5(testKey + testData).toString(),

        // SHA series
        'SHA1': () => CryptoJS.SHA1(testData).toString(),
        'SHA256': () => CryptoJS.SHA256(testData).toString(),
        'SHA512': () => CryptoJS.SHA512(testData).toString(),

        // HMAC
        'HMAC-MD5': () => CryptoJS.HmacMD5(testData, testKey).toString(),
        'HMAC-SHA1': () => CryptoJS.HmacSHA1(testData, testKey).toString(),
        'HMAC-SHA256': () => CryptoJS.HmacSHA256(testData, testKey).toString(),
        'HMAC-SHA512': () => CryptoJS.HmacSHA512(testData, testKey).toString(),

        // Base64 variants
        'HMAC-SHA256-B64': () => CryptoJS.HmacSHA256(testData, testKey).toString(CryptoJS.enc.Base64),
    };

    console.table(
        Object.entries(algorithms).map(([name, fn]) => ({
            Algorithm: name,
            Output: fn(),
            Length: fn().length
        }))
    );
})();
```

### Step 4: Reverse Engineering Process

#### 4.1 Find Signature Generation Code

```javascript
// Search patterns in source code
const searchPatterns = [
    /sign\s*[:=]\s*function/i,
    /signature\s*[:=]/i,
    /createSign/i,
    /generateSign/i,
    /calcSign/i,
    /getSign/i,
    /hmac/i,
    /crypto.*sign/i,
    /encryptRequest/i,
    /signRequest/i
];

// Common signature function structure
function findSignatureCode(source) {
    const patterns = [
        // Function declaration
        /function\s+\w*[Ss]ign\w*\s*\([^)]*\)\s*\{[\s\S]*?\}/g,
        // Arrow function
        /\w*[Ss]ign\w*\s*[:=]\s*\([^)]*\)\s*=>\s*\{?[\s\S]*?\}?/g,
        // Object method
        /[Ss]ign\w*\s*:\s*function\s*\([^)]*\)\s*\{[\s\S]*?\}/g
    ];

    const matches = [];
    patterns.forEach(pattern => {
        const found = source.match(pattern);
        if (found) matches.push(...found);
    });

    return matches;
}
```

#### 4.2 Trace Signature Flow

```javascript
// Set breakpoints on common crypto operations
(function traceSignature() {
    // Hook common crypto functions
    const hooks = [
        ['CryptoJS', 'MD5'],
        ['CryptoJS', 'SHA1'],
        ['CryptoJS', 'SHA256'],
        ['CryptoJS', 'HmacSHA256'],
        ['CryptoJS.AES', 'encrypt'],
    ];

    hooks.forEach(([obj, method]) => {
        try {
            const parts = obj.split('.');
            let target = window;
            parts.forEach(p => target = target[p]);

            if (target && target[method]) {
                const original = target[method];
                target[method] = function() {
                    console.group(`${obj}.${method} called`);
                    console.log('Arguments:', Array.from(arguments).map(a =>
                        a?.toString?.() || a
                    ));
                    console.trace('Call stack');
                    const result = original.apply(this, arguments);
                    console.log('Result:', result?.toString?.() || result);
                    console.groupEnd();
                    return result;
                };
            }
        } catch (e) {}
    });
})();
```

#### 4.3 Parameter Order Analysis

```javascript
// Capture multiple requests to determine parameter order
(function analyzeParamOrder() {
    const requests = window.__requestLog || [];

    // Extract signature-related params from each request
    const analysis = requests.map(req => {
        const params = {};

        // From headers
        Object.entries(req.headers || {}).forEach(([k, v]) => {
            if (/sign|token|time|nonce/i.test(k)) {
                params[`header:${k}`] = v;
            }
        });

        // From URL
        const url = new URL(req.url, location.origin);
        url.searchParams.forEach((v, k) => {
            if (/sign|token|time|nonce/i.test(k)) {
                params[`query:${k}`] = v;
            }
        });

        // From body
        if (req.body) {
            try {
                const body = typeof req.body === 'string'
                    ? JSON.parse(req.body) : req.body;
                Object.entries(body).forEach(([k, v]) => {
                    if (/sign|token|time|nonce/i.test(k)) {
                        params[`body:${k}`] = v;
                    }
                });
            } catch (e) {}
        }

        return { timestamp: req.timestamp, params };
    });

    console.table(analysis);
    return analysis;
})();
```

### Step 5: Common Signature Patterns

#### 5.1 Simple Parameter Concatenation

```javascript
// Pattern: sort params + concat + hash
function sign(params, secret) {
    const sorted = Object.keys(params).sort()
        .map(k => `${k}=${params[k]}`)
        .join('&');

    return CryptoJS.MD5(sorted + secret).toString();
}

// Variations:
// - Uppercase/lowercase keys
// - With/without '=' and '&'
// - Secret prepended vs appended
// - URL encoding before/after
```

#### 5.2 Timestamp-Based

```javascript
// Pattern: timestamp + nonce + body
function sign(timestamp, nonce, body, secret) {
    const payload = `${timestamp}\n${nonce}\n${JSON.stringify(body)}`;
    return CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Base64);
}

// Common timestamp formats:
// - Unix seconds: 1234567890
// - Unix milliseconds: 1234567890123
// - ISO 8601: 2024-01-01T00:00:00Z
```

#### 5.3 Request Path Included

```javascript
// Pattern: method + path + params + timestamp
function sign(method, path, params, timestamp, secret) {
    const payload = [
        method.toUpperCase(),
        path,
        new URLSearchParams(params).toString(),
        timestamp
    ].join('\n');

    return CryptoJS.HmacSHA256(payload, secret).toString();
}
```

#### 5.4 Body Hash Included

```javascript
// Pattern: include hash of request body
function sign(method, url, body, timestamp, secret) {
    const bodyHash = CryptoJS.SHA256(JSON.stringify(body)).toString();

    const payload = [
        method,
        url,
        bodyHash,
        timestamp
    ].join('\n');

    return CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Base64);
}
```

### Step 6: Signature Validation Testing

```javascript
// Test signature generation
async function testSignature(signFunction, testCases) {
    const results = [];

    for (const testCase of testCases) {
        const { input, expectedSignature } = testCase;
        const actualSignature = await signFunction(input);

        results.push({
            input: JSON.stringify(input).substring(0, 50),
            expected: expectedSignature,
            actual: actualSignature,
            match: expectedSignature === actualSignature
        });
    }

    console.table(results);
    return results;
}

// Usage:
// 1. Capture real requests with signatures
// 2. Extract the signing logic
// 3. Test against captured data
// 4. Iterate until all match
```

## Output Format

```markdown
## API Signature Analysis Report

### Request Overview
- **Endpoint**: {{URL}}
- **Method**: {{METHOD}}
- **Signature Location**: {{HEADER/QUERY/BODY}}
- **Signature Parameter**: {{PARAM_NAME}}

### Signature Characteristics
| Property | Value |
|----------|-------|
| Length | {{LENGTH}} chars |
| Format | {{HEX/BASE64/CUSTOM}} |
| Algorithm | {{ALGORITHM}} |
| Changes with | {{TRIGGER}} |

### Identified Components

| Component | Source | Value/Format |
|-----------|--------|--------------|
| Timestamp | Header: X-Timestamp | Unix seconds |
| Nonce | Header: X-Nonce | 32-char random |
| App Key | Query: appKey | Static |
| Body | POST body | JSON string |
| Secret | Hardcoded/Server | {{LOCATION}} |

### Signature Algorithm

```javascript
// Reconstructed signature function
{{SIGNATURE_CODE}}
```

### Sign Payload Structure
```
${METHOD}\n
${PATH}\n
${TIMESTAMP}\n
${NONCE}\n
${BODY_HASH}
```

### Verification Results

| Test # | Input | Expected | Actual | Match |
|--------|-------|----------|--------|-------|
| 1 | {{INPUT}} | {{EXPECTED}} | {{ACTUAL}} | {{YES/NO}} |

### Replay Protection Analysis
- **Timestamp Window**: {{WINDOW}} seconds
- **Nonce Storage**: {{CLIENT/SERVER}}
- **Bypass Possible**: {{YES/NO}}

### Security Findings
| Issue | Severity | Description |
|-------|----------|-------------|
| {{ISSUE}} | {{SEV}} | {{DESC}} |

### Implementation Code

```javascript
// Ready-to-use signing function
{{IMPLEMENTATION}}
```

```python
# Python implementation
{{PYTHON_IMPLEMENTATION}}
```
```

## Tools Reference

| Tool | Purpose |
|------|---------|
| **Burp Suite** | Intercept & modify requests |
| **mitmproxy** | Programmatic interception |
| **Fiddler** | Traffic inspection |
| **Postman** | API testing |
| **CyberChef** | Encoding/hashing |
| **Chrome DevTools** | JS debugging |

## Usage

```
/api-signature-crack

[Paste cURL command or request details]
```

This will:
1. Analyze request structure
2. Identify signature algorithm
3. Extract signing parameters
4. Provide implementation code
5. Test against captured samples
