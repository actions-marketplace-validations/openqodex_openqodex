---
name: url-not-encoded-for-user-id
description: URL string built by concatenating a user-supplied identifier without encodeURIComponent
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
  hunk_regex: "https?://|`/[a-z]|/api/|/users?/|/teams?/|/projects?/|\\?[a-z_]+="
security: true
confidence_floor: 0.8
---

A URL is built by string concatenation or template-string
interpolation of an identifier (uuid, slug, user id, email,
search query, encoded token) without `encodeURIComponent`. When
the substituted value contains a reserved character (`#`, `?`,
`&`, `/`, `=`, `+`, space) the URL silently breaks: the trailing
path becomes a fragment, query params merge into the previous one,
or the slash splits the route. Worst case it's a one-character
SSRF if the substituted value can contain `@` (rewrites the host)
or a `..` segment that escapes the intended subdirectory.

Flag when a URL string in this diff:
- is built with `+ var`, `${var}`, or `concat(var)` where `var` is
  named like an identifier (`id`, `userId`, `slug`, `email`,
  `token`, `name`, `query`, `searchTerm`, `*_id`, `*_uuid`),
- AND the substitution happens in a path segment or query value
  position,
- AND there is no `encodeURIComponent(var)` / `encodeURI(var)` /
  `new URL(...).searchParams.set(...)` / equivalent encode call
  on the way in,
- AND `var` is not a hardcoded constant from earlier in the
  function.

Examples that should fire:
- `` `${baseUrl}/users/${userId}` `` where userId can hold `+`
- `` `https://analytics.example.com/people/${authUserId}` ``
- `fetch("/api/teams/" + slug + "/members")`
- `` `?q=${searchTerm}` ``

Suppress when:
- the substitution is wrapped in `encodeURIComponent(...)`,
- the URL is built with `url.searchParams.set(name, value)`;
  the URLSearchParams encoder handles reserved chars (including
  `/`, `=`, `&`) in the value,
- the value is encoded per-segment first and only then assembled
  into a pathname (e.g. `url.pathname = "/users/" +
  encodeURIComponent(userId)`),
- the substituted value is a literal / module-level constant /
  enum member (compile-time-known safe),
- the substituted value is already known to be opaque-encoded
  upstream (e.g. JWT, base64url); note the encoding source if
  the diff makes that visible.

DO NOT suppress on `new URL(...)` alone. The URL constructor
parses; it does NOT encode reserved characters inside a
pre-assembled path. Likewise `url.pathname = "/users/" + userId`
does NOT encode `/` (or other reserved chars) within the path
segment: if the substituted `userId` contains a `/`, the route
still splits exactly as the lens is meant to catch. The
URL-class suppression only applies when the encoding happens at
the per-segment / per-param boundary, not at pathname assignment
time.

Severity: `minor` for display URLs that just break visually,
`major` when the unencoded value reaches the network layer and
could redirect a request to a different host or path (the `..`
and `@` escape cases).
