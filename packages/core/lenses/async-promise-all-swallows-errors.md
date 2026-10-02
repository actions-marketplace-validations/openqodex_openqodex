---
name: async-promise-all-swallows-errors
description: Promise.all over fire-and-forget side effects loses partial failures
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
  hunk_regex: "Promise\\.all\\s*\\("
confidence_floor: 0.7
---

`Promise.all([...])` rejects on the FIRST rejection and silently
discards the results of every later promise, even ones that
succeeded after rejection. When the array members are independent
side-effects (insert N rows, fire N webhooks, send N emails), the
caller only sees one error but several side-effects may have run
and several may have silently not run. Recovery / retry becomes
impossible because the caller can't tell which ones happened.

Flag a `Promise.all([...])` where each item is an INDEPENDENT
side-effect (call to db/insert, http POST, message publish, file
write) and the caller doesn't:
- use `Promise.allSettled` to inspect each result, OR
- wrap each item in `.catch` to translate rejections into per-item
  status

Suppress when:
- the items are reads (the all-or-nothing semantic matches "I need
  every value to proceed")
- the wrapper IS `Promise.allSettled`
- the items are wrapped individually with `.catch` so the all sees
  only fulfilled promises
