---
name: return-shape-contract-break
description: A function/endpoint that returns a structured object drops or renames a key/column its callers read
triggers:
  files:
    - "*.sql"
    - "**/*.sql"
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
  hunk_regex: "jsonb_build_object|json_build_object|jsonb_agg|json_agg|RETURNS\\s+(jsonb|json|TABLE|record|setof)|return\\s+\\{|res\\.json\\(|c\\.json\\(|\\bNextResponse\\.json\\("
confidence_floor: 0.7
---

A function, RPC, or endpoint that returns a structured payload (a
`jsonb_build_object` / `json_agg` in SQL, a returned object literal,
a `res.json(...)` / `c.json(...)` / `NextResponse.json(...)` body, a
`RETURNS TABLE`/composite shape) has the SET OF KEYS it returns
CHANGED by this diff: a key or column present on the `-` side is gone
or renamed on the `+` side. Removing or renaming a field from a
payload something already consumes is a silent breaking change: every
reader that referenced the old key now gets `undefined` / `NULL`, and
nothing in the producing file errors, so the diff reads clean in
isolation.

This is the highest-recall way to miss a real bug on an otherwise
tidy refactor. The evidence is the SHAPE of the returned document
across the diff, not the logic inside it: compare the keys emitted on
the `-` side against the `+` side, key by key.

Flag when this diff:
- removes a key from a `jsonb_build_object` / object literal /
  response body that the previous version emitted, OR
- renames such a key (old name vanishes, new name appears), OR
- drops a column from a `RETURNS TABLE` / view / `SELECT *`-feeding
  shape,

AND you cannot see, within the diff, that every consumer of the old
key was also removed. Trace the consumer when you can (search for the
key name, the RPC/function name, or the endpoint path); a removed key
that is still read downstream is a `major` breaking change. When the
consumer is out of the diff and you cannot confirm it was updated,
still raise it; default to "this breaks a contract" rather than
assuming the caller was migrated.

A strong corroborating signal: the diff also DELETES a comment or
doc that asserted the contract (e.g. a comment promising keys are
"additive" / "kept for back-compat" / "stable"). When a PR removes
language that promised stability and the code then breaks it, that is
a high-confidence flag; read the removed comments, not just the
removed code.

Suppress when:
- the diff also removes (or the change description states it
  removes) every consumer of the dropped key; a coordinated removal is not a
  break,
- the key is renamed AND the diff updates the readers in the same
  change,
- the payload is brand-new in this change (no prior `-` side), so there
  is no existing contract to break,
- the field is internal/never-serialized (e.g. a temp variable in a
  CTE that was never part of the returned object).

Severity: `major` when a removed/renamed key is consumed by code
outside the diff (real break); `minor` when the consumer is unclear
but the field plausibly mattered.
