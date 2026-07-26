---
name: re-writeup
description: Generate professional reverse engineering writeup documents. Creates structured analysis reports for CTF challenges, malware analysis, vulnerability research, and algorithm extraction. Includes fixed templates for different RE scenarios.
---

# Reverse Engineering Writeup Skill

A skill for generating professional, structured reverse engineering writeup documents with fixed templates for various analysis scenarios.

## Template Categories

1. **CTF Challenge Writeup** - Competition problem solving
2. **Malware Analysis Report** - Malicious software analysis
3. **Vulnerability Research** - Security vulnerability documentation
4. **Algorithm Extraction** - Native code algorithm reverse
5. **Protocol Analysis** - Network/communication protocol RE
6. **Mobile App Analysis** - Android/iOS app security assessment

---

## Template 1: CTF Challenge Writeup

```markdown
# [Challenge Name] - [Category]

## Challenge Information

| Item | Value |
|------|-------|
| **CTF** | [CTF Name Year] |
| **Category** | Reverse / Pwn / Crypto / Misc |
| **Points** | [Points] |
| **Solves** | [Number] |
| **Author** | [Challenge Author] |
| **Files** | [Attachments] |

## Description

> [Original challenge description]

## TL;DR

[One sentence summary of the solution]

---

## Initial Analysis

### File Information

```
$ file challenge
challenge: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked...

$ checksec challenge
Arch:     amd64-64-little
RELRO:    Full RELRO
Stack:    Canary found
NX:       NX enabled
PIE:      PIE enabled
```

### First Impressions

[Brief description of what the binary does when executed]

---

## Static Analysis

### Main Function

```c
// Decompiled pseudocode
int main(int argc, char *argv[]) {
    // Key logic here
}
```

### Key Functions Identified

| Function | Address | Purpose |
|----------|---------|---------|
| `main` | 0x1234 | Entry point |
| `check_flag` | 0x5678 | Flag validation |
| `encrypt` | 0x9ABC | Encryption routine |

### Algorithm Analysis

[Detailed explanation of the core algorithm/logic]

---

## Dynamic Analysis

### Debugging Session

```
$ gdb ./challenge
(gdb) break *main+0x50
(gdb) run
(gdb) x/20x $rsp
```

### Key Observations

1. [Observation 1]
2. [Observation 2]
3. [Observation 3]

---

## Solution

### Approach

[Explain the solution strategy]

### Exploit / Solver Script

```python
#!/usr/bin/env python3
# solve.py

def solve():
    # Solution implementation
    pass

if __name__ == "__main__":
    flag = solve()
    print(f"Flag: {flag}")
```

### Execution

```
$ python3 solve.py
Flag: flag{example_flag_here}
```

---

## Flag

```
flag{example_flag_here}
```

---

## Lessons Learned

- [Key takeaway 1]
- [Key takeaway 2]
- [New technique learned]

## References

- [Reference 1](url)
- [Reference 2](url)
```

---

## Template 2: Malware Analysis Report

