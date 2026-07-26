---
name: analyze-sign
description: Analyze and reverse engineer API signatures, authentication tokens, request signing mechanisms, and cryptographic parameters. Essential for API security research and integration.
---

# Analyze Sign Skill

A comprehensive skill for analyzing signature mechanisms in APIs and applications.

## Signature Analysis Framework

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Signature Analysis                                │
├─────────────────┬─────────────────┬─────────────────┬───────────────┤
│   API Signing   │   Token Auth    │   Crypto Sign   │   Timestamp   │
├─────────────────┼─────────────────┼─────────────────┼───────────────┤
│ • HMAC-SHA      │ • JWT/JWS       │ • RSA/ECDSA     │ • Nonce       │
│ • Request Hash  │ • OAuth         │ • EdDSA         │ • Replay      │
│ • Parameter     │ • API Keys      │ • Hash Chains   │   Protection  │
│   Ordering      │ • Session       │ • MAC           │ • Expiry      │
└─────────────────┴─────────────────┴─────────────────┴───────────────┘
```

## API Signature Analysis

### Request Signature Identification
```python
import hashlib
import hmac
import base64
import json
import re
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse

class SignatureAnalyzer:
    """Analyze API request signatures."""

    def __init__(self):
        self.common_sign_params = [
            'sign', 'signature', 'sig', 'hash', 'checksum',
            'auth', 'token', 'mac', 'digest', 'hmac',
            '_sign', '_signature', 'api_sign', 'request_sign'
        ]
        self.common_timestamp_params = [
            'timestamp', 'ts', 'time', 't', 'nonce',
            '_t', 'request_time', 'datetime'
        ]

    def analyze_request(self, request_data: Dict) -> Dict:
        """Analyze request for signature patterns."""
        analysis = {
            'url': request_data.get('url', ''),
            'method': request_data.get('method', 'GET'),
            'headers': request_data.get('headers', {}),
            'params': request_data.get('params', {}),
            'body': request_data.get('body', ''),
            'signature_candidates': [],
            'timestamp_candidates': [],
            'potential_algorithm': None,
            'signing_params': [],
        }

        # Analyze URL parameters
        parsed_url = urlparse(analysis['url'])
        url_params = parse_qs(parsed_url.query)

        # Find signature parameters
        all_params = {**url_params, **analysis['params']}
        for param, value in all_params.items():
            param_lower = param.lower()

            # Check for signature
            if any(s in param_lower for s in self.common_sign_params):
                val = value[0] if isinstance(value, list) else value
                analysis['signature_candidates'].append({
                    'param': param,
                    'value': val,
                    'length': len(val),
                    'encoding': self._detect_encoding(val),
                    'algorithm_hint': self._guess_algorithm(val),
                })

            # Check for timestamp
            if any(t in param_lower for t in self.common_timestamp_params):
                val = value[0] if isinstance(value, list) else value
                analysis['timestamp_candidates'].append({
                    'param': param,
                    'value': val,
                    'format': self._detect_timestamp_format(val),
                })

        # Analyze headers for auth
        analysis['auth_headers'] = self._analyze_headers(analysis['headers'])

        # Determine potential algorithm
        if analysis['signature_candidates']:
            analysis['potential_algorithm'] = self._determine_algorithm(
                analysis['signature_candidates']
            )

        return analysis

    def _detect_encoding(self, value: str) -> str:
        """Detect encoding of signature value."""
        # Check for hex
        if re.match(r'^[0-9a-fA-F]+$', value):
            return 'hex'

        # Check for base64
        try:
            decoded = base64.b64decode(value)
            if len(decoded) > 0:
                return 'base64'
        except:
            pass

        # Check for base64url
        try:
            # Add padding if needed
            padded = value + '=' * (4 - len(value) % 4)
            decoded = base64.urlsafe_b64decode(padded)
            if len(decoded) > 0:
                return 'base64url'
        except:
            pass

        return 'unknown'

    def _guess_algorithm(self, signature: str) -> str:
        """Guess hashing algorithm from signature length."""
        # Decode first if needed
        if self._detect_encoding(signature) == 'hex':
            byte_length = len(signature) // 2
        elif self._detect_encoding(signature) in ['base64', 'base64url']:
            try:
                byte_length = len(base64.b64decode(signature + '=='))
            except:
                byte_length = len(signature) * 3 // 4
        else:
            byte_length = len(signature)

        # Match to common hash lengths
        algorithm_lengths = {
            16: 'MD5',
            20: 'SHA-1',
            28: 'SHA-224',
            32: 'SHA-256 / SM3',
            48: 'SHA-384',
            64: 'SHA-512',
        }

        return algorithm_lengths.get(byte_length, f'Unknown ({byte_length} bytes)')

    def _detect_timestamp_format(self, value: str) -> str:
        """Detect timestamp format."""
        try:
            val = int(value)
            if val > 1e12:  # Milliseconds
                return 'unix_ms'
            elif val > 1e9:  # Seconds
                return 'unix_s'
            else:
                return 'unknown_numeric'
        except ValueError:
            # Check for ISO format
            if re.match(r'\d{4}-\d{2}-\d{2}', value):
                return 'iso8601'
            return 'string'

    def _analyze_headers(self, headers: Dict) -> Dict:
        """Analyze authentication headers."""
        auth_info = {}

        for header, value in headers.items():
            header_lower = header.lower()

            if header_lower == 'authorization':
                if value.startswith('Bearer '):
                    auth_info['type'] = 'Bearer Token'
                    auth_info['token'] = value[7:]
                    auth_info['token_type'] = self._analyze_token(value[7:])
                elif value.startswith('Basic '):
                    auth_info['type'] = 'Basic Auth'
                elif value.startswith('Digest '):
                    auth_info['type'] = 'Digest Auth'
                elif value.startswith('AWS4-HMAC-SHA256'):
                    auth_info['type'] = 'AWS Signature v4'
                else:
                    auth_info['type'] = 'Custom'
                    auth_info['value'] = value

            elif header_lower in ['x-api-key', 'api-key', 'apikey']:
                auth_info['api_key'] = value

            elif header_lower in ['x-signature', 'x-sign', 'x-hmac']:
                auth_info['signature_header'] = value

        return auth_info

    def _analyze_token(self, token: str) -> str:
        """Analyze token type."""
        parts = token.split('.')
        if len(parts) == 3:
            return 'JWT'
        elif len(parts) == 5:
            return 'JWE'
        else:
            return 'Opaque'

    def _determine_algorithm(self, candidates: List[Dict]) -> str:
        """Determine most likely signing algorithm."""
        if not candidates:
            return 'Unknown'

        # Use first candidate's hint
        return candidates[0].get('algorithm_hint', 'Unknown')


