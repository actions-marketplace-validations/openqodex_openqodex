---
name: async-floating-promise
description: An async function is called without await / .catch, silent rejection
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
  hunk_regex: "\\basync\\b|\\.then\\("
confidence_floor: 0.7
---

An async function is invoked from synchronous code (or from another
async fn) without `await`, without `.then(...).catch(...)`, and
without `void`. The returned promise floats: a rejection becomes an
unhandled rejection (process warning, eventual crash on newer Node
versions, swallowed entirely in browsers) and the caller has no
ordering guarantee with subsequent statements.

Flag a call to an `async fn` (or a fn that demonstrably returns a
promise: `.then` chains, fetch wrappers, db client calls) whose
return value is **discarded**: not assigned, not returned, not
awaited, not chained with `.catch`, and not preceded by the explicit
`void` keyword.

Suppress when:
- the call is intentionally fire-and-forget AND prefixed with `void`
  (the documented "I know" marker)
- the outer scope wraps in `Promise.all([...])` / `Promise.allSettled`
- the call is on a logger / telemetry / metrics method where dropped
  rejections are explicitly acceptable
