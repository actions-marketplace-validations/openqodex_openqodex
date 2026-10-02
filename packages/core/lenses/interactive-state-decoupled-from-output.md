---
name: interactive-state-decoupled-from-output
description: New user-mutable state is introduced but an output that should depend on it reads a static or duplicate source instead
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
  hunk_regex: "useState|useReducer|writable\\(|ref\\(|reactive\\(|toggle|setSelected|setChecked|setEnabled|setWatched|setFilter"
confidence_floor: 0.72
---

This diff adds a piece of user-mutable state (a `useState` /
`useReducer` / store `writable` / `ref` / a `toggle*` handler that
flips a Set or boolean) AND there is an output in the same component
whose meaning DEPENDS on that state but which is computed from a
different, static, or duplicate source, so toggling the control in
the UI has no effect on the output it appears to govern.

The classic shape: a user can star/unstar, select/deselect, enable/
disable, or filter items, but a derived view (an alert banner, a
count, a summary, a "what matches" list, a submit payload) is built
from a constant default list, an unrelated prop, or a separately
hardcoded copy of the same data, not from the live state the user
just changed. Each line reads correctly on its own; the bug is the
MISSING wire between the state and the consumer.

Flag when, in this diff:
- new interactive state `S` is introduced (and a handler mutates it),
  AND
- there is a rendered output or computed value `O` whose
  semantics clearly should reflect `S` (it is "about" the same thing
  the user is toggling), BUT
- `O` is derived from a static constant, a duplicated literal, or a
  different source, never reading `S`.

Trace it: find every place the new state SHOULD be read (the outputs
that semantically depend on it) and check each actually reads it. An
output that reads a static/duplicate source instead of `S` is the
finding. This also surfaces nearby dead code: a status/variant value
that no branch ever produces, or the same metric rendered from two
different sources that can disagree.

Suppress when:
- the static source is intentional and documented (e.g. the default
  list is the seed and the toggle layers on top, and the output
  correctly merges both),
- the output genuinely should not depend on the state (the
  resemblance is coincidental),
- the state is purely presentational (drives only its own control's
  appearance, like a star's fill) and no other output is expected to
  track it.

Severity: `major` when the decoupling makes a user-facing control a
no-op for the thing it implies it controls (e.g. unwatching a
category in the UI but the alert still fires for it); `minor` for
cosmetic-only mismatches.

Example: a "watched categories" toggle drove only
the star icon while the threshold-breach alert banner was computed
from a separate static `DEFAULT_WATCHES` constant, so starring /
unstarring had no effect on which categories tripped the alert.
