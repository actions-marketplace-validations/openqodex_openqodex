---
"openqodex": minor
---

In user scope, `init` adds rules so Claude Code runs the exact review command lines the skill names (`review --agent`, `review --finalize`, their `--all` and `--offline` forms) and `guide` without asking, so a review can run unattended; any other flag or command still asks. `init --uninstall` removes exactly the rules it added.
The skill `init` writes in project scope keeps the committed `npx -y openqodex@<version>` commands and no longer tells an agent to prefer the launcher.
`init` skips the team review section for a `CLAUDE.md` or `AGENTS.md` the repository's git ignore rules hide, and says why.
`init --uninstall` removes the update state, and `~/.openqodex/config.yaml` when `openqodex update` created it and it is unchanged.
`openqodex update --rollback` turns updates off before anything else and changes nothing when it cannot.
`openqodex --help` now shows four commands; `scan` is part of `review`; the other commands still work.
