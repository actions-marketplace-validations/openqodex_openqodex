---
name: sql-migration-references-later-object
description: A migration references a column/table/function created by a later-timestamped migration (fails on fresh apply)
triggers:
    # Both forms: "**/" compiles to ".*/", which requires a slash before
    # "migrations", so it covers nested dirs (supabase/migrations/...,
    # db/migrations/...) but NOT a root-level migrations/ dir. The bare
    # "migrations/*.sql" pattern catches that case, same dual-pattern
    # convention the *.sql / **/*.sql lenses use.
  files:
    - "migrations/*.sql"
    - "**/migrations/*.sql"
  hunk_regex: '@include|\breferences\b|\balter\s+table\b|\badd\s+column\b|\bcreate\s+(or\s+replace\s+)?(view|function|trigger|policy)\b|\bjoin\b'
confidence_floor: 0.75
---

Migrations apply in timestamp (filename) order. Code that runs fine
against an already-migrated database can still break a fresh apply
(`supabase db reset`, a clean prod deploy, CI) if a migration references
a schema object (a column, table, type, function, policy) that is only
created by a migration with a LATER timestamp. The bug is invisible
locally because the object already exists; it only surfaces on a
from-scratch run.

This is especially easy to introduce with `@include`-style migrations: a
migration that `@include`s a function file inherits every object that
function selects/joins. If that function references a column added in a
later migration, this migration fails first.

Flag when a migration in this diff (or a function/file it `@include`s)
references an object whose creating/altering statement lives in a
migration timestamped AFTER this one. To check: identify the referenced
columns/tables/functions, then search the migrations directory for where
each is created (`ADD COLUMN`, `CREATE TABLE/FUNCTION/TYPE`) and compare
filename timestamps. Use your tools; this needs reading files outside
the diff.

Suppress when:
- every referenced object is created in an earlier or same-timestamp
  migration,
- the object is a Postgres built-in, an extension object, or created
  outside the migrations dir (e.g. a baseline/squash schema that always
  applies first),
- the reference is inside a string/comment, not executed SQL.

Severity: `major`: a deterministic fresh-apply / CI failure, not a
runtime edge case.
