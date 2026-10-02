---
name: upsert-state-column
description: Upsert / on-conflict writes that clobber workflow-state columns
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
    - "*.cs"
    - "*.php"
    - "*.sql"
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
    - "**/*.cs"
    - "**/*.php"
    - "**/*.sql"
  hunk_regex: "\\b(upsert|on[\\s_-]?conflict|onconflict|merge\\s+into)\\b"
confidence_floor: 0.7
---

An upsert / on-conflict insert that writes a literal value to a
state-bearing column (stage, status, state, tier, role, phase, plan)
will overwrite that column on every matching row, including rows that
have already advanced past that state. On CRM, billing, fulfillment,
and auth flows this silently regresses the workflow on the next
webhook or replay.

Flag as a bug **unless** the write is explicitly guarded:

- `ignoreDuplicates: true` / `ON CONFLICT DO NOTHING`
- an `updateColumns` (drizzle / kysely / supabase) or `DO UPDATE SET`
  list that **omits** the state column
- a `WHERE` / `.eq()` predicate on the upsert that constrains by the
  current value of the state column

Confidence rule still applies: if you cannot tell from the diff
whether such a guard exists upstream (helper wrapping the upsert,
trigger on the table, generated-column default), read the surrounding
code before raising. Drop the finding when the guard
is plausible and you can't disprove it.
