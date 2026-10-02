---
name: a11y-icon-only-button-no-aria-label
description: Icon-only button / clickable that relies on `title` for description without an aria-label
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "*.vue"
    - "*.svelte"
    - "*.astro"
    - "**/*.tsx"
    - "**/*.jsx"
    - "**/*.vue"
    - "**/*.svelte"
    - "**/*.astro"
  hunk_regex: "<button\\b|<a\\b|role=[\"']button[\"']|onClick=\\{"
confidence_floor: 0.75
---

A clickable element renders only an icon (an `<svg>`, an emoji, a
single character from a font-icon set, an `<img>` whose `alt` is
empty or omitted) and depends on `title` to convey what it does.
`title` is hover-only and is NOT reliably announced by screen
readers, so the control is opaque to assistive-tech users: they
hear "button" with no context.

Flag when an interactive element added in this diff:
- has no readable text node as a child (only `<svg>`, an icon
  component like `<ChevronIcon />`, `<img alt="">`, a single
  glyph, or pure children-of-children that are themselves icons),
- has no `aria-label`, `aria-labelledby`, OR a visually-hidden
  text label (`<span class="sr-only">…</span>`, `<VisuallyHidden>`,
  Tailwind's `sr-only` utility), AND
- the element is `<button>`, `<a>`, `[role="button"]`, or has an
  `onClick`/`onPointerDown`/`onKeyDown` handler.

The `title` attribute alone is NOT a fix; flag those too.

Suppress when:
- the button already has `aria-label`, `aria-labelledby`, or a
  visually-hidden text child (`sr-only`, `visually-hidden`,
  `<VisuallyHidden>`, `screen-reader-text`),
- the icon itself carries a label (`<svg aria-label="…">` or an
  icon component whose own implementation injects an aria-label),
- the project already has a wrapping component like `<IconButton
  label="…" />` that injects the aria-label,
- the element has visible text alongside the icon.

Severity: `minor` by default. Bump to `major` for primary CTAs
(submit / save / delete) where the missing label blocks the user's
intent, not just degrades it.
