---
name: supabase-comment-on-function-unqualified
description: COMMENT ON FUNCTION uses an unqualified name while the function is created schema-qualified
triggers:
  files:
    - "*.sql"
    - "**/*.sql"
  hunk_regex: 'COMMENT\s+ON\s+FUNCTION'
confidence_floor: 0.75
---

`COMMENT ON FUNCTION <name>(<args>)` resolves `<name>` against the
applying session's `search_path` at migration time. When the function
is created schema-qualified (`CREATE ... FUNCTION public.foo(...)`) but
the comment names it unqualified (`COMMENT ON FUNCTION foo(...)`), the
statement fails with `function ... does not exist` on any session whose
`search_path` doesn't include that schema, and it's inconsistent with
the qualified `CREATE`. A function-body `SET search_path = public,
pg_temp` does NOT help: that governs the function's own runtime, not the
session running the `COMMENT`.

Flag when, in this diff, a `COMMENT ON FUNCTION` names a function
unqualified while the corresponding `CREATE [OR REPLACE] FUNCTION` (in
the same file or the migration it includes) is schema-qualified, OR when
it diverges from the repo's prevailing convention (search sibling
`COMMENT ON FUNCTION` statements; most will use `public.`).

Suppress when:
- the comment is already schema-qualified to match the CREATE,
- the function is genuinely created unqualified and the repo convention
  is unqualified comments throughout,
- the migration explicitly `SET search_path` for the statement scope.

Severity: `minor` (apply-time failure is gated on the runner's
search_path, which in Supabase's standard runner is usually `public`, so
it often won't fire in practice, but it's a real consistency/robustness
defect).
