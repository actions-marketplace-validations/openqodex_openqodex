---
name: react-stale-closure-in-callback
description: Event handler / timer closure captures a stale state value
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "\\b(setTimeout|setInterval|addEventListener|subscribe|on[A-Z]\\w+)\\b"
confidence_floor: 0.75
---

A callback registered inside a render (event listener, `setTimeout`,
`setInterval`, subscription, or memoized handler) reads `useState`
values from the enclosing scope. Once registered, the closure keeps
the **initial** state forever; later re-renders don't refresh it.
The user sees "I clicked the new value but got the old one."

Flag when the callback's body reads a useState variable AND the
callback is registered outside an effect with that variable in its
dependency list.

Suppress when:
- the value is accessed via a `useRef.current` indirection
- the callback is re-registered each render via a `useEffect` with the
  stateful deps listed (so the closure refreshes)
- the value is provably immutable (initialized once, never reset)
