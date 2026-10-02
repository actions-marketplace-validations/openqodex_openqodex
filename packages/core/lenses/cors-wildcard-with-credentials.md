---
name: cors-wildcard-with-credentials
description: "CORS allows '*' origin while also setting credentials: true"
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
  hunk_regex: "(Access-Control-Allow-Origin|cors\\s*\\(|allowOrigins|allow_origin)"
security: true
confidence_floor: 0.75
---

CORS is configured with `Access-Control-Allow-Origin: *` (or a
reflective `origin: true` that echoes the request's `Origin`)
together with `Access-Control-Allow-Credentials: true`. Browsers
reject wildcard + credentials together, but reflective Origin +
credentials lets any origin run authenticated requests against the
API: CSRF and cookie theft become trivial.

Flag when:
- `origin: '*'` is set with `credentials: true`
- `origin: true` (reflective) is set with `credentials: true` AND
  there's no allow-list checked first

Suppress when:
- the origin is a concrete allow-list (`['https://app.example.com', ...]`)
  or matched against one before being echoed
- `credentials: false` (the wildcard is safe without cookies)
- the API is genuinely public read-only and never reads / accepts
  cookies / Authorization headers (defense in depth: still
  recommend a concrete allow-list)
