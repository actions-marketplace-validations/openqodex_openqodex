---
name: supabase-security-definer-no-search-path
description: A SECURITY DEFINER function omits a pinned SET search_path, allowing search_path hijack / privilege escalation
triggers:
  files:
    - "*.sql"
    - "**/*.sql"
  hunk_regex: 'SECURITY\s+DEFINER'
confidence_floor: 0.7
---

A `SECURITY DEFINER` function runs with the privileges of its owner, not
the caller. If it does not pin its `search_path`, a caller can set their
own `search_path` so that unqualified object references inside the
function resolve to attacker-controlled objects (a shadowing table,
function, or operator) in a schema the caller can write, executed with
the owner's elevated rights. This is the Postgres privilege-escalation
footgun that Supabase's own linter flags as
`function_search_path_mutable`.

Flag a `CREATE [OR REPLACE] FUNCTION ... SECURITY DEFINER` added or
modified in this diff that does NOT include a fixed
`SET search_path = ...` (e.g. `SET search_path = pg_catalog, public` or
`= ''` with fully-qualified references). Also flag when `search_path` is
set to something a caller can still influence.

Suppress when:
- the function pins `SET search_path` to a fixed value, OR
- every object reference in the body is already fully schema-qualified
  AND `search_path` is set, OR
- the function is `SECURITY INVOKER` (the default); invoker functions
  run as the caller, so this escalation doesn't apply.

Severity: `major` (privilege escalation on a definer function).
