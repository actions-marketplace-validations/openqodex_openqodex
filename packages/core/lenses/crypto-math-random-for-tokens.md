---
name: crypto-math-random-for-tokens
description: Math.random() used to generate tokens, IDs, or secrets
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "*.java"
    - "*.kt"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.java"
    - "**/*.kt"
  hunk_regex: "Math\\.random\\s*\\(|\\bRandom\\s*\\("
security: true
confidence_floor: 0.75
---

`Math.random()` is a non-cryptographic PRNG. Its state is small,
its output is predictable from observed values, and modern V8 has
been shown to allow practical state-recovery attacks. Any token /
ID / nonce / one-time code generated with `Math.random()` and
used for a security purpose can be guessed.

Flag when `Math.random()` is used to build:
- session / password-reset / verify-email / magic-link tokens
- API keys, invite codes, OTP codes
- CSRF tokens or nonces
- request IDs that gate access (e.g. order-pickup codes)

Suppress when used for:
- jitter / backoff timing
- A/B test bucketing
- animation / UI randomness
- non-security IDs (telemetry trace fragments where collision is
  the only concern)
- in tests, where determinism (`seedrandom`) or non-crypto values
  are the point

Recommend `crypto.randomUUID()` / `crypto.randomBytes(n)` /
`crypto.getRandomValues(...)` per platform.

In Java and Kotlin the same bug is `new Random()`, `java.util.Random()`
or Kotlin's `Random()` where `SecureRandom` is required. `SecureRandom`
itself is the fix, not the bug.
