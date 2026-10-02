---
name: object-spread-clobber
description: "{ ...existing, ...incoming } overwrites server-controlled fields with user input"
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
  hunk_regex: "\\{\\s*\\.\\.\\."
confidence_floor: 0.7
---

`{ ...existing, ...input }` spreads a user-supplied object over a
server-controlled one. Any field name in `input` that overlaps
`existing` wins, including fields the caller wasn't supposed to
write (`id`, `userId`, `role`, `tier`, `isAdmin`, `createdAt`,
`stripeCustomerId`).

Mass-assignment is the classic Rails / Express / Hono shape:
`db.update({ where, data: { ...req.body } })`.

Flag when:
- the spread merges a request-sourced object into a DB write
  payload / state object
- there's no explicit allow-list pick (`pick(input, [...])` /
  `{ name: input.name, email: input.email }`) before the spread
- the model has any field that an authenticated user shouldn't be
  able to set (role, owner, billing)

Suppress when:
- the spread is preceded by an allow-list pick / Zod parse with a
  strict schema (`schema.parse(input)` rejecting unknown keys)
- the spread is between two server-controlled objects only
- the destination is a transient payload (not persisted), and the
  extra fields are deliberately allowed
