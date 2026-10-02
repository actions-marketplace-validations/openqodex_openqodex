---
name: cookie-missing-secure-httponly
description: Auth / session cookie set without HttpOnly + Secure + SameSite
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
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.py"
    - "**/*.go"
    - "**/*.rb"
  hunk_regex: "Set-Cookie\\b|res\\.cookie\\b|c\\.cookie\\b|reply\\.setCookie\\b|response\\.setHeader\\(.{0,40}cookie"
security: true
confidence_floor: 0.7
---

A `Set-Cookie` for a session / auth / refresh / CSRF cookie is
emitted without `HttpOnly` (JS-readable, stealable via XSS),
without `Secure` (sent over plain HTTP), or without a `SameSite`
attribute (allows CSRF via cross-site form submits in older
browsers / strict-mode-off contexts).

Flag when a cookie name containing `session|sid|auth|token|refresh`
is set with options that omit `httpOnly: true`, `secure: true`, or
`sameSite: 'strict'|'lax'`.

Suppress when:
- the cookie is intentionally JS-readable (e.g. a CSRF token cookie
  paired with a header-based defense pattern), but check that
  `secure + sameSite` are still set
- the environment is dev/test and the env-gated config explicitly
  disables `secure` for local HTTP only
- a wrapper / framework default applies these attributes globally
  (look for the wrapper's defaults before raising)
