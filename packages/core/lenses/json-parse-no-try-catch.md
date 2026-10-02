---
name: json-parse-no-try-catch
description: JSON.parse over untrusted input without try/catch, crashes the request
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
  hunk_regex: "JSON\\.parse\\s*\\("
confidence_floor: 0.7
---

`JSON.parse(input)` throws on invalid input. When the input is a
request body, query string, cookie, or external API response, an
attacker can crash the handler by sending non-JSON. In Express 4
this surfaces as a 500 + log spam; in async handlers without an
async error boundary it can become an unhandled rejection.

Flag when `JSON.parse(...)` is called on a value sourced from
`req.body|req.query|req.cookies|req.headers|response|fetch result|
file read|process.argv` and the call is NOT inside a `try { ... }
catch` (or wrapped by a parser like `Zod.safeParse(JSON.parse(...))`
that itself doesn't catch the parse phase).

Suppress when:
- a `try/catch` surrounds the call and returns a sensible response
- the body parser of the framework already runs `JSON.parse` and
  surfaces a typed error (`express.json()`, Hono's `await c.req.json()`
  inside an error-handling app)
- the value is provably valid JSON from a controlled internal
  source (a value the SAME service wrote moments ago and the parse
  is the reverse trip)
