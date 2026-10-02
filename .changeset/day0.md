---
"openqodex": minor
---

First release of OpenQodex, open source code review that runs inside your coding agent before you push.

- `openqodex review --agent` works out your change, runs the scanners that fit it, and prints a review brief for your agent.
- `openqodex review --finalize` checks the agent's findings without a model and writes the report as Markdown, JSON and SARIF.
- `openqodex scan` runs the scanners only, for git hooks, pre-commit and CI.
- Thirteen built-in scanners, each run only when the change holds a file it reads, and only findings on changed lines kept.
- Scanners download on first use at pinned versions; a slow install finishes in the background and joins the next run.
- Any scanner can be added by its GitHub link in `.openqodex.yaml` and runs only after `openqodex trust` approves it.
- `openqodex init` installs the skill and the push gate into Claude Code, Codex CLI, Cursor and Cline, and `--uninstall` removes them.
- The push gate warns by default and blocks only when `.openqodex.yaml` sets `review.block_on_severity`.
- `openqodex hook install` adds an optional git pre-push hook.
- `openqodex doctor` shows which scanners are ready, and `--install` installs them all.
- `openqodex demo` builds a small repository with planted bugs and scans it.
- `openqodex guide` prints the docs offline.
- A GitHub Action and a pre-commit hook run the scan.
- `--offline` skips osv-scanner and semgrep, the two built-in scanners that go online, and turns scanner downloads off.
