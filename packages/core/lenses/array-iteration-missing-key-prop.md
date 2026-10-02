---
name: array-iteration-missing-key-prop
description: .map() rendering JSX without a stable key prop (or using index as key for mutable lists)
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "\\.map\\s*\\("
confidence_floor: 0.7
---

JSX rendered inside `.map(...)` either has no `key` prop or uses
the array index as a key. Without a stable key React can't reorder
children correctly: form inputs lose their internal state on
re-order, animations replay, and components mounted in the loop
double-fire effects when items shift positions.

Flag when:
- the `.map((item) => <Component .../>)` returns JSX with no `key`
- the `key` is `index` (or any expression that depends only on the
  loop index) AND the underlying list can reorder / insert / remove

Suppress when:
- a stable id field is used (`key={item.id}` / `key={item.uuid}`)
- the list is provably static for the component's lifetime
  (read-only constants, sorted-once display lists)
- the index IS the natural key (immutable, append-only)
- the rendered children are stateless / sideeffect-free and won't
  notice a reorder