class SignatureReconstructor:
    """Attempt to reconstruct signature algorithm."""

    def __init__(self):
        self.known_patterns = []

    def analyze_multiple_requests(self,
                                   requests: List[Dict]) -> Dict:
        """Analyze multiple requests to find signing pattern."""
        analysis = {
            'constant_params': set(),
            'variable_params': set(),
            'signature_changes': [],
            'timestamp_pattern': None,
            'potential_secret_position': None,
        }

        if len(requests) < 2:
            return {'error': 'Need at least 2 requests for comparison'}

        # Find constant vs variable parameters
        first_params = set(requests[0].get('params', {}).keys())
        for req in requests[1:]:
            current_params = set(req.get('params', {}).keys())
            analysis['constant_params'] = first_params & current_params

        # Track value changes
        param_values = {}
        for req in requests:
            for param, value in req.get('params', {}).items():
                if param not in param_values:
                    param_values[param] = []
                param_values[param].append(value)

        for param, values in param_values.items():
            if len(set(values)) > 1:
                analysis['variable_params'].add(param)

        return analysis

    def test_signature_algorithm(self,
                                  request: Dict,
                                  secret: str,
                                  algorithm: str = 'sha256') -> Dict:
        """Test common signature algorithms."""
        results = {}
        params = request.get('params', {})

        # Extract signature for comparison
        sig_param = None
        sig_value = None
        for param in ['sign', 'signature', 'sig']:
            if param in params:
                sig_param = param
                sig_value = params[param]
                break

        if not sig_value:
            return {'error': 'No signature found in request'}

        # Remove signature from params for signing
        sign_params = {k: v for k, v in params.items() if k != sig_param}

        # Test different signing methods
        test_methods = [
            ('sorted_concat', self._sorted_concat_sign),
            ('sorted_concat_kv', self._sorted_concat_kv_sign),
            ('json_sign', self._json_sign),
            ('url_encode_sign', self._url_encode_sign),
        ]

        for method_name, method in test_methods:
            for algo in ['md5', 'sha1', 'sha256']:
                for encoding in ['hex', 'base64']:
                    computed = method(sign_params, secret, algo, encoding)
                    match = computed.lower() == sig_value.lower()
                    results[f'{method_name}_{algo}_{encoding}'] = {
                        'computed': computed,
                        'expected': sig_value,
                        'match': match,
                    }
                    if match:
                        results['found'] = {
                            'method': method_name,
                            'algorithm': algo,
                            'encoding': encoding,
                        }

        return results

    def _sorted_concat_sign(self,
                             params: Dict,
                             secret: str,
                             algo: str,
                             encoding: str) -> str:
        """Sign by sorting and concatenating values."""
        sorted_values = ''.join(str(v) for k, v in sorted(params.items()))
        data = sorted_values + secret

        return self._hash_and_encode(data, algo, encoding)

    def _sorted_concat_kv_sign(self,
                                params: Dict,
                                secret: str,
                                algo: str,
                                encoding: str) -> str:
        """Sign by sorting and concatenating key=value pairs."""
        sorted_pairs = '&'.join(f'{k}={v}' for k, v in sorted(params.items()))
        data = sorted_pairs + secret

        return self._hash_and_encode(data, algo, encoding)

    def _json_sign(self,
                   params: Dict,
                   secret: str,
                   algo: str,
                   encoding: str) -> str:
        """Sign JSON body."""
        data = json.dumps(params, sort_keys=True, separators=(',', ':')) + secret
        return self._hash_and_encode(data, algo, encoding)

    def _url_encode_sign(self,
                          params: Dict,
                          secret: str,
                          algo: str,
                          encoding: str) -> str:
        """Sign URL-encoded parameters."""
        data = urlencode(sorted(params.items())) + secret
        return self._hash_and_encode(data, algo, encoding)

    def _hash_and_encode(self,
                          data: str,
                          algo: str,
                          encoding: str) -> str:
        """Hash data and encode result."""
        if algo == 'md5':
            hash_obj = hashlib.md5(data.encode())
        elif algo == 'sha1':
            hash_obj = hashlib.sha1(data.encode())
        elif algo == 'sha256':
            hash_obj = hashlib.sha256(data.encode())
        else:
            raise ValueError(f'Unknown algorithm: {algo}')

        if encoding == 'hex':
            return hash_obj.hexdigest()
        elif encoding == 'base64':
            return base64.b64encode(hash_obj.digest()).decode()
        else:
            return hash_obj.hexdigest()