```markdown
# Malware Analysis Report

## Executive Summary

| Item | Value |
|------|-------|
| **Sample Name** | [Filename] |
| **SHA256** | `[hash]` |
| **File Type** | PE32 / ELF / APK / etc. |
| **File Size** | [Size] |
| **First Seen** | [Date] |
| **Malware Family** | [Family Name] |
| **Threat Level** | Critical / High / Medium / Low |

### Key Findings

- [Finding 1]
- [Finding 2]
- [Finding 3]

---

## Sample Information

### File Hashes

| Algorithm | Hash |
|-----------|------|
| MD5 | `[md5]` |
| SHA1 | `[sha1]` |
| SHA256 | `[sha256]` |
| SSDEEP | `[ssdeep]` |

### PE/ELF Information

```
File Type: PE32 executable (GUI) Intel 80386
Compiler: Microsoft Visual C++ 2019
Timestamp: 2024-01-15 10:30:00 UTC
Sections: .text, .rdata, .data, .rsrc
Imports: kernel32.dll, user32.dll, ws2_32.dll
```

### Digital Signature

[Signed/Unsigned, Certificate details if present]

---

## Behavioral Analysis

### Sandbox Execution Summary

| Behavior | Details |
|----------|---------|
| **Network** | Connects to C2 server at `evil.com:443` |
| **File System** | Creates `%TEMP%\payload.exe` |
| **Registry** | Adds persistence in `Run` key |
| **Process** | Injects into `explorer.exe` |

### Network Indicators (IOCs)

#### C2 Servers
```
185.123.45.67:443
evil-domain.com
cdn.malware-c2.net
```

#### HTTP Requests
```
POST /api/beacon HTTP/1.1
Host: evil-domain.com
User-Agent: Mozilla/5.0 (compatible)
Content-Type: application/octet-stream
```

### File System Artifacts

```
C:\Users\<user>\AppData\Local\Temp\payload.exe
C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\update.lnk
C:\Windows\System32\drivers\rootkit.sys
```

### Registry Modifications

```
[HKCU\Software\Microsoft\Windows\CurrentVersion\Run]
"WindowsUpdate" = "C:\Users\<user>\AppData\Local\Temp\payload.exe"

[HKLM\SYSTEM\CurrentControlSet\Services\MalService]
"ImagePath" = "..."
```

---

## Static Analysis

### Packer/Protector Detection

```
Packer: UPX 3.96
Entropy: 7.2 (packed)
After unpacking: 5.1 (normal)
```

### Strings Analysis

#### Suspicious Strings
```
cmd.exe /c
powershell -enc
http://evil.com/payload
SOFTWARE\Microsoft\Windows\CurrentVersion\Run
```

#### Encrypted/Obfuscated Strings

| Encoded | Decoded |
|---------|---------|
| `YWRtaW4=` | admin |
| `0x41, 0x42...` | [Decrypted string] |

### Import Analysis

#### Key APIs
```
CreateRemoteThread    - Process injection
VirtualAllocEx        - Remote memory allocation
WriteProcessMemory    - Code injection
InternetOpenA         - Network communication
CryptEncrypt          - Data encryption
```

---

## Code Analysis

### Anti-Analysis Techniques

| Technique | Implementation |
|-----------|---------------|
| Anti-Debug | `IsDebuggerPresent()`, timing checks |
| Anti-VM | Registry checks, CPUID instruction |
| Anti-Sandbox | Mouse movement detection, sleep acceleration |
| Obfuscation | Control flow flattening, string encryption |

### Core Functionality

#### Stage 1: Loader
```c
// Pseudocode
void loader() {
    decrypt_payload();
    inject_into_process("explorer.exe");
}
```

#### Stage 2: Main Module
```c
// Key functionality
void main_module() {
    establish_persistence();
    connect_to_c2();
    execute_commands();
}
```

### Encryption Algorithm

```
Algorithm: AES-256-CBC
Key Derivation: PBKDF2(password, salt, 10000)
IV: First 16 bytes of encrypted data
```

---

## MITRE ATT&CK Mapping

| Tactic | Technique | ID |
|--------|-----------|-----|
| Execution | User Execution | T1204 |
| Persistence | Registry Run Keys | T1547.001 |
| Defense Evasion | Process Injection | T1055 |
| C2 | Web Protocols | T1071.001 |
| Exfiltration | Exfiltration Over C2 | T1041 |

---

## Indicators of Compromise (IOCs)

### File Hashes
```
SHA256: abc123...
SHA256: def456...
```

### Network
```
IP: 185.123.45.67
Domain: evil-domain.com
URL: http://evil.com/api/beacon
```

### YARA Rule

```yara
rule MalwareFamily_Variant {
    meta:
        description = "Detects MalwareFamily variant"
        author = "Analyst Name"
        date = "2024-01-15"

    strings:
        $s1 = "unique_string_1" ascii
        $s2 = { 41 42 43 44 ?? ?? 45 46 }
        $s3 = /http:\/\/[a-z]+\.evil\.com/

    condition:
        uint16(0) == 0x5A4D and
        2 of ($s*)
}
```

---

## Recommendations

### Detection
- [Detection rule/signature]
- [Network monitoring suggestion]

### Remediation
1. [Step 1]
2. [Step 2]
3. [Step 3]

### Prevention
- [Prevention measure 1]
- [Prevention measure 2]

---

## Appendix

### Tools Used
- IDA Pro 8.3
- x64dbg
- Process Monitor
- Wireshark
- ANY.RUN Sandbox

### References
- [Reference 1]
- [Reference 2]
```

