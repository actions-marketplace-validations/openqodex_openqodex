---
name: secrets-logged-in-error-path
description: Error / catch path logs an object that includes secrets, tokens, or request headers
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
  hunk_regex: "catch\\s*\\(|console\\.(log|error|warn)|logger\\.(error|warn|info)|log\\.(error|warn|info)|printStackTrace\\s*\\("
security: true
confidence_floor: 0.7
---

An error / catch handler logs an object that includes credentials,
authorization headers, API keys, request bodies (which may include
passwords), or full HTTP request/response payloads. These show up
in log aggregators (Datadog, Sentry, CloudWatch) where engineers,
support, or third-party integrations can read them: a compliance
issue at minimum, a credential-leak vector at worst.

Flag when a log call inside a catch / error path passes:
- a full `req` / `request` / `ctx.request` object
- a full `error` whose properties include request headers /
  response bodies (look for axios / fetch error shapes: `err.config.headers`,
  `err.response.config.headers`)
- a literal `password` / `token` / `secret` / `api_key` / `apiKey`
  variable
- environment-derived secrets

Suppress when:
- the log payload is the explicit error message string only
- the object is passed through a redaction layer (`pino` with
  `redact`, `winston` with format filter, custom `scrubSecrets`
  helper), visible on the same call or in the logger setup
- the only fields included are explicitly safe ones (status code,
  method, path, user id)

In Java and Kotlin the idiom is `e.printStackTrace()` or
`logger.error(message, e)` where the exception, or an object logged
beside it, carries the request headers, an `Authorization` value or a
provider token.
