---
"openqodex": minor
---

- `openqodex graph` is now a command in the menu. Beside callers, callees, importers, changes, unknowns and explain, it answers what extends a class or overrides a method, how two functions are connected, what a change or one symbol reaches (the walk the review uses), what a file or folder defines, which projects depend on a project, and which import cycles exist. Every answer carries the evidence and level of each item, true counts, and whether it may be short (a floor) and why. `openqodex graph help` lists the questions.
- A question this release cannot answer yet says so and exits 2 instead of answering with an empty list: uses of a symbol as a value or a type, and routes. Tests are named by their file names only and come back as leads, never counted.
- Each question has a 1 second budget and a page of 50 items by default: `--budget-ms`, `--limit`, `--cursor` and `--tokens` change them. A walk stopped by its budget names where it stopped and never counts what lies past it.
- `openqodex mcp` serves the same questions to your coding agent as MCP tools, over stdio only, for the repository it starts in. It holds one build for the whole session, says when files changed since, and moves to a new build with `graph_refresh`. It refuses another repository or a path outside the repository. The Claude Code plugin starts it.
