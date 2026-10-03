---
"openqodex": minor
---

When OpenQodex itself fails, or a scanner fails, it prints the exact text of a GitHub issue and offers two choices: 1 create the issue, 2 ignore. Nothing is sent without that choice. `openqodex report "<what went wrong>"` offers the same for anything else. The issue never holds code, paths, file names or secrets.
