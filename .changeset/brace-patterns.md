---
"openqodex": patch
---

A review no longer ends incomplete when the reviewer searches with a brace list of paths, such as `{src/**,scripts/*.mjs}`, that stays inside the change; a list with any path outside still ends it.
