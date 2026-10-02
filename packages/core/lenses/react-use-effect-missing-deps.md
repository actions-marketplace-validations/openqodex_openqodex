---
name: react-use-effect-missing-deps
description: useEffect / useMemo / useCallback with an incomplete dependency array
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "\\b(useEffect|useMemo|useCallback|useLayoutEffect)\\s*\\("
confidence_floor: 0.75
---

A `useEffect` / `useMemo` / `useCallback` hook reads a value from
component scope (state, props, derived variable, function) but omits
it from the dependency array. On re-render the closure captures the
stale value and the effect either runs against outdated data, never
re-runs when it should, or memoizes incorrectly.

Flag when the hook's body references an identifier that is **not** in
its second-argument array and is **not** stable across renders
(`useRef.current`, module-level constant, dispatch from `useReducer`,
setter returned by `useState`).

Suppress when:
- the deps array is omitted entirely (then it runs every render, a
  different bug, but separate finding)
- the referenced identifier is a setter / ref / constant
- a lint comment explicitly disables `react-hooks/exhaustive-deps`
  with a justification on the line above
