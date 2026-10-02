---
name: react-use-effect-missing-cleanup
description: useEffect subscribes / starts a timer / opens a socket without returning a cleanup
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "useEffect\\s*\\([\\s\\S]{0,400}?(addEventListener|setInterval|setTimeout|subscribe|new\\s+WebSocket|new\\s+EventSource|observe\\()"
confidence_floor: 0.7
---

A `useEffect` registers a subscription, timer, observer, or event
listener but never returns a cleanup function. When the component
unmounts (or the effect re-runs because a dep changed) the
side-effect keeps running against a stale component: a memory leak in
the cheap case, double-fire in state-mutating handlers in the bad
case, "can't update unmounted component" warnings either way.

Flag when the effect body contains `addEventListener`, `setInterval`,
`setTimeout`, a `.subscribe(`, `new WebSocket`, `new EventSource`, or
a `MutationObserver` / `IntersectionObserver` / `ResizeObserver`
without a matching `return () => { ... }` that removes / clears /
unsubscribes / disconnects it.

Suppress when the side-effect is intentionally one-shot and the
target lives at most as long as the component (e.g. a `setTimeout`
whose handler navigates away unconditionally).
