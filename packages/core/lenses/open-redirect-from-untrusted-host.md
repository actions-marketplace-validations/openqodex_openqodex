---
name: open-redirect-from-untrusted-host
description: HTTP redirect using a URL/host taken from query / body without allow-list
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "*.py"
    - "*.go"
    - "*.rb"
    - "*.java"
    - "*.kt"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.py"
    - "**/*.go"
    - "**/*.rb"
    - "**/*.java"
    - "**/*.kt"
  hunk_regex: "redirect\\s*\\(|res\\.redirect\\b|Location:|http\\.Redirect\\b|return\\s+redirect|RedirectView\\b|return\\s+[\"']redirect:"
security: true
confidence_floor: 0.7
---

A redirect target is constructed from request input (`?next=...`,
`?returnTo=...`, form field, JSON body) without validating that the
host belongs to a known allow-list. Phishing attacks chain
`/login?next=https://attacker.example/fake-login` so the trusted
host is the first thing the user sees in the URL bar.

Flag when a `redirect(url)` / `res.redirect(url)` / `Location:`
header is built from a request-derived URL string that isn't
validated against a list of allowed hosts or constrained to a
relative path.

Suppress when:
- the redirect target is constrained to a same-origin pathname
  (starts with `/`, no scheme / host)
- the URL is parsed and checked against an allow-list of hosts
  before redirect
- the value is the OUTPUT of a server-controlled flow (OAuth state
  recovered from session, post-payment URL from a payment provider
  the project controls)

In Java and Kotlin the idiom is `response.sendRedirect(target)`, a
Spring `RedirectView`, or a controller returning the string
`"redirect:"` with a request value appended.
