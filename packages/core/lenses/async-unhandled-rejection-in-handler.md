---
name: async-unhandled-rejection-in-handler
description: Express / Hono / Fastify handler is async but has no try/catch and no errorHandler middleware
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
  hunk_regex: "(app|router|server|fastify)\\.(get|post|put|patch|delete|on)\\s*\\([\\s\\S]{0,200}?\\basync\\b"
confidence_floor: 0.7
---

An HTTP route handler is declared `async` but its body contains an
`await` that can throw, no `try/catch`, and the framework in use is
NOT auto-promoting promise rejections to error middleware. Express 4
silently hangs the request; Express 5 + Hono + Fastify auto-handle,
but a misconfigured app or an older Express still drops these on the
floor: the client sees a request that times out at the LB while
the server logs a `UnhandledPromiseRejectionWarning` somewhere.

Flag when:
- handler is `async (req, res) => { ... await ... }`
- framework is Express 4 (check imports) OR the project has no
  registered error-handling middleware visible

Suppress when:
- the handler is wrapped in an `asyncHandler` / `expressAsyncHandler`
  / `tryCatch` helper that translates rejection → next(err)
- framework is Hono / Fastify / Express 5 with the default error
  surface (rejections become 500s automatically)
- the body has a top-level `try/catch` that ends in `res.status(...)`
- the handler is `next` style with the rejection threaded into
  `.catch(next)`