---

## Template 3: Algorithm Extraction Report

```markdown
# Algorithm Extraction Report

## Target Information

| Item | Value |
|------|-------|
| **Application** | [App Name] |
| **Package** | [com.example.app] |
| **Library** | libnative.so |
| **Architecture** | ARM64 / ARM / x86 |
| **Target Function** | [Function name/signature] |

## Objective

[What algorithm needs to be extracted and why]

---

## Analysis Environment

- **Disassembler**: IDA Pro 8.3 / Ghidra 11.0
- **Emulator**: unidbg 0.9.7 / Frida 16.x
- **Device**: [Real device / Emulator]

---

## Target Identification

### Function Location

```
Library: libnative.so
Symbol: Java_com_example_app_Crypto_sign
Address: 0x12340 (base + offset)
```

### JNI Signature

```java
// Java side
public class Crypto {
    public static native String sign(String input, long timestamp);
}
```

---

## Reverse Engineering Process

### Step 1: Initial Reconnaissance

```
$ nm -D libnative.so | grep sign
00012340 T Java_com_example_app_Crypto_sign
```

### Step 2: Decompilation

```c
// IDA Pro decompiled pseudocode
char* Java_com_example_app_Crypto_sign(JNIEnv *env, jclass cls,
                                        jstring input, jlong timestamp) {
    const char *str = (*env)->GetStringUTFChars(env, input, NULL);

    // Key algorithm
    char buffer[256];
    sprintf(buffer, "%s|%ld", str, timestamp);

    unsigned char hash[32];
    sha256(buffer, strlen(buffer), hash);

    char *result = bytes_to_hex(hash, 32);

    (*env)->ReleaseStringUTFChars(env, input, str);
    return (*env)->NewStringUTF(env, result);
}
```

### Step 3: Algorithm Identification

| Component | Implementation |
|-----------|---------------|
| Hash Function | SHA-256 |
| Input Format | `"{input}|{timestamp}"` |
| Output Format | Hex string (64 chars) |

### Step 4: Sub-function Analysis

#### SHA-256 Implementation
```c
// Custom or standard implementation
void sha256(const void *data, size_t len, uint8_t *out) {
    // Standard SHA-256 or custom variant
}
```

#### Constants Verification
```
// SHA-256 initial hash values
H0 = 0x6a09e667
H1 = 0xbb67ae85
H2 = 0x3c6ef372
...
```

---

## Extracted Algorithm

### Python Implementation

```python
#!/usr/bin/env python3
"""
Extracted algorithm from libnative.so
Target: com.example.app.Crypto.sign()
"""

import hashlib
import time

def sign(input_str: str, timestamp: int = None) -> str:
    """
    Replicate native sign function.

    Args:
        input_str: Input string to sign
        timestamp: Unix timestamp (ms), defaults to current time

    Returns:
        64-character hex string (SHA-256 hash)
    """
    if timestamp is None:
        timestamp = int(time.time() * 1000)

    # Construct input as: "input|timestamp"
    data = f"{input_str}|{timestamp}"

    # SHA-256 hash
    hash_bytes = hashlib.sha256(data.encode('utf-8')).digest()

    # Convert to hex string
    return hash_bytes.hex()