```

## JWT/JWS Analysis

### Token Analysis
```python
import json
import base64
from datetime import datetime

class JWTAnalyzer:
    """Analyze JWT tokens."""

    def analyze_jwt(self, token: str) -> Dict:
        """Decode and analyze JWT token."""
        parts = token.split('.')

        if len(parts) != 3:
            return {'error': 'Invalid JWT format'}

        # Decode header
        header = self._decode_base64url(parts[0])
        payload = self._decode_base64url(parts[1])
        signature = parts[2]

        analysis = {
            'header': header,
            'payload': payload,
            'signature': {
                'value': signature,
                'length': len(base64.urlsafe_b64decode(signature + '==')),
            },
            'algorithm': header.get('alg', 'Unknown'),
            'type': header.get('typ', 'JWT'),
        }

        # Analyze payload claims
        if payload:
            analysis['claims'] = self._analyze_claims(payload)

        # Security checks
        analysis['security'] = self._security_check(header, payload)

        return analysis

    def _decode_base64url(self, data: str) -> Dict:
        """Decode base64url encoded JSON."""
        try:
            # Add padding
            padding = 4 - len(data) % 4
            if padding != 4:
                data += '=' * padding

            decoded = base64.urlsafe_b64decode(data)
            return json.loads(decoded)
        except Exception as e:
            return {'error': str(e)}

    def _analyze_claims(self, payload: Dict) -> Dict:
        """Analyze JWT claims."""
        claims = {}

        # Standard claims
        if 'iat' in payload:
            claims['issued_at'] = datetime.fromtimestamp(payload['iat']).isoformat()

        if 'exp' in payload:
            exp_time = datetime.fromtimestamp(payload['exp'])
            claims['expires_at'] = exp_time.isoformat()
            claims['is_expired'] = datetime.now() > exp_time

        if 'nbf' in payload:
            claims['not_before'] = datetime.fromtimestamp(payload['nbf']).isoformat()

        if 'iss' in payload:
            claims['issuer'] = payload['iss']

        if 'sub' in payload:
            claims['subject'] = payload['sub']

        if 'aud' in payload:
            claims['audience'] = payload['aud']

        # Custom claims
        standard = {'iat', 'exp', 'nbf', 'iss', 'sub', 'aud', 'jti'}
        claims['custom'] = {k: v for k, v in payload.items() if k not in standard}

        return claims

    def _security_check(self, header: Dict, payload: Dict) -> List[str]:
        """Check for common JWT security issues."""
        issues = []

        # Check algorithm
        alg = header.get('alg', '')
        if alg == 'none':
            issues.append('CRITICAL: Algorithm is "none" - token not signed')
        elif alg in ['HS256', 'HS384', 'HS512']:
            issues.append('INFO: Using symmetric algorithm - key must be kept secret')
        elif alg in ['RS256', 'RS384', 'RS512']:
            issues.append('INFO: Using RSA - verify with public key')

        # Check expiration
        if 'exp' not in payload:
            issues.append('WARNING: No expiration claim - token never expires')
        elif payload.get('exp', 0) < datetime.now().timestamp():
            issues.append('INFO: Token is expired')

        # Check for sensitive data
        sensitive_keys = ['password', 'secret', 'key', 'token', 'credit_card']
        for key in payload.keys():
            if any(s in key.lower() for s in sensitive_keys):
                issues.append(f'WARNING: Potentially sensitive data in claim: {key}')

        return issues

    def test_none_algorithm(self, token: str) -> str:
        """Generate unsigned token (for testing only)."""
        parts = token.split('.')
        if len(parts) != 3:
            return ''

        # Modify header to use 'none' algorithm
        header = self._decode_base64url(parts[0])
        header['alg'] = 'none'

        new_header = base64.urlsafe_b64encode(
            json.dumps(header).encode()
        ).rstrip(b'=').decode()

        # Return token without signature
        return f"{new_header}.{parts[1]}."
