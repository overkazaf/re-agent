---
name: browser-hook
description: Hook and intercept browser JavaScript runtime for reverse engineering. Intercept XHR/Fetch, WebSocket, localStorage, crypto APIs, and custom functions. Use for API analysis, debugging, and security research.
---

# Browser Runtime Hooking

A skill for intercepting and analyzing JavaScript runtime behavior in web browsers for reverse engineering and security research.

## Workflow Overview

### Step 1: Network Request Hooks

#### 1.1 XMLHttpRequest Hook

```javascript
(function hookXHR() {
    const XHR = XMLHttpRequest;

    // Store original methods
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    const originalSetHeader = XHR.prototype.setRequestHeader;

    // Hook open()
    XHR.prototype.open = function(method, url, async, user, pass) {
        this._hookData = {
            method: method,
            url: url,
            headers: {},
            startTime: null
        };
        return originalOpen.apply(this, arguments);
    };

    // Hook setRequestHeader()
    XHR.prototype.setRequestHeader = function(name, value) {
        if (this._hookData) {
            this._hookData.headers[name] = value;
        }
        return originalSetHeader.apply(this, arguments);
    };

    // Hook send()
    XHR.prototype.send = function(body) {
        const xhr = this;
        xhr._hookData.body = body;
        xhr._hookData.startTime = performance.now();

        // Log request
        console.group(`[XHR] ${xhr._hookData.method} ${xhr._hookData.url}`);
        console.log('Headers:', xhr._hookData.headers);
        console.log('Body:', body);

        // Hook response
        const originalOnReady = xhr.onreadystatechange;
        xhr.onreadystatechange = function() {
            if (xhr.readyState === 4) {
                const duration = performance.now() - xhr._hookData.startTime;
                console.log('Status:', xhr.status);
                console.log('Response:', xhr.responseText.substring(0, 500));
                console.log('Duration:', duration.toFixed(2), 'ms');
                console.groupEnd();
            }
            if (originalOnReady) originalOnReady.apply(this, arguments);
        };

        return originalSend.apply(this, arguments);
    };

    console.log('[Hook] XHR interceptor installed');
})();
```

#### 1.2 Fetch Hook

```javascript
(function hookFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function(input, init = {}) {
        const url = typeof input === 'string' ? input : input.url;
        const method = init.method || 'GET';

        console.group(`[Fetch] ${method} ${url}`);
        console.log('Options:', init);

        const startTime = performance.now();

        try {
            const response = await originalFetch.apply(this, arguments);
            const duration = performance.now() - startTime;

            // Clone to read body without consuming
            const clone = response.clone();

            console.log('Status:', response.status);
            console.log('Headers:', Object.fromEntries(response.headers.entries()));

            // Try to log response body
            try {
                const contentType = response.headers.get('content-type');
                if (contentType?.includes('json')) {
                    console.log('Body:', await clone.json());
                } else {
                    const text = await clone.text();
                    console.log('Body:', text.substring(0, 500));
                }
            } catch (e) {}

            console.log('Duration:', duration.toFixed(2), 'ms');
            console.groupEnd();

            return response;
        } catch (error) {
            console.error('Error:', error);
            console.groupEnd();
            throw error;
        }
    };

    console.log('[Hook] Fetch interceptor installed');
})();
```

#### 1.3 WebSocket Hook

```javascript
(function hookWebSocket() {
    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function(url, protocols) {
        console.log(`[WebSocket] Connecting to: ${url}`);

        const ws = new OriginalWebSocket(url, protocols);

        // Hook send
        const originalSend = ws.send;
        ws.send = function(data) {
            console.log('[WebSocket] Send:', data);
            return originalSend.apply(this, arguments);
        };

        // Hook message event
        ws.addEventListener('message', function(event) {
            console.log('[WebSocket] Receive:', event.data);
        });

        // Hook other events
        ws.addEventListener('open', () => console.log('[WebSocket] Connected'));
        ws.addEventListener('close', (e) => console.log('[WebSocket] Closed:', e.code, e.reason));
        ws.addEventListener('error', (e) => console.error('[WebSocket] Error:', e));

        return ws;
    };

    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

    console.log('[Hook] WebSocket interceptor installed');
})();
```

### Step 2: Storage Hooks

#### 2.1 localStorage/sessionStorage Hook

```javascript
(function hookStorage() {
    ['localStorage', 'sessionStorage'].forEach(storageName => {
        const storage = window[storageName];

        // Hook setItem
        const originalSetItem = storage.setItem.bind(storage);
        storage.setItem = function(key, value) {
            console.log(`[${storageName}] SET: ${key} =`, value);
            return originalSetItem(key, value);
        };

        // Hook getItem
        const originalGetItem = storage.getItem.bind(storage);
        storage.getItem = function(key) {
            const value = originalGetItem(key);
            console.log(`[${storageName}] GET: ${key} =`, value);
            return value;
        };

        // Hook removeItem
        const originalRemoveItem = storage.removeItem.bind(storage);
        storage.removeItem = function(key) {
            console.log(`[${storageName}] REMOVE: ${key}`);
            return originalRemoveItem(key);
        };
    });

    console.log('[Hook] Storage interceptor installed');
})();
```