# Verification
if __name__ == "__main__":
    # Test case from dynamic analysis
    test_input = "hello"
    test_timestamp = 1705320000000
    expected = "a1b2c3d4..."  # From app

    result = sign(test_input, test_timestamp)
    print(f"Input: {test_input}")
    print(f"Timestamp: {test_timestamp}")
    print(f"Result: {result}")
    print(f"Match: {result == expected}")
```

### Java Implementation

```java
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;

public class CryptoSign {

    public static String sign(String input, long timestamp) {
        try {
            String data = input + "|" + timestamp;

            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(data.getBytes(StandardCharsets.UTF_8));

            return bytesToHex(hash);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
```

---

## Verification

### Test Cases

| Input | Timestamp | Expected | Actual | Status |
|-------|-----------|----------|--------|--------|
| hello | 1705320000000 | a1b2c3... | a1b2c3... | PASS |
| test | 1705320001000 | d4e5f6... | d4e5f6... | PASS |
| "" | 1705320002000 | g7h8i9... | g7h8i9... | PASS |

### Dynamic Verification (Frida)

```javascript
// frida -U -f com.example.app -l verify.js

Java.perform(function() {
    var Crypto = Java.use("com.example.app.Crypto");

    Crypto.sign.implementation = function(input, timestamp) {
        var result = this.sign(input, timestamp);
        console.log("Input: " + input);
        console.log("Timestamp: " + timestamp);
        console.log("Result: " + result);
        return result;
    };
});
```

---

## Notes

### Edge Cases
- Empty string input: [Behavior]
- Negative timestamp: [Behavior]
- Unicode characters: [Behavior]

### Potential Variations
- Server-side may add salt
- Different app versions may use different algorithms

---

## References

- [SHA-256 specification](url)
- [Related research](url)
```

---

## Template 4: Mobile App Security Assessment

```markdown
# Mobile Application Security Assessment

## Application Information

| Item | Value |
|------|-------|
| **App Name** | [Application Name] |
| **Package** | com.example.app |
| **Version** | 1.2.3 (Build 456) |
| **Platform** | Android / iOS |
| **Min SDK** | 21 (Android 5.0) |
| **Target SDK** | 34 (Android 14) |
| **Assessment Date** | [Date] |

---

## Executive Summary

### Risk Rating: [High/Medium/Low]

| Category | Findings | Risk |
|----------|----------|------|
| Data Storage | 3 | High |
| Network Security | 2 | Medium |
| Code Security | 4 | High |
| Authentication | 1 | Low |

### Critical Findings
1. [Critical finding 1]
2. [Critical finding 2]

---

## Methodology

### Tools Used
- jadx-gui 1.4.7
- apktool 2.9.0
- Frida 16.1.0
- Objection 1.11.0
- MobSF 3.7.0
- Burp Suite Professional

### Testing Approach
1. Static analysis of APK/IPA
2. Dynamic analysis on rooted device
3. Network traffic interception
4. Runtime manipulation with Frida

---

## Findings

### Finding 1: Hardcoded API Keys

**Severity**: High
**Location**: `com/example/app/Config.java`
**CWE**: CWE-798 (Use of Hard-coded Credentials)

#### Description
API keys are hardcoded in the application source code.

#### Evidence
```java
public class Config {
    public static final String API_KEY = "sk_live_abc123xyz789";
    public static final String SECRET = "super_secret_key_123";
}
```

#### Impact
Attackers can extract these keys and abuse API access.

#### Recommendation
- Use Android Keystore / iOS Keychain
- Implement server-side key management
- Use certificate pinning

---

### Finding 2: Insecure Data Storage

**Severity**: High
**Location**: `/data/data/com.example.app/shared_prefs/`
**CWE**: CWE-312 (Cleartext Storage of Sensitive Information)

#### Description
Sensitive user data stored in plaintext SharedPreferences.

#### Evidence
```xml
<!-- user_prefs.xml -->
<map>
    <string name="auth_token">eyJhbGciOiJIUzI1NiIs...</string>
    <string name="password">plaintextpassword123</string>
    <string name="credit_card">4111111111111111</string>
</map>
```

#### Frida Script
```javascript
Java.perform(function() {
    var SharedPreferences = Java.use("android.content.SharedPreferences");
    // Hook to detect sensitive data access
});
```

#### Recommendation
- Encrypt sensitive data with Android Keystore
- Use EncryptedSharedPreferences
- Never store passwords locally

---

### Finding 3: Missing Certificate Pinning

**Severity**: Medium
**Location**: Network layer
**CWE**: CWE-295 (Improper Certificate Validation)

#### Description
Application accepts any valid SSL certificate, vulnerable to MITM.

#### Evidence
Successfully intercepted HTTPS traffic with Burp Suite proxy.

#### Recommendation
```java
// Implement certificate pinning
CertificatePinner pinner = new CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAA=")
    .build();
```

---

### Finding 4: Root/Jailbreak Detection Bypass

**Severity**: Low
**Location**: `com/example/app/security/RootDetection.java`
**CWE**: CWE-919 (Weaknesses in Mobile Applications)

#### Description
Root detection can be easily bypassed.

#### Original Check
```java
public boolean isRooted() {
    return new File("/system/app/Superuser.apk").exists() ||
           new File("/system/bin/su").exists();
}
```

#### Bypass Script
```javascript
Java.perform(function() {
    var RootDetection = Java.use("com.example.app.security.RootDetection");
    RootDetection.isRooted.implementation = function() {
        console.log("Root detection bypassed");
        return false;
    };
});
```

#### Recommendation
- Implement multiple detection methods
- Use SafetyNet/Play Integrity API
- Implement tamper detection

---

## Native Library Analysis

### Libraries Identified

| Library | Size | Purpose |
|---------|------|---------|
| libnative.so | 2.3 MB | Core crypto functions |
| libssl.so | 1.1 MB | OpenSSL |
| libcrypto.so | 890 KB | Crypto primitives |

### Security Features

```
$ checksec libnative.so
RELRO:    Full RELRO
Stack:    Canary found
NX:       NX enabled
PIE:      PIE enabled
```

### JNI Functions

| Function | Purpose |
|----------|---------|
| `Java_*_encrypt` | Data encryption |
| `Java_*_sign` | Request signing |
| `Java_*_verify` | Signature verification |

---

## Network Security

### Endpoints Identified

| Endpoint | Method | Auth | Issues |
|----------|--------|------|--------|
| `/api/login` | POST | None | No rate limiting |
| `/api/user` | GET | Bearer | Token in URL |
| `/api/payment` | POST | Bearer | Missing encryption |

### Sample Request
```http
POST /api/login HTTP/1.1
Host: api.example.com
Content-Type: application/json

{"username":"test","password":"password123"}
```

---

## Recommendations Summary

| Priority | Finding | Recommendation |
|----------|---------|---------------|
| P1 | Hardcoded keys | Use secure key storage |
| P1 | Plaintext storage | Implement encryption |
| P2 | No cert pinning | Add certificate pinning |
| P3 | Weak root detection | Enhance detection |

---

## Appendix

### A. Full Frida Scripts
[Attached]

### B. Decompiled Source Highlights
[Attached]

### C. Network Traffic Samples
[Attached]
```

---

## Usage

```
/re-writeup [type]

Types: ctf, malware, algorithm, mobile, protocol, vulnerability
Target: [Description of the target]
```

The assistant will:
1. Select the appropriate template
2. Fill in with analysis details
3. Generate code samples and IOCs
4. Create professional documentation

## Tips

1. **Be thorough** - Include all relevant technical details
2. **Add evidence** - Screenshots, code snippets, logs
3. **Stay objective** - Report facts, not assumptions
4. **Include IOCs** - Hashes, IPs, domains, YARA rules
5. **Provide remediation** - Actionable recommendations
6. **Reference sources** - Credit tools and research
