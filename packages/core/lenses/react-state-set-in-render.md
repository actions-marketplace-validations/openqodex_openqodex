---
name: react-state-set-in-render
description: useState setter called during render body, infinite loop
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "\\bset[A-Z]\\w*\\s*\\("
confidence_floor: 0.75
---

A `useState` setter called from the top-level render body (not inside
an event handler, effect, or callback) triggers a re-render, which
calls the component again, which calls the setter again: an infinite
re-render. React 18+ throws "Too many re-renders" but only at runtime,
and only when the path is actually hit; conditional set-in-render
escapes static analysis.

Flag a `setX(...)` call placed:
- at the top level of a functional component body
- inside an `if` / ternary / short-circuit that has a chance of
  evaluating to true on first render

Suppress when the call is inside:
- a `useEffect` / `useLayoutEffect` body
- a handler returned from JSX (`onClick={() => setX(...)}`)
- a `useState` initial-value function (`useState(() => ...)`)
- the conditional `if (cond) { setX(prev => ...) }` "derive state from
  props" pattern, where `cond` compares the prop to existing state
  and is provably guarded (this is the React-docs-blessed escape
  hatch; raise only if the guard looks broken)
