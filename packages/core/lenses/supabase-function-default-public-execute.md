---
name: supabase-function-default-public-execute
description: A new/replaced Postgres function exposed via PostgREST is left with the default PUBLIC EXECUTE grant
triggers:
  files:
    - "*.sql"
    - "**/*.sql"
  hunk_regex: 'CREATE\s+(OR\s+REPLACE\s+)?FUNCTION'
confidence_floor: 0.7
---

Postgres grants `EXECUTE` to `PUBLIC` by default on every new function.
In Supabase, PostgREST exposes any function in an exposed schema
(usually `public`) as an RPC endpoint (`POST /rest/v1/rpc/<fn>`)
callable by the `anon` and `authenticated` roles. So a `CREATE [OR
REPLACE] FUNCTION public.<fn>` that returns privileged data or performs
a privileged action, with no accompanying grant management, is callable
by anyone holding an anon/JWT key, even if the only intended caller is
an admin-gated Edge Function using `service_role`.

Flag when this diff adds or replaces a function in an exposed schema AND
does NOT also `REVOKE EXECUTE ... FROM PUBLIC` (and grant EXECUTE only
to the intended role, e.g. `service_role` / `authenticated`). The risk
is highest when:
- the name or comment signals admin/internal scope (`admin_*`,
  `internal_*`, "admin-only", "backend"), or
- the body reads instance-wide / cross-tenant tables (users, teams,
  billing, activity, metrics) rather than the caller's own rows.

`SECURITY INVOKER` (the default) reduces but does not remove the risk:
RLS on the base tables only helps if RLS is actually enabled on every
table the function touches, and the RPC endpoint is still reachable.
Treat a missing `REVOKE PUBLIC` on a privileged function as a finding;
recommend `REVOKE EXECUTE ON FUNCTION public.<fn>(...) FROM PUBLIC;`
plus an explicit `GRANT` to the intended role.

Suppress when:
- the diff (or the same migration) already revokes PUBLIC and grants the
  intended role,
- the function returns only public, non-sensitive data and is meant to
  be world-callable,
- the repo has an established global migration / convention that revokes
  PUBLIC EXECUTE on all functions (verify it exists before staying
  silent),
- the change is purely cosmetic (renamed param, comment) on a function
  whose grants were already managed.

Severity: `major` when an admin/privileged function is left
PUBLIC-callable; `minor` for defense-in-depth hardening on a
non-sensitive one.
