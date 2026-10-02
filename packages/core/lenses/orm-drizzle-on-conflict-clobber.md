---
name: orm-drizzle-on-conflict-clobber
description: Drizzle / Kysely onConflictDoUpdate that updates every column, clobbers downstream writes
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
  hunk_regex: "onConflictDoUpdate|onConflict\\s*\\(|insertOrUpdate"
confidence_floor: 0.7
---

A Drizzle `onConflictDoUpdate({ set: { ... } })` (or Kysely
`onConflict(...).doUpdateSet`) with a `set:` block that updates
**every column** the insert tried to write overwrites columns the
caller didn't mean to touch. Webhook replays, idempotent retries,
and "create or update" code paths regress columns that downstream
handlers have already advanced (status, tier, role, lastSeenAt,
updatedAt).

Closely related to the existing `upsert-state-column` lens, but
focused on the Drizzle / Kysely shape where the `set:` block is
copied directly from the insert values without a deliberate column
filter.

Flag when the `set:` block contains the same columns as the insert
AND any of those columns are state-bearing (status, stage, role,
plan, tier, version, updatedAt) or are commonly written by other
code paths (preferences, profile fields).

Suppress when:
- the `set:` block explicitly OMITS state-bearing columns
- the conflict clause uses `target: ...` with `setWhere` /
  `where: ...` that constrains the update to rows in a known state
- `onConflictDoNothing` (no clobber)
- the conflict target is a uniqueness column whose only path to
  conflict is a literal duplicate of the same write (idempotent
  semantic is the actual goal)
