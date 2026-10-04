---
"openqodex": minor
---

Codex can now be the reviewer. `openqodex review --reviewer codex` runs the full review with `codex exec` on your Codex login, and `auto` picks Codex when you run the command from Codex or when Codex is the only reviewer installed.
The Codex reviewer reads the copy of the change in a read-only sandbox with no network for its commands. It still loads your global `~/.codex/AGENTS.md`.
Before each Codex review, OpenQodex checks that the sandbox refuses a read outside the copy and a write inside it. If it does not, the review does not start and you get "Full review unavailable" with the fallback.
With Codex, the report says file reads were not recorded, because Codex does not show every command it runs. Changed lines count only when the brief or a correction round put them in front of the reviewer.
Inside Codex's own sandbox, where a second Codex cannot start, `review --reviewer codex` prints "Full review unavailable" and the `review --agent` fallback.
The reviewer brief no longer tells the reviewer which tools it has; it says to inspect the copy with its own tools, edit nothing and run none of the repository's code.
