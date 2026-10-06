---
"openqodex": patch
---

A review no longer ends incomplete when the reviewer searches with a brace list of paths, such as `{src/**,scripts/*.mjs}`, that stays inside the change; a list with any path outside still ends it.

A review no longer ends incomplete when the reviewer reads or searches a name with two dots in it, such as Next.js's `app/[...slug]/page.tsx`; a `..` step that climbs out still ends it.

A review no longer ends incomplete when the reviewer reads a file named with `$` or `%`, such as Remix's `app/routes/posts.$slug.tsx`, that exists in the change; a path like `$HOME/.ssh/id_rsa` that names no such file still ends it.

The check of what the reviewer read now reads each call as Claude Code does: a Grep file filter split at a space or comma, a filter that starts with `!`, or a path with spaces around it ends the review when any reading points outside the change, and on a disk that keeps case, a folder whose name differs from the change's copy only in case counts as outside.
