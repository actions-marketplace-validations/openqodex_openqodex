---
name: path-traversal-in-fs-access
description: File system read / write using a path built from user input
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
  hunk_regex: "(readFile|writeFile|createReadStream|createWriteStream|open\\s*\\(|os\\.path\\.join|filepath\\.Join|File\\.open|fs\\.|\\bFile\\s*\\(|Paths\\.get\\s*\\(|Files\\.(readAllBytes|newInputStream|copy)\\s*\\()"
security: true
confidence_floor: 0.7
---

A filesystem call (`fs.readFile`, `fs.writeFile`, `open`, etc.)
uses a path built by joining a base directory with a value sourced
from request input. `../../../etc/passwd` and absolute-path
substitution bypass the base. Reads leak arbitrary files; writes
let an attacker plant malicious content where the server will
serve / execute it.

Flag when the path argument is a join of:
- a server-controlled prefix (`./uploads/`, `path.join(BASE, ...)`)
- AND a value from `req.body`, `req.query`, `req.params`, form
  upload, parsed JSON, command-line args, or env

Suppress when:
- the user input is run through a sanitizer that strips `..` /
  `/` / null bytes
- the final path is `path.resolve`d and then verified to live
  beneath the base directory (`resolved.startsWith(base + sep)`)
- the input is a whitelisted enum / UUID lookup that the path
  derives from an internal mapping (not used as the filename
  directly)
- the file is served via a CDN / object store with its own access
  control (no FS at all)

In Java and Kotlin the idiom is `new File(base + userInput)` (Kotlin
drops the `new`),
`Paths.get(...)` or `Files.readAllBytes(...)` on a path segment taken
from a request parameter or a multipart upload's filename.