#### 2.2 Cookie Hook

```javascript
(function hookCookies() {
    let cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
                     Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');

    if (cookieDesc && cookieDesc.configurable) {
        Object.defineProperty(document, 'cookie', {
            get: function() {
                const value = cookieDesc.get.call(document);
                console.log('[Cookie] GET:', value);
                return value;
            },
            set: function(val) {
                console.log('[Cookie] SET:', val);
                cookieDesc.set.call(document, val);
            },
            configurable: true
        });
    }

    console.log('[Hook] Cookie interceptor installed');
})();
```

### Step 3: Crypto API Hooks

```javascript
(function hookCrypto() {
    // Hook Web Crypto API
    if (window.crypto?.subtle) {
        const subtle = crypto.subtle;

        // Hook encrypt
        const originalEncrypt = subtle.encrypt.bind(subtle);
        subtle.encrypt = async function(algorithm, key, data) {
            console.group('[Crypto] encrypt');
            console.log('Algorithm:', algorithm);
            console.log('Data:', new Uint8Array(data));
            const result = await originalEncrypt(algorithm, key, data);
            console.log('Result:', new Uint8Array(result));
            console.groupEnd();
            return result;
        };

        // Hook decrypt
        const originalDecrypt = subtle.decrypt.bind(subtle);
        subtle.decrypt = async function(algorithm, key, data) {
            console.group('[Crypto] decrypt');
            console.log('Algorithm:', algorithm);
            console.log('Data:', new Uint8Array(data));
            const result = await originalDecrypt(algorithm, key, data);
            console.log('Result:', new TextDecoder().decode(result));
            console.groupEnd();
            return result;
        };

        // Hook digest
        const originalDigest = subtle.digest.bind(subtle);
        subtle.digest = async function(algorithm, data) {
            console.group('[Crypto] digest');
            console.log('Algorithm:', algorithm);
            console.log('Data:', new Uint8Array(data));
            const result = await originalDigest(algorithm, data);
            console.log('Result:', Array.from(new Uint8Array(result))
                .map(b => b.toString(16).padStart(2, '0')).join(''));
            console.groupEnd();
            return result;
        };

        // Hook sign
        const originalSign = subtle.sign.bind(subtle);
        subtle.sign = async function(algorithm, key, data) {
            console.group('[Crypto] sign');
            console.log('Algorithm:', algorithm);
            console.log('Data:', new Uint8Array(data));
            const result = await originalSign(algorithm, key, data);
            console.log('Signature:', new Uint8Array(result));
            console.groupEnd();
            return result;
        };

        // Hook generateKey
        const originalGenerateKey = subtle.generateKey.bind(subtle);
        subtle.generateKey = async function(algorithm, extractable, keyUsages) {
            console.group('[Crypto] generateKey');
            console.log('Algorithm:', algorithm);
            console.log('Extractable:', extractable);
            console.log('Usages:', keyUsages);
            const result = await originalGenerateKey(algorithm, extractable, keyUsages);
            console.log('Key generated');
            console.groupEnd();
            return result;
        };
    }

    // Hook CryptoJS if present
    if (window.CryptoJS) {
        const algorithms = ['AES', 'DES', 'TripleDES', 'RC4', 'Rabbit'];

        algorithms.forEach(alg => {
            if (CryptoJS[alg]) {
                const original = CryptoJS[alg].encrypt;
                CryptoJS[alg].encrypt = function(message, key, cfg) {
                    console.group(`[CryptoJS] ${alg}.encrypt`);
                    console.log('Message:', message.toString());
                    console.log('Key:', key.toString());
                    console.log('Config:', cfg);
                    const result = original.apply(this, arguments);
                    console.log('Result:', result.toString());
                    console.groupEnd();
                    return result;
                };
            }
        });

        // Hook hash functions
        ['MD5', 'SHA1', 'SHA256', 'SHA512'].forEach(hash => {
            if (CryptoJS[hash]) {
                const original = CryptoJS[hash];
                CryptoJS[hash] = function(message) {
                    console.log(`[CryptoJS] ${hash}:`, message.toString(),
                        '->', original.apply(this, arguments).toString());
                    return original.apply(this, arguments);
                };
            }
        });
    }

    console.log('[Hook] Crypto interceptor installed');
})();
```

### Step 4: Function Hooking Utilities

