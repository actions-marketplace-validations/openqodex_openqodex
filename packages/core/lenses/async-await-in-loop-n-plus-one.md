---
name: async-await-in-loop-n-plus-one
description: await inside a for / map / forEach, N round-trips per row
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
  hunk_regex: "for\\s*\\(|\\.(forEach|map|reduce)\\s*\\("
confidence_floor: 0.7
---

A `for` loop / `for-of` / `.map(async ...)` / `.forEach(async ...)`
body contains an `await` against a network or database client.
Sequential awaits multiply latency by row count (100 rows × 30ms
= 3s) and turn a list view, batch import, or N-of-M lookup into a
classic N+1.

Flag when:
- the loop iterates over a list of identifiers / records and the
  body awaits a fetch / db query / API call **per iteration**
- the result is collected into an array (a `Promise.all` over the
  iterable would parallelize cleanly)

Suppress when:
- ordering matters AND the next iteration's input depends on the
  previous iteration's result (rate-limited APIs, paged cursors,
  workflows that build on prior steps)
- there's an explicit per-iteration delay / rate-limit
- the loop iterates a known-small fixed set (≤ 3) where
  parallelization wouldn't change anything material
- a `.map(async ...)` is followed by `await Promise.all(...)`;
  that IS the parallel pattern
