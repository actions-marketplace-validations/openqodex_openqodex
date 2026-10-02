---
name: fetch-without-timeout
description: Outbound HTTP request without timeout / abort signal, request thread hang
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
  hunk_regex: "\\bfetch\\s*\\(|axios\\.(get|post|put|patch|delete|request)|got\\(|undici|ky\\(|node-fetch"
security: true
confidence_floor: 0.7
---

A server-side outbound HTTP call (fetch / axios / got / ky / undici)
is made without a timeout or `AbortSignal`. The upstream can take
seconds to minutes to time out at the network layer; meanwhile the
request handler is blocked, downstream callers stack up, and one
slow third party can drag the whole API into cascading latency.

Flag when:
- the call is `fetch(url)` with no `signal:` option
- `axios.get(...)` / `axios.request(...)` with no `timeout:` option
- the call is to a third-party host (not the same service / not
  localhost)

Suppress when:
- `signal: AbortSignal.timeout(N)` is passed
- `timeout: N` is set
- the project-wide HTTP client wrapper applies a default timeout
  (look for the wrapper before raising)
- the call is to a local sidecar / same-pod service where timeouts
  are explicitly managed at the platform layer (rare in app code)
