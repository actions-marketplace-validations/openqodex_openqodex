---
name: auth-timing-attack-password-compare
description: Password / token / secret compared with == / === instead of a constant-time check
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "*.py"
    - "*.go"
    - "*.rb"
    - "*.java"
    - "*.kt"
    - "*.cs"
    - "*.php"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.py"
    - "**/*.go"
    - "**/*.rb"
    - "**/*.java"
    - "**/*.kt"
    - "**/*.cs"
    - "**/*.php"
  hunk_regex: "(password|secret|token|hmac|signature|apiKey|api_key)\\b\\s*[!=]==?"
security: true
confidence_floor: 0.7
---

A password / token / signature / HMAC / API key is being compared
with `==`, `===`, `!=`, `!==`, `.equals()`, or `strcmp`, all of
which short-circuit on the first byte mismatch and leak timing
information. An attacker can recover the secret byte-by-byte by
measuring response latency, especially against repeatedly-callable
endpoints.

Flag when:
- the comparison's left or right operand is named or sourced from
  the request as a `password|secret|token|hmac|signature|apiKey`
- the operator is a default `==` / `===` / `!==` / `equals`

Suppress when:
- the call is `crypto.timingSafeEqual` /
  `hmac.compare_digest` (Python) /
  `subtle.ConstantTimeCompare` (Go) /
  `MessageDigest.isEqual` (Java)
- the comparison is on the OUTPUT of a verified KDF (bcrypt /
  scrypt / argon2 `compare`); the KDF wrapper is already
  constant-time and that's the recommended API
- the comparison is against a literal "empty"/"missing" sentinel
  (`token === undefined`); that's an existence check, not a value
  match
