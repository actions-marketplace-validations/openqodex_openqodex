---
"openqodex": patch
---

A review no longer ends incomplete when the reviewer searches with a brace list of paths, such as `{src/**,scripts/*.mjs}`, that stays inside the change; a list with any path outside still ends it.

A review no longer ends incomplete when the reviewer reads or searches a name with two dots in it, such as Next.js's `app/[...slug]/page.tsx`; a `..` step that climbs out still ends it.

A review no longer ends incomplete when the reviewer reads a file named with `$` or `%`, such as Remix's `app/routes/posts.$slug.tsx`, that exists in the change; a path like `$HOME/.ssh/id_rsa` that names no such file still ends it.

A Grep file filter that Claude Code splits at a space or comma, or one that starts with `!`, now ends the review when any piece of it points outside the change.
