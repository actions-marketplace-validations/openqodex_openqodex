---
name: auth-missing-on-state-change-route
description: POST / PUT / PATCH / DELETE route registered without an auth middleware in sight
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
    - "*.java"
    - "*.kt"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.py"
    - "**/*.go"
    - "**/*.rb"
    - "**/*.java"
    - "**/*.kt"
  hunk_regex: "\\.(post|put|patch|delete)\\s*\\(|@(Post|Put|Patch|Delete)\\b|@(post|put|patch|delete)\\b|@app\\.route\\b|@(Post|Put|Patch|Delete)Mapping\\b|@RequestMapping\\b"
security: true
confidence_floor: 0.75
---

A new route handler for a state-changing verb (POST / PUT / PATCH /
DELETE) is registered with no auth middleware chained on the route,
no `@auth` / `requireAuth` decorator, and no `req.user` /
`session.user` guard inside the body. Anyone with the URL can mutate
state. Particularly dangerous when the route is added under an
existing prefix where the dev assumed auth was inherited but the
prefix isn't actually protected.

Flag when the diff adds a state-changing route AND the body doesn't
reference an authenticated principal, AND no auth middleware appears
on the same route registration.

Suppress when:
- the route is explicitly public (signup, login, password-reset
  request, public webhook with HMAC validation)
- a middleware chain on the router/app applies auth globally (look
  for `app.use(authMiddleware)` / `router.use(...)` earlier in the
  file)
- the framework auto-applies auth via a base controller / module
  decorator (read the surrounding file before raising; the auth
  may live one level up)
- the route reads/validates a signed token (webhook with HMAC,
  short-lived signed URL)

In Java and Kotlin the same shape is `@PostMapping` / `@PutMapping` /
`@PatchMapping` / `@DeleteMapping` (or `@RequestMapping` with a method)
on a controller method with no `@PreAuthorize`, no `@Secured`, and no
rule in the security configuration covering the path.