```

## OAuth Signature Analysis

### OAuth 1.0a Signatures
```python
import time
import random
import string

class OAuthAnalyzer:
    """Analyze OAuth signatures."""

    def analyze_oauth1_request(self, request: Dict) -> Dict:
        """Analyze OAuth 1.0a signed request."""
        auth_header = request.get('headers', {}).get('Authorization', '')

        if not auth_header.startswith('OAuth '):
            return {'error': 'Not an OAuth 1.0a request'}

        # Parse OAuth parameters
        oauth_params = {}
        params_str = auth_header[6:]  # Remove 'OAuth '

        for param in params_str.split(', '):
            if '=' in param:
                key, value = param.split('=', 1)
                oauth_params[key] = value.strip('"')

        return {
            'oauth_consumer_key': oauth_params.get('oauth_consumer_key'),
            'oauth_token': oauth_params.get('oauth_token'),
            'oauth_signature_method': oauth_params.get('oauth_signature_method'),
            'oauth_signature': oauth_params.get('oauth_signature'),
            'oauth_timestamp': oauth_params.get('oauth_timestamp'),
            'oauth_nonce': oauth_params.get('oauth_nonce'),
            'oauth_version': oauth_params.get('oauth_version', '1.0'),
        }

    def construct_signature_base_string(self,
                                         method: str,
                                         url: str,
                                         params: Dict) -> str:
        """Construct OAuth 1.0a signature base string."""
        # Normalize URL
        parsed = urlparse(url)
        normalized_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

        # Sort and encode parameters
        sorted_params = sorted(params.items())
        encoded_params = urlencode(sorted_params)

        # Construct base string
        base_string = '&'.join([
            method.upper(),
            self._percent_encode(normalized_url),
            self._percent_encode(encoded_params),
        ])

        return base_string

    def _percent_encode(self, value: str) -> str:
        """Percent encode string for OAuth."""
        from urllib.parse import quote
        return quote(value, safe='')

    def verify_hmac_signature(self,
                               base_string: str,
                               signature: str,
                               consumer_secret: str,
                               token_secret: str = '') -> bool:
        """Verify OAuth HMAC-SHA1 signature."""
        key = f"{self._percent_encode(consumer_secret)}&{self._percent_encode(token_secret)}"

        computed = hmac.new(
            key.encode(),
            base_string.encode(),
            hashlib.sha1
        )

        expected = base64.b64encode(computed.digest()).decode()
        return expected == signature
