---
name: regexp-from-user-input
description: new RegExp(...) built from user input, ReDoS / injection
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
  hunk_regex: "new\\s+RegExp\\s*\\("
security: true
confidence_floor: 0.7
---

`new RegExp(input)` is called with a value derived from request
input. Two problems:
1. **ReDoS**: a crafted input like `(a+)+$` chained with a long
   string of `a`'s freezes the V8 regex engine, hanging the request
   thread (a single attacker can take down the API with one call).
2. **Regex injection**: the input redefines the search semantics:
   `.*` instead of the literal dot the dev expected.

Flag when the first argument to `new RegExp(...)` is a value
sourced from `req.body|req.query|req.params|form input|env`.

Suppress when:
- the input has been run through `escapeRegExp` (treats it as a
  literal pattern)
- the regex compile is bounded by a length check (`if (input.length
  > 64) return 400`) and a complexity-aware runtime (`re2` library,
  which is linear-time)
- the input is matched against an allow-list before compile
- the regex is for a non-blocking single-shot search against a
  bounded short string (still recommend escapeRegExp, but the DoS
  window is closed)