```javascript
// Generic function hooker
function hookFunction(obj, methodName, options = {}) {
    const original = obj[methodName];
    if (!original) return null;

    const {
        before = null,      // (args) => void
        after = null,       // (result, args) => void
        transform = null,   // (result) => newResult
        label = methodName
    } = options;

    obj[methodName] = function(...args) {
        console.group(`[Hook] ${label}`);

        if (before) before(args);
        console.log('Arguments:', args);

        let result = original.apply(this, args);

        // Handle promises
        if (result instanceof Promise) {
            return result.then(res => {
                if (after) after(res, args);
                console.log('Result:', res);
                console.groupEnd();
                return transform ? transform(res) : res;
            });
        }

        if (after) after(result, args);
        console.log('Result:', result);
        console.groupEnd();

        return transform ? transform(result) : result;
    };

    // Store original for restoration
    obj[methodName].__original = original;
    return original;
}

// Restore hooked function
function unhookFunction(obj, methodName) {
    if (obj[methodName].__original) {
        obj[methodName] = obj[methodName].__original;
        return true;
    }
    return false;
}

// Example usage:
// hookFunction(JSON, 'parse', { label: 'JSON.parse' });
// hookFunction(JSON, 'stringify', { label: 'JSON.stringify' });
// hookFunction(window, 'atob', { label: 'atob' });
// hookFunction(window, 'btoa', { label: 'btoa' });
```

### Step 5: Event Listener Hooks

```javascript
(function hookEventListeners() {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const originalRemoveEventListener = EventTarget.prototype.removeEventListener;

    const listenerMap = new WeakMap();

    EventTarget.prototype.addEventListener = function(type, listener, options) {
        console.log(`[Event] addEventListener: ${type}`, this);

        // Track listeners
        if (!listenerMap.has(this)) {
            listenerMap.set(this, {});
        }
        const listeners = listenerMap.get(this);
        if (!listeners[type]) {
            listeners[type] = [];
        }
        listeners[type].push({ listener, options });

        return originalAddEventListener.apply(this, arguments);
    };

    EventTarget.prototype.removeEventListener = function(type, listener, options) {
        console.log(`[Event] removeEventListener: ${type}`, this);
        return originalRemoveEventListener.apply(this, arguments);
    };

    // Utility to get all listeners
    window.getEventListeners = function(element) {
        return listenerMap.get(element) || {};
    };

    console.log('[Hook] Event listener interceptor installed');
})();
```

### Step 6: DOM Mutation Hooks

```javascript
(function hookDOM() {
    // Hook createElement
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = function(tagName, options) {
        const element = originalCreateElement(tagName, options);

        if (['script', 'iframe', 'link'].includes(tagName.toLowerCase())) {
            console.log(`[DOM] createElement: ${tagName}`);

            // Hook src/href attribute
            const originalSetAttribute = element.setAttribute.bind(element);
            element.setAttribute = function(name, value) {
                if (['src', 'href'].includes(name)) {
                    console.log(`[DOM] ${tagName}.${name} = ${value}`);
                }
                return originalSetAttribute(name, value);
            };
        }

        return element;
    };

    // Hook innerHTML
    const originalInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', {
        set: function(value) {
            if (value.includes('<script') || value.includes('javascript:')) {
                console.log('[DOM] innerHTML with script:', value.substring(0, 200));
            }
            return originalInnerHTML.set.call(this, value);
        },
        get: function() {
            return originalInnerHTML.get.call(this);
        }
    });

    console.log('[Hook] DOM interceptor installed');
})();
```

## Complete Hooking Framework

```javascript
// All-in-one browser hooking framework
const BrowserHooks = {
    logs: [],
    enabled: true,

    log(category, action, data) {
        if (!this.enabled) return;

        const entry = {
            timestamp: Date.now(),
            category,
            action,
            data
        };

        this.logs.push(entry);
        console.log(`[${category}] ${action}:`, data);
    },

    install() {
        this.hookXHR();
        this.hookFetch();
        this.hookWebSocket();
        this.hookStorage();
        this.hookCrypto();
        this.hookJSON();
        console.log('[BrowserHooks] All hooks installed');
    },

    hookXHR() { /* ... */ },
    hookFetch() { /* ... */ },
    hookWebSocket() { /* ... */ },
    hookStorage() { /* ... */ },
    hookCrypto() { /* ... */ },
    hookJSON() { /* ... */ },

    export() {
        return JSON.stringify(this.logs, null, 2);
    },

    clear() {
        this.logs = [];
    }
};

// Usage: BrowserHooks.install();
```

## Output Format

```markdown
## Browser Hook Analysis Report

### Intercepted Activity

#### Network Requests
| Time | Method | URL | Status | Duration |
|------|--------|-----|--------|----------|
| {{TIME}} | {{METHOD}} | {{URL}} | {{STATUS}} | {{MS}}ms |

#### Storage Operations
| Time | Storage | Operation | Key | Value |
|------|---------|-----------|-----|-------|
| {{TIME}} | localStorage | SET | {{KEY}} | {{VALUE}} |

#### Crypto Operations
| Time | Function | Input | Output |
|------|----------|-------|--------|
| {{TIME}} | {{FUNC}} | {{INPUT}} | {{OUTPUT}} |

### Patterns Identified
- {{PATTERN_1}}
- {{PATTERN_2}}

### Code Snippets
```javascript
{{RELEVANT_CODE}}
```
```

## Usage

```
/browser-hook

[Describe what you want to intercept or paste code to analyze]
```

This will:
1. Generate appropriate hook code
2. Provide injection methods
3. Create logging and export utilities
4. Help analyze intercepted data
