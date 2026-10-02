---
name: pii-in-url-or-log
description: PII (email, phone, SSN, full name) in URLs or unredacted log statements
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
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.py"
    - "**/*.go"
    - "**/*.rb"
  hunk_regex: "(email|phone|ssn|password|address|fullName|first_name|last_name|dob|date_of_birth)\\b"
security: true
confidence_floor: 0.7
---

A PII field (email, phone, SSN, full name, address, DOB) is
embedded in a URL query string OR logged unredacted. URL params
land in CDN logs, browser history, referrer headers to third
parties, and analytics services. Logs land in aggregators that
many engineers + vendors can read.

Flag when:
- a PII field is concatenated into a URL string for a redirect /
  fetch / external API
- a log call passes a record / object that contains a PII field
  without going through a redaction layer

Suppress when:
- the PII goes in the request BODY (POST/PUT) rather than the URL
- the log call explicitly uses a redactor / pino's `redact` /
  custom `scrubPii` helper
- the value being logged is an internal ID / hash of the PII, not
  the PII itself
- the URL is internal-only (no proxy / CDN / referrer leak) AND
  there's a documented reason (still recommend moving it to the body)
