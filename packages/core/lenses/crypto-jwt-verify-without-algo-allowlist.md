---
name: crypto-jwt-verify-without-algo-allowlist
description: jwt.verify called without an explicit algorithms allowlist
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
  hunk_regex: "jwt(\\.|.{0,40})verify\\s*\\(|jsonwebtoken|jose"
security: true
confidence_floor: 0.75
---

A JWT is verified without passing an explicit `algorithms` option.
The `jsonwebtoken` library historically accepted whatever the token
header declared, which lets an attacker switch to `alg: "none"`
(no signature) or downgrade an RSA-signed token to an HMAC verify
where the public key gets reused as the HMAC secret. Recent
versions tightened defaults but the attack returns the moment the
project pins an older version or uses an alternate library with
permissive defaults.

Flag when `jwt.verify(token, secret)` is called without `{
algorithms: ['HS256'|'RS256'|...] }` in the third argument.

Suppress when:
- `algorithms: [...]` is passed (with a concrete allow-list, not
  e.g. `['none', ...]`)
- the library is `jose` and the call form already enforces alg via
  the key object's `alg` field
- the verify is inside a wrapper that lints algorithms internally
  (look for the wrapper definition before raising)
