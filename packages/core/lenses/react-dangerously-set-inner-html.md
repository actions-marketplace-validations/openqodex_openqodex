---
name: react-dangerously-set-inner-html
description: dangerouslySetInnerHTML fed by untrusted / unsanitized input
triggers:
  files:
    - "*.tsx"
    - "*.jsx"
    - "**/*.tsx"
    - "**/*.jsx"
  hunk_regex: "dangerouslySetInnerHTML"
security: true
confidence_floor: 0.7
---

`dangerouslySetInnerHTML` bypasses React's HTML escaping. Any value
that traces back to user input, a network response, or
markdown/HTML rendered without sanitization is a stored or reflected
XSS sink.

Flag when the `__html` value's provenance is unsanitized: a prop or
state variable that came from `fetch`, `URLSearchParams`, `params`,
form input, comment / post / message content, or any markdown
rendered without an escaping pipeline.

Suppress when:
- the value is run through `DOMPurify.sanitize` /
  `sanitize-html` / equivalent immediately before the assignment
- the value is a literal string from the component itself (build-time
  constant, not user-derived)
- the value is the output of a markdown library configured with
  HTML disabled (`marked` with `sanitize: true`, `remark-html` with
  `sanitize` plugin, `markdown-it` without `html: true`)
