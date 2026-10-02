---
name: env-vars-read-at-module-top
description: process.env read at module-evaluate time, undefined before loadEnvFile
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
  hunk_regex: "process\\.env\\."
confidence_floor: 0.75
---

A module reads `process.env.X` at module-evaluate time (top-level
`const X = process.env.X` or in a default-export object). ESM
evaluates all imports BEFORE the entry's body, so any env var set
by `dotenv` / `process.loadEnvFile()` / a manual setup at the
entry point is undefined when this module loads.

Symptom: the value is `undefined` in dev despite the variable
existing in `.env`; client init silently uses defaults; integration
breaks in a way that's hard to root-cause from a stack trace.

Flag when a module's top-level body (NOT inside a function) reads
`process.env.X` AND the resulting value is exported / used to
initialize a client / SDK / config object.

Suppress when:
- the read is inside a function the entry point calls AFTER env
  loading (lazy init pattern)
- the module documents that it must be imported AFTER env setup
  with a comment explaining why
- the read is for a build-time constant baked in via the bundler
  (Vite's `import.meta.env`, esbuild's `--define`)
