---
name: supabase-single-500-on-no-match
description: Supabase `.single()` on a query that can legitimately return zero rows, throws PGRST116 and bubbles up as a 500
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
  hunk_regex: "\\.single\\(\\)|\\bfrom\\([^)]*\\)\\s*\\.|supabase\\.from"
confidence_floor: 0.8
---

A Supabase query chain ends in `.single()` against a row that may
not exist (lookup by `id` from a request param, `.eq("user_id",
…)` where the caller may pass an unknown id, etc.). `.single()`
throws PostgREST error `PGRST116` ("Cannot coerce the result to
a single JSON object") when the row count is anything other than
exactly 1. In an edge function, that error bubbles into a 500
when the correct response is a 404, and the caller can't distinguish
"the thing you asked for doesn't exist" from "the server broke."

Flag when this diff adds (or modifies into) a Supabase query that:
- ends in `.single()`,
- selects / updates / deletes by an identifier (`eq("id", …)`,
  `eq("user_id", …)`, `match({...})`),
- where the identifier traces back to a request parameter
  (`req.params`, `req.query`, `req.body`, `req.url`, the parsed
  payload of an edge function),
- AND the surrounding code does NOT catch `PGRST116` / does NOT
  check `error.code === "PGRST116"` to map to a 404.

Examples that should fire:
- `await supabase.from("activities").update({...}).eq("id", id).single()`
  with no PGRST116 → 404 handling
- `await supabase.from("users").select("*").eq("email", req.body.email).single()`
- `await supabase.from("teams").delete().eq("id", req.params.teamId).single()`

Suggested fix in the description:
- Swap `.single()` for `.maybeSingle()` (returns `{data: null,
  error: null}` on zero rows) and have the handler return 404
  when `data === null`, OR
- Keep `.single()` and catch `error.code === "PGRST116"`
  explicitly, mapping to a 404 response.

Suppress when:
- the query is filtered by a column with a unique constraint AND
  the caller has already proven the row exists earlier in the
  request (e.g. an auth middleware fetched the user row by id),
- the surrounding code already handles `PGRST116` (look for the
  literal `"PGRST116"` string in the catch or in an
  `error.code ===` check),
- the function uses `.maybeSingle()` instead.

Severity: `major`: a 500 on a missing row is a real user-facing
bug (looks like an outage) and a real auditing problem (alerts
fire on 5xx, not on 404).
