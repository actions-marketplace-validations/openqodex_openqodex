---
name: react-fetch-in-effect-without-abort
description: useEffect fires a fetch but doesn't abort it on cleanup / dep change
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "useEffect\\s*\\([\\s\\S]{0,300}?\\bfetch\\s*\\("
confidence_floor: 0.7
---

A `useEffect` issues a `fetch` (or axios / ky / undici) but doesn't
hand the request an `AbortSignal` whose controller is aborted in the
cleanup. When the component unmounts before the response arrives,
or the deps change and the effect re-runs, the in-flight response
still resolves and calls `setState` on an unmounted component (or
clobbers fresher state with stale data from the previous request).

Flag when the fetch is started inside a `useEffect` and the cleanup
returned from the effect doesn't call `controller.abort()` (or the
fetch isn't passed a `signal` at all).

Suppress when:
- the body uses `react-query` / `swr` / TanStack Query (those
  handle abort + race themselves)
- the cleanup uses an `ignore` boolean flag inside the
  `.then(data => { if (!ignore) setState(data) })` pattern (slightly
  worse than abort but still correct)
- the request is fire-and-forget with no `setState` in the chain
