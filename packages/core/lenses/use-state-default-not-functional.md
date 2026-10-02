---
name: use-state-default-not-functional
description: useState initialized with an expensive computation that re-runs every render
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "useState\\s*\\("
confidence_floor: 0.7
---

`useState(expensiveCompute())` invokes `expensiveCompute()` on
EVERY render: React only uses the result on the first render but
the call still happens. For pure functions this is wasted CPU; for
calls with side effects (analytics fire, localStorage read,
expensive parse) it's a real bug.

Flag when `useState(expr)` initializer is:
- a function call that's NOT a cheap literal / variable read
- a `JSON.parse` / `localStorage.getItem` / `sessionStorage.getItem`
  / a sync filesystem call / a heavy array build

Suppress when:
- the initializer is the lazy form `useState(() => expensiveCompute())`
  (React only calls the function on mount)
- the initializer is a literal, a stable variable, or a cheap
  primitive lookup
- the function is memoized externally and cheap on subsequent calls
