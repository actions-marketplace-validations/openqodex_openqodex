---
name: async-click-double-fire-race
description: Async onClick handler with no in-flight guard / disabled toggle, double-clicks fire duplicate requests
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "*.vue"
    - "*.svelte"
    - "**/*.tsx"
    - "**/*.jsx"
    - "**/*.vue"
    - "**/*.svelte"
  hunk_regex: "onClick=|@click=|on:click=|onPress=|onPointerDown="
confidence_floor: 0.75
---

A button / link / clickable triggers an async operation
(`fetch`, `mutate`, an awaited handler) without any guard against
re-firing while the first request is still in flight. A rapid
second click queues a duplicate request: a duplicate insert, a
double-charge, an interleaved state update where the late response
clobbers the early one. Touchpad users and slow networks hit this
constantly.

Flag when a handler added in this diff:
- is `async` OR returns a Promise / calls `await ...` / calls
  `fetch(...)` / calls a project-specific async helper (mutate,
  a fetch wrapper, etc.),
- AND has no `isLoading` / `inFlight` / `pending` boolean checked
  at the top (early return when true),
- AND has no `disabled={isLoading}` (or equivalent class swap) on
  the bound element,
- AND has no library-level dedup (TanStack Query's `mutate` with
  the same key is OK; React Query's `useMutation` running through
  its own queue is OK; a hand-rolled `setX([...])` is NOT).

Examples that should fire:
- `onClick={async () => { const r = await fetch(...); setState(r); }}`
  with no disabled / loading guard
- an expand/collapse toggle that calls `fetchTeamMembers(id)`
  but doesn't track `loadingTeams.has(id)`
- `<button onClick={async () => { await save(); navigate(...) }}>`
  where save can take seconds

Suppress when:
- the handler is wrapped by `useMutation` / `useAction` /
  `useTransition` / similar library primitive that owns the
  in-flight tracking,
- the bound element has `disabled={isLoading}` /
  `aria-disabled={isLoading}` / a CSS class swap that prevents
  pointer events,
- the handler is genuinely idempotent (PATCH against a known
  resource state, GET-only, etc.); call out the idempotency
  guarantee when you suppress.

Severity: `minor` for read-only / idempotent paths, `major` for
writes / mutations / billable actions (the duplicate insert and
the double-charge cases).
