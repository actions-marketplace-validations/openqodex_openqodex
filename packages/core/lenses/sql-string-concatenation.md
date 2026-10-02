---
name: sql-string-concatenation
description: SQL built via string concatenation / template-string interpolation of unsanitized input
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
    - "*.cs"
    - "*.php"
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
    - "**/*.cs"
    - "**/*.php"
  hunk_regex: "\\b(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES)\\b|createStatement\\s*\\(|executeQuery\\s*\\(|create(Native)?Query\\s*\\("
security: true
confidence_floor: 0.75
---

A raw SQL string is built by concatenating / interpolating a
variable into the query. If the variable's value traces back to a
user input, request parameter, environment variable, or any
external source, this is SQL injection. The diff often hides this
behind innocuous helpers (`buildWhere(...)`, `paramFilter(...)`).

Flag when:
- `SELECT|INSERT|UPDATE|DELETE|WHERE` literal appears in a string
  built with `+ var`, `${var}`, `format(...)`, `.format(...)`,
  `f"..."`, or `sprintf` against a variable whose provenance is not
  a hardcoded constant
- the variable comes from `req.body|req.query|req.params|args|
  argv|env|input`

Suppress when:
- the query uses parameter placeholders (`$1`, `?`, `:name`) with
  bound values
- the ORM call is the parameterized path (Drizzle's `eq`/`and`,
  Kysely's `.where(col, '=', val)`, Prisma's `where: {col: val}`)
- the interpolated value is an IDENTIFIER (table/column) and the
  identifier is sourced from an allow-list / enum check earlier in
  the function (still raise if you can't see the check)

In Java and Kotlin the idiom is `createStatement()` plus
`executeQuery("... " + value)`, or a JPA `createQuery` /
`createNativeQuery` string glued together, where `prepareStatement`
with bind parameters is the fix.
