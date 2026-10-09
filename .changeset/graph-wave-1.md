---
"openqodex": minor
---

- Every framework plugin keeps a string from your code by one rule, applied to the whole value it reads: a concatenation whose pieces join into a key, a later piece of a URL that is not part of its path, a request's query, an object's key, a decorator's argument and a lookup on a plain dictionary are not copied into `.openqodex/graph/`. A key-shaped token is now also found after a `_` or `-` inside a longer name, and a redacted token is named by a short hash, so a template or a route named with one still resolves. A string over 512 characters is no longer cut and kept; it is read as a value the graph does not know. A requirements file that includes a URL names it in the gap without its user, password or query.
