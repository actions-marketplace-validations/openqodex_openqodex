---
"openqodex": minor
---

The review brief now carries a code graph of the repo: which functions the change touches, who calls them with the exact call lines, which files import a changed file, and functions the change removed that other code still calls. It covers TypeScript, JavaScript, Python, Go and Ruby, binds a call only when the code proves the target, builds in a few seconds and caches per file under `.openqodex/graph/`. `graph.enabled: false` in the config or `--no-graph` turns it off.
