---
name: crypto-md5-sha1-for-secrets
description: MD5 / SHA-1 used for passwords, tokens, or signatures
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
  hunk_regex: "\\b(md5|sha1|sha-?1)\\b|MessageDigest\\.getInstance\\s*\\(\\s*[\"'](MD5|SHA-?1)[\"']"
security: true
confidence_floor: 0.7
---

MD5 and SHA-1 are broken hashes for any security-bearing use:
collision attacks are practical on both, and pre-image attacks
on MD5 are within reach. Using them to hash passwords, derive
keys, or sign / verify integrity is a real bug, not a stylistic
preference.

Flag when MD5 / SHA-1 is used to:
- hash a password / passphrase (use bcrypt / scrypt / argon2)
- derive a key from a secret (use HKDF / PBKDF2)
- sign or verify a token / payload (use HMAC-SHA256 or better)

Suppress when:
- used for a NON-security purpose: ETag generation, cache key,
  content addressing, deterministic identifier (the hash's
  cryptographic weakness doesn't matter for cache invalidation)
- used to verify an integrity tag returned by an external system
  that itself uses MD5 / SHA-1 (S3 ETag, legacy webhook contract)
- the call is to a `crypto.createHmac('sha1', ...)` and the spec
  the code implements (e.g. AWS Signature V1, older OAuth flows)
  mandates SHA-1

In Java and Kotlin this is `MessageDigest.getInstance("MD5")` or
`getInstance("SHA-1")`. The fix is BCrypt or Argon2 for passwords and
SHA-256 or better for signatures.