```

## Replay Protection Analysis

### Nonce and Timestamp
```python
class ReplayProtectionAnalyzer:
    """Analyze replay protection mechanisms."""

    def analyze_replay_protection(self, requests: List[Dict]) -> Dict:
        """Analyze requests for replay protection mechanisms."""
        analysis = {
            'has_timestamp': False,
            'has_nonce': False,
            'timestamp_window': None,
            'nonce_pattern': None,
        }

        timestamps = []
        nonces = []

        for req in requests:
            params = req.get('params', {})

            # Find timestamps
            for key in ['timestamp', 'ts', 't', 'time']:
                if key in params:
                    analysis['has_timestamp'] = True
                    timestamps.append(params[key])

            # Find nonces
            for key in ['nonce', 'n', 'request_id', 'rid']:
                if key in params:
                    analysis['has_nonce'] = True
                    nonces.append(params[key])

        # Analyze timestamp pattern
        if timestamps:
            try:
                ts_values = [int(ts) for ts in timestamps]
                analysis['timestamp_window'] = {
                    'min': min(ts_values),
                    'max': max(ts_values),
                    'format': 'unix_ms' if max(ts_values) > 1e12 else 'unix_s',
                }
            except ValueError:
                analysis['timestamp_format'] = 'non-numeric'

        # Analyze nonce pattern
        if nonces:
            analysis['nonce_pattern'] = {
                'length': len(nonces[0]),
                'type': self._detect_nonce_type(nonces[0]),
                'unique': len(set(nonces)) == len(nonces),
            }

        return analysis

    def _detect_nonce_type(self, nonce: str) -> str:
        """Detect nonce generation pattern."""
        if nonce.isdigit():
            return 'numeric'
        elif re.match(r'^[0-9a-f]+$', nonce.lower()):
            return 'hex'
        elif re.match(r'^[0-9a-zA-Z]+$', nonce):
            return 'alphanumeric'
        else:
            return 'mixed'

    def test_replay_attack(self,
                            original_request: Dict,
                            delay_seconds: int = 60) -> Dict:
        """Test if request can be replayed."""
        # This would send the same request after a delay
        # For analysis purposes only
        return {
            'timestamp_param': self._find_timestamp_param(original_request),
            'nonce_param': self._find_nonce_param(original_request),
            'recommended_test': [
                'Replay exact request immediately',
                f'Replay after {delay_seconds} seconds',
                'Replay with modified timestamp',
                'Replay with same nonce, new timestamp',
            ],
        }

    def _find_timestamp_param(self, request: Dict) -> Optional[str]:
        """Find timestamp parameter in request."""
        params = request.get('params', {})
        for key in ['timestamp', 'ts', 't', 'time']:
            if key in params:
                return key
        return None

    def _find_nonce_param(self, request: Dict) -> Optional[str]:
        """Find nonce parameter in request."""
        params = request.get('params', {})
        for key in ['nonce', 'n', 'request_id', 'rid']:
            if key in params:
                return key
        return None
```

## Common Signing Patterns

### Reference Implementations
```python
# Common API signing patterns

def aws_signature_v4_pattern():
    """AWS Signature Version 4 pattern."""
    return {
        'algorithm': 'AWS4-HMAC-SHA256',
        'steps': [
            '1. Create canonical request',
            '2. Create string to sign',
            '3. Calculate signing key',
            '4. Calculate signature',
        ],
        'canonical_request': [
            'HTTP method',
            'Canonical URI',
            'Canonical query string',
            'Canonical headers',
            'Signed headers',
            'Hashed payload',
        ],
    }

def wechat_pay_pattern():
    """WeChat Pay signature pattern."""
    return {
        'algorithm': 'HMAC-SHA256',
        'steps': [
            '1. Sort parameters alphabetically',
            '2. Concatenate as key=value&',
            '3. Append &key=API_KEY',
            '4. MD5 or HMAC-SHA256 hash',
            '5. Uppercase result',
        ],
    }

def alipay_pattern():
    """Alipay RSA signature pattern."""
    return {
        'algorithm': 'RSA2 (SHA256withRSA)',
        'steps': [
            '1. Sort parameters alphabetically',
            '2. Concatenate as key=value&',
            '3. Sign with private key',
            '4. Base64 encode signature',
        ],
    }
```

## Checklist

- [ ] Identify signature parameter in request
- [ ] Determine signature encoding (hex/base64)
- [ ] Guess algorithm from signature length
- [ ] Identify timestamp/nonce parameters
- [ ] Analyze multiple requests for patterns
- [ ] Test common signing algorithms
- [ ] Check for replay protection
- [ ] Document signing procedure
- [ ] Verify with test requests
