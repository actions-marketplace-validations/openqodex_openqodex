---
name: race-check-then-act
description: Check-then-act on a database row without a transaction / unique constraint
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
  hunk_regex: "\\b(findFirst|findOne|findUnique|select|exists|count)\\b.{0,300}\\b(insert|create|update|save|delete)\\b"
confidence_floor: 0.7
---

A handler reads a row to decide whether to insert / update / delete
(check-then-act), but the read and the write are NOT in the same
transaction AND the table has no unique constraint backing the
invariant. Concurrent requests both pass the check and both
proceed: two users get the same username, two orders against the
same inventory unit, two emails for "first signup" bonus.

Flag when:
- a `findOne` / `findFirst` / `count` / `exists` is followed by an
  `insert` / `update` / `delete` keyed on the same predicate
- the two operations are NOT wrapped in a single `transaction(...)`
  / `db.tx(...)`
- the predicate column is NOT a primary key / unique index

Suppress when:
- the operations run inside a single transaction with an explicit
  isolation level that prevents the race (serializable, or
  `SELECT ... FOR UPDATE`)
- the write uses an idempotent shape that survives the race
  (`INSERT ... ON CONFLICT DO NOTHING`, `UPDATE ... WHERE col = old`)
- a unique constraint / partial index on the table guarantees the
  invariant at the DB layer regardless of the app-level check
