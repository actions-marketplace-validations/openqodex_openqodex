---
name: eval-on-user-input
description: eval / new Function / vm.runInThisContext over untrusted input, RCE
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "*.java"
    - "*.kt"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.java"
    - "**/*.kt"
  hunk_regex: "\\beval\\s*\\(|new\\s+Function\\s*\\(|vm\\.(runInThisContext|runInNewContext|runInContext)|child_process\\.(exec|execSync)|Runtime\\.getRuntime\\s*\\(\\s*\\)\\.exec|ProcessBuilder\\s*\\(|ScriptEngine\\b"
security: true
confidence_floor: 0.85
---

`eval(input)`, `new Function(input)`, or `vm.runInThisContext(input)`
called with a value derived from user input is server-side remote
code execution. `child_process.exec(input)` (the unsanitized
shell-string form) is the same thing for OS commands. There is no
"weak" version of this finding; if the input traces back to user
control, it is a critical bug.

Flag with high confidence when any of these calls receive a value
sourced from request body / query / path / form / env / file
contents.

Suppress when:
- the argument is a build-time constant
- the argument is derived from a strictly-typed structured input
  (e.g. an integer parsed from `req.params.id`) embedded into a
  fixed template, but recommend the safer alternative anyway
- `child_process.execFile` / `spawn` with an array of args is used
  instead (no shell parsing)
- the input is run through a parser → AST → restricted-evaluator
  (e.g. a sandboxed expression evaluator like `expr-eval`) rather
  than the JS runtime

In Java and Kotlin the equivalents are `Runtime.getRuntime().exec(...)`,
`ProcessBuilder`, and the `ScriptEngine` family evaluating a script
string that came from a request.
