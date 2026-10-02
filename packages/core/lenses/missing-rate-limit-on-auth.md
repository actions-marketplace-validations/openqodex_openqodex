---
name: missing-rate-limit-on-auth
description: Login / password-reset / OTP / signup endpoint without rate limiting visible
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
  hunk_regex: "(login|signin|sign-in|signup|register|forgot[-_]?password|reset[-_]?password|verify[-_]?otp|send[-_]?otp|magic[-_]?link)"
security: true
confidence_floor: 0.7
---

A login / signup / password-reset / OTP-verify / magic-link
endpoint is registered without a rate-limit middleware visible.
Without one: credential stuffing trivially scales, password-reset
email pumps spam any address, OTP-verify allows brute force, and
signup bots burn through plan limits.

Flag when:
- the new route handles auth-flow input (password, OTP code, email
  send) and the diff doesn't show a rate-limiter on the route OR
  a `rateLimit` / `limiter.consume` call inside the body

Suppress when:
- a `limiter` / `rateLimit` middleware is chained on the route
- the framework / platform applies per-IP throttling at the edge
  (Vercel, Cloudflare, AWS WAF) and that's documented in the
  repo (CLAUDE.md, README, infra notes)
- the endpoint is a webhook with HMAC signature (different threat
  model: bot calls are rejected by signature check)
- the project explicitly uses a 3rd party (Clerk / Auth0 / WorkOS
  / Supabase Auth) that owns auth flows; the route is a thin
  pass-through and the provider rate-limits
