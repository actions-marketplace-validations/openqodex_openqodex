---
name: id-enumeration-sequential
description: Sequential / integer IDs used as URL parameters for access-controlled resources
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "*.py"
    - "*.go"
    - "*.rb"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.py"
    - "**/*.go"
    - "**/*.rb"
  hunk_regex: "(req\\.params|c\\.req\\.param|request\\.match_info|path_params).{0,30}(id|uid|user|order|invoice)"
security: true
confidence_floor: 0.7
---

A handler accepts a sequential integer ID from the URL
(`/orders/:id`, `/users/:id`) and looks up the row by primary key
without verifying that the authenticated principal OWNS that row.
This is IDOR (Insecure Direct Object Reference): an attacker just
increments / decrements the ID to enumerate other users' data.

Even when the ID type is opaque (UUID), the missing-authz check is
still a bug; the attacker may have obtained a leaked link.

Flag when:
- the handler resolves a record by `id` from the URL
- the subsequent query has no `where: { ownerId: ctx.user.id }`
  (or equivalent) clause
- there's no permission check / policy call between the lookup and
  the response

Suppress when:
- the row IS scoped to the authenticated user in the query
- a policy / RBAC / row-level-security check runs explicitly
- the resource is public by design (a blog post, a published
  document) and the handler is the public endpoint
